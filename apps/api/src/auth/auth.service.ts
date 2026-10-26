import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { User } from '@ssrs/database';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitedException } from '../common/rate-limited.exception.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { AuthUser } from './auth.types.js';
import type { ChangePasswordDto, LoginDto, MeResponse } from './dto.js';
import { lockedUntilAfterFailure } from './lockout.js';
import { LOGIN_LIMITS, RateLimiter } from './login-rate-limiter.js';
import { checkPasswordPolicy, PASSWORD_POLICY_MESSAGES } from './password-policy.js';
import { PasswordService } from './password.service.js';
import { SessionService, type IssuedSession } from './session.service.js';
import { TokenService } from './token.service.js';

const INVALID_CREDENTIALS = {
  code: 'INVALID_CREDENTIALS',
  message: 'Invalid username/student ID or password',
} as const;

const PASSWORD_CHANGE_LIMIT = { limit: 5, windowSeconds: 60 };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly tokenService: TokenService,
  ) {}

  async login(
    dto: LoginDto,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; me: MeResponse }> {
    const identifier = dto.identifier.trim();
    if (identifier.length === 0) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const [byIp, byId] = await Promise.all([
      this.limiter.hit('login:ip', meta.ip ?? 'unknown', LOGIN_LIMITS.perIp),
      this.limiter.hit('login:id', identifier.toLowerCase(), LOGIN_LIMITS.perIdentifier),
    ]);
    for (const decision of [byIp, byId]) {
      if (!decision.allowed) {
        throw new RateLimitedException(
          decision.retryAfterSeconds,
          'RATE_LIMITED',
          'Too many sign-in attempts. Try again later.',
        );
      }
    }

    // `username` is citext: the lookup is case-insensitive.
    const user = await this.prisma.client.user.findUnique({ where: { username: identifier } });
    if (!user) {
      await this.passwords.verifyDummy(dto.password);
      await this.audit.record({
        action: 'auth.login.failure',
        metadata: { reason: 'UNKNOWN_ACCOUNT' },
        context: meta,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
      throw new RateLimitedException(
        retryAfter,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. The account is temporarily locked.',
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.recordFailedLogin(user, now, meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // The password is correct: status-specific errors no longer help an attacker.
    if (user.status === 'DISABLED') {
      await this.audit.record({
        action: 'auth.login.failure',
        actorUserId: user.id,
        metadata: { reason: 'ACCOUNT_DISABLED' },
        context: meta,
      });
      throw new ForbiddenException({
        code: 'ACCOUNT_DISABLED',
        message: 'This account is disabled',
      });
    }
    if (user.status === 'PENDING') {
      throw new ForbiddenException({
        code: 'ACCOUNT_PENDING',
        message: 'This account has not been activated yet. Contact the administrator.',
      });
    }
    if (user.passwordExpiresAt && user.passwordExpiresAt <= now) {
      await this.audit.record({
        action: 'auth.login.failure',
        actorUserId: user.id,
        metadata: { reason: 'TEMPORARY_PASSWORD_EXPIRED' },
        context: meta,
      });
      throw new ForbiddenException({
        code: 'TEMPORARY_PASSWORD_EXPIRED',
        message: 'Your temporary password has expired. Ask the administrator for a new one.',
      });
    }

    const rehash = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(dto.password)
      : null;

    const session = await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(rehash ? { passwordHash: rehash } : {}),
        },
      });
      const issued = await this.sessions.createSession(user, meta, tx);
      await this.audit.record(
        {
          action: 'auth.login.success',
          actorUserId: user.id,
          entityType: 'session',
          entityId: issued.principal.sessionId,
          metadata: { role: user.role },
          context: meta,
        },
        tx,
      );
      return issued;
    });

    return { session, me: await this.me(user.id) };
  }

  private async recordFailedLogin(user: User, now: Date, meta: RequestMeta): Promise<void> {
    // Atomic increment so concurrent failures are all counted.
    const updated = await this.prisma.client.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const lockedUntil = lockedUntilAfterFailure(updated.failedLoginCount, now);
    if (lockedUntil) {
      await this.prisma.client.user.update({ where: { id: user.id }, data: { lockedUntil } });
    }
    await this.audit.record({
      action: lockedUntil ? 'auth.account.locked' : 'auth.login.failure',
      actorUserId: user.id,
      metadata: {
        reason: 'INVALID_PASSWORD',
        failedLoginCount: updated.failedLoginCount,
        ...(lockedUntil ? { lockedUntil } : {}),
      },
      context: meta,
    });
  }

  async refresh(
    rawToken: string | undefined,
    csrf: string | undefined,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    if (!rawToken) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Session expired',
      });
    }
    const result = await this.sessions.rotate(rawToken, csrf);
    if (result.ok) return result.session;

    if (result.code === 'CSRF_INVALID') {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'Missing or invalid CSRF token',
      });
    }
    if (result.code === 'REFRESH_TOKEN_REUSED') {
      await this.audit.record({
        action: 'auth.refresh.reuse_detected',
        actorUserId: result.userId ?? null,
        entityType: 'session',
        entityId: result.sessionId,
        context: meta,
      });
    }
    throw new UnauthorizedException({ code: result.code, message: 'Session expired' });
  }

  /**
   * Revokes the session identified by the access token or, when that has expired, by the
   * refresh token. Works without a valid access token so users can always sign out; the
   * CSRF token must match the session being ended.
   */
  async logout(
    tokens: { access?: string; refresh?: string; csrf?: string },
    meta: RequestMeta,
  ): Promise<void> {
    let sessionId: string | null = null;
    let userId: string | null = null;
    if (tokens.access) {
      const verified = await this.tokenService.verifyAccessToken(tokens.access);
      if (verified.ok) {
        sessionId = verified.user.sessionId;
        userId = verified.user.userId;
      }
    }
    if (!sessionId && tokens.refresh) {
      sessionId = await this.sessions.sessionIdForRefreshToken(tokens.refresh);
    }
    if (!sessionId) return;
    if (!this.tokenService.verifyCsrfToken(sessionId, tokens.csrf)) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'Missing or invalid CSRF token',
      });
    }

    await this.sessions.revokeSession(sessionId, 'LOGOUT');
    await this.audit.record({
      action: 'auth.logout',
      actorUserId: userId,
      entityType: 'session',
      entityId: sessionId,
      context: meta,
    });
  }

  async changePassword(
    principal: AuthUser,
    dto: ChangePasswordDto,
    meta: RequestMeta,
  ): Promise<User> {
    const limit = await this.limiter.hit('pwchange', principal.userId, PASSWORD_CHANGE_LIMIT);
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds);

    const user = await this.prisma.client.user.findUnique({ where: { id: principal.userId } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });

    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      await this.audit.record({
        action: 'auth.password.change_failed',
        actorUserId: user.id,
        metadata: { reason: 'INVALID_CURRENT_PASSWORD' },
        context: meta,
      });
      throw new BadRequestException({
        code: 'INVALID_CURRENT_PASSWORD',
        message: 'Current password is incorrect',
      });
    }

    const problems = checkPasswordPolicy(dto.newPassword, user.username).map(
      (v) => PASSWORD_POLICY_MESSAGES[v],
    );
    if (dto.newPassword === dto.currentPassword) {
      problems.push('New password must differ from the current password.');
    }
    if (problems.length > 0) {
      throw new UnprocessableEntityException({
        code: 'WEAK_PASSWORD',
        message: 'The new password does not meet the password policy',
        details: problems.map((message) => ({ field: 'newPassword', message })),
      });
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordExpiresAt: null,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', {
        exceptSessionId: principal.sessionId,
        tx,
      });
      await this.audit.record(
        {
          action: 'auth.password.changed',
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          metadata: { wasForced: user.mustChangePassword, otherSessionsRevoked: revoked },
          context: meta,
        },
        tx,
      );
      return updated;
    });
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        username: true,
        displayName: true,
        mustChangePassword: true,
        student: { select: { id: true, studentCode: true, fullName: true } },
      },
    });
    if (!user)
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    return { ...user, student: user.student ?? null };
  }
}
