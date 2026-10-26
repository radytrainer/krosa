import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_COOKIE, readCookie } from '../cookies.js';
import { IS_PUBLIC } from '../decorators.js';
import { SessionService } from '../session.service.js';
import { TokenService } from '../token.service.js';

/** Global guard #1: authenticates the request from the access-token cookie. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = readCookie(req.cookies, ACCESS_COOKIE);
    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }

    const result = await this.tokens.verifyAccessToken(token);
    if (!result.ok) {
      throw new UnauthorizedException(
        result.reason === 'EXPIRED'
          ? { code: 'ACCESS_TOKEN_EXPIRED', message: 'Access token expired' }
          : { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      );
    }
    if (await this.sessions.isSessionRevoked(result.user.sessionId)) {
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Session is no longer valid',
      });
    }

    req.user = result.user;
    return true;
  }
}
