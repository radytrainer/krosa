import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, SessionRevokeReason, User } from '@ssrs/database';
import { API_ENV, type ApiEnv } from '../config/env.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisService } from '../infra/redis.service.js';
import type { AuthUser } from './auth.types.js';
import { TokenService } from './token.service.js';

const REVOKED_KEY_PREFIX = 'ssrs:v1:auth:revoked:';

export interface IssuedSession {
  principal: AuthUser;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionExpiresAt: Date;
}

export type RotateResult =
  | { ok: true; session: IssuedSession; userId: string }
  | {
      ok: false;
      code:
        | 'INVALID_REFRESH_TOKEN'
        | 'SESSION_REVOKED'
        | 'SESSION_EXPIRED'
        | 'REFRESH_TOKEN_REUSED'
        | 'ACCOUNT_NOT_ACTIVE'
        | 'CSRF_INVALID';
      userId?: string;
      sessionId?: string;
    };

type Tx = Prisma.TransactionClient;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
  ) {}

  private sessionTtlMs(): number {
    return this.env.SESSION_TTL_HOURS * 3_600_000;
  }

  private principalFor(
    user: Pick<User, 'id' | 'role' | 'mustChangePassword'>,
    sessionId: string,
  ): AuthUser {
    return {
      userId: user.id,
      role: user.role,
      sessionId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  async createSession(
    user: Pick<User, 'id' | 'role' | 'mustChangePassword'>,
    meta: RequestMeta,
    tx: Tx,
  ): Promise<IssuedSession> {
    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + this.sessionTtlMs());
    const session = await tx.authSession.create({
      data: {
        userId: user.id,
        expiresAt: sessionExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    const refreshToken = this.tokens.generateRefreshToken();
    await tx.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        expiresAt: sessionExpiresAt,
      },
    });
    const principal = this.principalFor(user, session.id);
    return {
      principal,
      accessToken: await this.tokens.signAccessToken(principal),
      refreshToken,
      csrfToken: this.tokens.csrfTokenForSession(session.id),
      sessionExpiresAt,
    };
  }

  /**
   * Rotates a refresh token. A token that was already used signals theft: the entire session
   * is revoked (reuse detection). The CSRF token must match the token's session.
   */
  async rotate(rawToken: string, presentedCsrf: string | undefined): Promise<RotateResult> {
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const token = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: true } } },
    });
    if (!token) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };

    const { session } = token;
    const userId = session.userId;
    if (!this.tokens.verifyCsrfToken(session.id, presentedCsrf)) {
      return { ok: false, code: 'CSRF_INVALID', userId, sessionId: session.id };
    }
    if (session.revokedAt)
      return { ok: false, code: 'SESSION_REVOKED', userId, sessionId: session.id };
    if (token.usedAt) {
      await this.revokeSession(session.id, 'REUSE_DETECTED');
      return { ok: false, code: 'REFRESH_TOKEN_REUSED', userId, sessionId: session.id };
    }
    const now = new Date();
    if (token.expiresAt <= now || session.expiresAt <= now) {
      return { ok: false, code: 'SESSION_EXPIRED', userId, sessionId: session.id };
    }
    if (session.user.status !== 'ACTIVE') {
      await this.revokeSession(session.id, 'ACCOUNT_DISABLED');
      return { ok: false, code: 'ACCOUNT_NOT_ACTIVE', userId, sessionId: session.id };
    }

    const newRefresh = this.tokens.generateRefreshToken();
    const rotated = await this.prisma.client.$transaction(async (tx) => {
      // Conditional update makes concurrent use of the same token detectable.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          sessionId: session.id,
          tokenHash: this.tokens.hashRefreshToken(newRefresh),
          expiresAt: session.expiresAt,
        },
      });
      await tx.authSession.update({ where: { id: session.id }, data: { lastUsedAt: now } });
      return true;
    });
    if (!rotated) {
      await this.revokeSession(session.id, 'REUSE_DETECTED');
      return { ok: false, code: 'REFRESH_TOKEN_REUSED', userId, sessionId: session.id };
    }

    const principal = this.principalFor(session.user, session.id);
    return {
      ok: true,
      userId,
      session: {
        principal,
        accessToken: await this.tokens.signAccessToken(principal),
        refreshToken: newRefresh,
        csrfToken: this.tokens.csrfTokenForSession(session.id),
        sessionExpiresAt: session.expiresAt,
      },
    };
  }

  /** Session id that owns a refresh token, if the token exists (used by logout). */
  async sessionIdForRefreshToken(rawToken: string): Promise<string | null> {
    const token = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
      select: { sessionId: true },
    });
    return token?.sessionId ?? null;
  }

  async revokeSession(sessionId: string, reason: SessionRevokeReason, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma.client;
    await db.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    await this.denylist([sessionId]);
  }

  /** Revokes every active session of a user, optionally keeping one (the caller's). */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string; tx?: Tx } = {},
  ): Promise<number> {
    const db = options.tx ?? this.prisma.client;
    const active = await db.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      select: { id: true },
    });
    if (active.length === 0) return 0;
    const ids = active.map((s) => s.id);
    await db.authSession.updateMany({
      where: { id: { in: ids } },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    await this.denylist(ids);
    return ids.length;
  }

  /**
   * Whether an access token's session has been revoked. Redis is the fast path; when it is
   * unavailable the database is consulted (fail closed).
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    try {
      const hit = await this.redis.client.exists(`${REVOKED_KEY_PREFIX}${sessionId}`);
      if (hit === 1) return true;
      return false;
    } catch {
      const session = await this.prisma.client.authSession.findUnique({
        where: { id: sessionId },
        select: { revokedAt: true, expiresAt: true },
      });
      return !session || session.revokedAt !== null || session.expiresAt <= new Date();
    }
  }

  /** Denylist entries only need to outlive the longest-lived access token. */
  private async denylist(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const pipeline = this.redis.client.pipeline();
      for (const id of sessionIds) {
        pipeline.set(
          `${REVOKED_KEY_PREFIX}${id}`,
          '1',
          'EX',
          this.env.ACCESS_TOKEN_TTL_SECONDS + 60,
        );
      }
      await pipeline.exec();
    } catch (err) {
      // Access tokens of these sessions stay valid until expiry (≤ ACCESS_TOKEN_TTL_SECONDS).
      this.logger.error(
        `Failed to denylist ${sessionIds.length} session(s): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
