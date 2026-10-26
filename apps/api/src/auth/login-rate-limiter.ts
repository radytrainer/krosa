import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export const LOGIN_LIMITS = {
  perIp: { limit: 10, windowSeconds: 60 },
  perIdentifier: { limit: 5, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const KEY_PREFIX = 'ssrs:v1:rl:';

/**
 * Fixed-window counters in Redis. If Redis is unavailable the limiter fails open: the
 * database-backed account lockout still protects individual accounts.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  async hit(bucket: string, subject: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    // Subjects (identifiers, IPs) are hashed so raw usernames never sit in Redis.
    const digest = createHash('sha256').update(subject).digest('base64url').slice(0, 32);
    const key = `${KEY_PREFIX}${bucket}:${digest}`;
    try {
      const results = await this.redis.client
        .multi()
        .incr(key)
        .expire(key, rule.windowSeconds, 'NX')
        .ttl(key)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? rule.windowSeconds);
      if (count > rule.limit) {
        return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds };
      }
      return { allowed: true };
    } catch (err) {
      this.logger.warn(
        `Rate limiter unavailable (${bucket}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { allowed: true };
    }
  }
}
