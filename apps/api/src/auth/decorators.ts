import {
  createParamDecorator,
  SetMetadata,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { UserRole } from '@ssrs/database';
import type { Request } from 'express';
import type { AuthUser } from './auth.types.js';

export const IS_PUBLIC = 'ssrs:isPublic';
export const ROLES = 'ssrs:roles';
export const ANY_AUTHENTICATED = 'ssrs:anyAuthenticated';
export const ALLOW_PASSWORD_CHANGE_REQUIRED = 'ssrs:allowPasswordChangeRequired';
export const SKIP_CSRF_TOKEN = 'ssrs:skipCsrfToken';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts the route to the given roles. Every non-public route needs this or @Authenticated. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

/** Any authenticated user, regardless of role. */
export const Authenticated = () => SetMetadata(ANY_AUTHENTICATED, true);

/** Reachable while the user still has to change their initial/temporary password. */
export const AllowWhenPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED, true);

/**
 * The handler verifies the CSRF token itself (used where the session comes from the refresh
 * cookie rather than an access token). The Origin check still applies.
 */
export const SkipCsrfToken = () => SetMetadata(SKIP_CSRF_TOKEN, true);

/** Injects the authenticated principal. Never trust identity from request input. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.user)
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Not authenticated' });
    return req.user;
  },
);
