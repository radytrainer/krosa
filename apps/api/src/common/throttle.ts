import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RateLimiter, type RateLimitRule } from '../auth/login-rate-limiter.js';
import { API_ENV, type ApiEnv } from '../config/env.js';
import { RateLimitedException } from './rate-limited.exception.js';

export const THROTTLE = 'ssrs:throttle';
export const SKIP_THROTTLE = 'ssrs:skipThrottle';

export interface ThrottleOptions {
  /** Counter name; routes sharing a bucket share a budget (e.g. all credential issuance). */
  bucket: string;
  perIp?: RateLimitRule;
  perUser?: RateLimitRule;
}

/** Route-specific limits on top of the global per-IP limit (docs/security.md §7). */
export const Throttle = (options: ThrottleOptions) => SetMetadata(THROTTLE, options);

/** Exempts a route from every limit (health probes). */
export const SkipThrottle = () => SetMetadata(SKIP_THROTTLE, true);

function readOptions(reflector: Reflector, context: ExecutionContext) {
  const targets = [context.getHandler(), context.getClass()];
  return {
    skip: reflector.getAllAndOverride<boolean>(SKIP_THROTTLE, targets) ?? false,
    route: reflector.getAllAndOverride<ThrottleOptions | undefined>(THROTTLE, targets),
  };
}

/**
 * Global guard #1, before authentication so anonymous floods are cut off cheaply: the global
 * per-IP budget and any route `perIp` rule. Fails open when Redis is down (see RateLimiter).
 */
@Injectable()
export class IpThrottleGuard implements CanActivate {
  private readonly global: RateLimitRule;

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.global = { limit: env.RATE_LIMIT_PER_MINUTE, windowSeconds: 60 };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { skip, route } = readOptions(this.reflector, context);
    if (skip) return true;
    const ip = context.switchToHttp().getRequest<Request>().ip ?? 'unknown';

    const decisions = await Promise.all([
      this.limiter.hit('global:ip', ip, this.global),
      route?.perIp ? this.limiter.hit(`${route.bucket}:ip`, ip, route.perIp) : null,
    ]);
    for (const d of decisions) {
      if (d && !d.allowed) throw new RateLimitedException(d.retryAfterSeconds);
    }
    return true;
  }
}

/** Runs after authentication: route `perUser` rules, keyed by the signed-in user. */
@Injectable()
export class UserThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { skip, route } = readOptions(this.reflector, context);
    const user = context.switchToHttp().getRequest<Request>().user;
    if (skip || !route?.perUser || !user) return true;
    const d = await this.limiter.hit(`${route.bucket}:user`, user.userId, route.perUser);
    if (!d.allowed) throw new RateLimitedException(d.retryAfterSeconds);
    return true;
  }
}
