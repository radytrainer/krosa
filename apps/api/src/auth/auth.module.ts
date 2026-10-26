import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IpThrottleGuard, UserThrottleGuard } from '../common/throttle.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './guards/auth.guard.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import { MustChangePasswordGuard } from './guards/must-change-password.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { RateLimiter } from './login-rate-limiter.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * Global guards run in registration order:
 * IpThrottle (before any auth work) → Auth (who) → UserThrottle → Csrf (request integrity) →
 * MustChangePassword → Roles (what).
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    TokenService,
    RateLimiter,
    { provide: APP_GUARD, useClass: IpThrottleGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: UserThrottleGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [PasswordService, SessionService, TokenService, RateLimiter],
})
export class AuthModule {}
