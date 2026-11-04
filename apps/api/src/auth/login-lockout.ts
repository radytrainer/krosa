import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';
import { lockedUntilAfterFailure } from './lockout.js';

const KEY_PREFIX = 'ssrs:v1:auth:login:';
/** Failures stop counting a day after the last one. */
const FAILURE_TTL_SECONDS = 24 * 3600;

export type LockState =
  | { state: 'open' }
  | { state: 'locked'; retryAfterSeconds: number }
  /** Redis cannot answer: the caller falls back to the account's lock in PostgreSQL. */
  | { state: 'unavailable' };

const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url').slice(0, 32);

/**
 * Progressive lockout per identifier and client IP. It behaves the same for real and made-up
 * identifiers, so it reveals no accounts, and someone guessing from one address does not lock the
 * student out on another. Raw identifiers and IPs never sit in Redis.
 */
@Injectable()
export class LoginLockout {
  private readonly logger = new Logger(LoginLockout.name);

  constructor(private readonly redis: RedisService) {}

  private keys(identifier: string, ip: string) {
    const id = digest(identifier.toLowerCase());
    const subject = `${id}:${digest(ip)}`;
    return {
      index: `${KEY_PREFIX}index:${id}`,
      lock: `${KEY_PREFIX}lock:${subject}`,
      failures: `${KEY_PREFIX}failures:${subject}`,
    };
  }

  async check(identifier: string, ip: string): Promise<LockState> {
    try {
      const ms = await this.redis.client.pttl(this.keys(identifier, ip).lock);
      return ms > 0
        ? { state: 'locked', retryAfterSeconds: Math.ceil(ms / 1000) }
        : { state: 'open' };
    } catch (err) {
      this.warn(err);
      return { state: 'unavailable' };
    }
  }

  async recordFailure(identifier: string, ip: string, now: Date): Promise<void> {
    const { index, lock, failures } = this.keys(identifier, ip);
    try {
      const results = await this.redis.client
        .multi()
        .incr(failures)
        .expire(failures, FAILURE_TTL_SECONDS)
        .sadd(index, lock, failures)
        .expire(index, FAILURE_TTL_SECONDS)
        .exec();
      const lockedUntil = lockedUntilAfterFailure(Number(results?.[0]?.[1] ?? 0), now);
      if (lockedUntil) {
        await this.redis.client.set(lock, '1', 'PX', lockedUntil.getTime() - now.getTime());
      }
    } catch (err) {
      this.warn(err);
    }
  }

  /** A correct password clears this address only: other addresses may still be guessing. */
  async clear(identifier: string, ip: string): Promise<void> {
    const { lock, failures } = this.keys(identifier, ip);
    await this.redis.client.del(lock, failures).catch((err: unknown) => this.warn(err));
  }

  /** Clears every address, for a password reset or change. */
  async clearAll(identifier: string): Promise<void> {
    const { index } = this.keys(identifier, '');
    try {
      const keys = await this.redis.client.smembers(index);
      await this.redis.client.del(index, ...keys);
    } catch (err) {
      this.warn(err);
    }
  }

  private warn(err: unknown): void {
    this.logger.warn(
      `Login lockout unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
