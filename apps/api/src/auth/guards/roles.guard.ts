import {
  ForbiddenException,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@ssrs/database';
import type { Request } from 'express';
import { ANY_AUTHENTICATED, IS_PUBLIC, ROLES } from '../decorators.js';

/**
 * Global guard #4: role-based access, deny by default. A non-public route without @Roles or
 * @Authenticated is a configuration error and is refused rather than silently opened.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Access denied' });

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && roles.length > 0) {
      if (roles.includes(user.role)) return true;
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets)) return true;

    this.logger.error(`Route ${req.method} ${req.path} has no access policy; request denied`);
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Access denied' });
  }
}
