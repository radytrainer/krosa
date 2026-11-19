import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { API_ENV, type ApiEnv } from '../config/env.js';
import { RedisService } from '../infra/redis.service.js';

const SESSION_KEY = 'ssrs:v1:auth:live:session:';
const USER_KEY = 'ssrs:v1:auth:live:user:';
/** A slot not renewed for this long is free again (a crashed process cannot leak it). */
export const LIVE_SLOT_TTL_MS = 60_000;

/**
 * KEYS[1] session set, KEYS[2] user set; ARGV: now, expiry, member, max session, max user, ttl.
 * Sorted sets scored by expiry: expired members are dropped first, then both limits are checked
 * and the member added to both, atomically.
 */
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
return 1
`;

const expiry = () => Date.now() + LIVE_SLOT_TTL_MS;

export interface LiveSlot {
  /** Extends the slot's expiry; call it more often than LIVE_SLOT_TTL_MS. */
  renew(): Promise<void>;
  /** Frees the slot. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Limits open live connections per session and per user, across API instances (Redis sorted
 * sets). If Redis is unavailable, counts fall back to this process.
 */
@Injectable()
export class LiveSlots {
  private readonly logger = new Logger(LiveSlots.name);
  private readonly local = new Map<string, number>();

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly redis: RedisService,
  ) {}

  async acquire(sessionId: string, userId: string): Promise<LiveSlot | null> {
    const member = randomUUID();
    const sKey = `${SESSION_KEY}${sessionId}`;
    const uKey = `${USER_KEY}${userId}`;
    let acquired: number;
    try {
      acquired = (await this.redis.client.eval(
        ACQUIRE,
        2,
        sKey,
        uKey,
        String(Date.now()),
        String(expiry()),
        member,
        String(this.env.LIVE_MAX_PER_SESSION),
        String(this.env.LIVE_MAX_PER_USER),
        String(LIVE_SLOT_TTL_MS),
      )) as number;
    } catch (err) {
      this.logger.warn(
        `Live slot via Redis failed, counting locally: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.acquireLocal(sKey, uKey);
    }
    if (acquired !== 1) return null;

    let released = false;
    return {
      renew: async () => {
        if (released) return;
        const at = expiry();
        await this.redis.client
          .multi()
          // Without XX: a member that expired (e.g. a long Redis stall) is added back while the
          // connection is still open.
          .zadd(sKey, at, member)
          .zadd(uKey, at, member)
          .pexpire(sKey, LIVE_SLOT_TTL_MS)
          .pexpire(uKey, LIVE_SLOT_TTL_MS)
          .exec()
          .catch(() => undefined);
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.redis.client
          .multi()
          .zrem(sKey, member)
          .zrem(uKey, member)
          .exec()
          .catch(() => undefined); // expires on its own within LIVE_SLOT_TTL_MS
      },
    };
  }

  private acquireLocal(sKey: string, uKey: string): LiveSlot | null {
    const s = this.local.get(sKey) ?? 0;
    const u = this.local.get(uKey) ?? 0;
    if (s >= this.env.LIVE_MAX_PER_SESSION || u >= this.env.LIVE_MAX_PER_USER) return null;
    this.local.set(sKey, s + 1);
    this.local.set(uKey, u + 1);
    let released = false;
    const dec = (key: string) => {
      const n = (this.local.get(key) ?? 1) - 1;
      if (n <= 0) this.local.delete(key);
      else this.local.set(key, n);
    };
    return {
      renew: async () => undefined,
      release: async () => {
        if (released) return;
        released = true;
        dec(sKey);
        dec(uKey);
      },
    };
  }
}
