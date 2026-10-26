import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_PASSWORD_CHANGE_REQUIRED } from '../decorators.js';

/** Global guard #3: users with a pending forced password change may only reach allowed routes. */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.user?.mustChangePassword) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    throw new ForbiddenException({
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'You must change your password before continuing',
    });
  }
}
