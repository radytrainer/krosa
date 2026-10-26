import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_ENV, type ApiEnv } from '../../config/env.js';
import { CSRF_HEADER } from '../cookies.js';
import { SKIP_CSRF_TOKEN } from '../decorators.js';
import { TokenService } from '../token.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Returns the request's origin from Origin, falling back to Referer. */
export function requestOrigin(req: Pick<Request, 'headers'>): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return origin;
  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Global guard #2 (docs/security.md §3). For every state-changing request:
 *  1. Origin (or Referer) must equal WEB_ORIGIN or a CORS_ORIGINS entry — also covers login CSRF.
 *  2. Authenticated requests must carry X-CSRF-Token = HMAC(sessionId).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {
    this.allowedOrigins = new Set(
      [env.WEB_ORIGIN, ...env.CORS_ORIGINS].map((o) => new URL(o).origin),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = requestOrigin(req);
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new ForbiddenException({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request rejected',
      });
    }

    const skipToken = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_TOKEN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipToken || !req.user) return true;

    const header = req.headers[CSRF_HEADER];
    const presented = typeof header === 'string' ? header : undefined;
    if (!this.tokens.verifyCsrfToken(req.user.sessionId, presented)) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'Missing or invalid CSRF token',
      });
    }
    return true;
  }
}
