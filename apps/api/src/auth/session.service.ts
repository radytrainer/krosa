import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Prisma, SessionRevokeReason, User } from '@ssrs/database';
import { API_ENV, type ApiEnv } from '../config/env.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisService } from '../infra/redis.service.js';
import type { AuthUser } from './auth.types.js';
import { SessionEvents } from './session-events.js';
import { TokenService } from './token.service.js';

/** Fast reject only: value = revoke reason. Redis never says "valid" (decisions.md SR3). */
export const REVOKED_KEY_PREFIX = 'ssrs:v1:auth:revoked:';
/** Pub/sub channel: `{ sessionId, reason }` after a revocation commits. */
export const SESSION_ENDED_CHANNEL = 'ssrs:v1:auth:session-ended';

export interface IssuedSession {
  principal: AuthUser;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionExpiresAt: Date;
}

/** Why a session check failed: a revoke reason, or a state that needs no revocation. */
export type SessionEndReason = SessionRevokeReason | 'MISSING' | 'EXPIRED' | 'NOT_ACTIVE';

export type SessionCheck = { ok: true; userId: string } | { ok: false; reason: SessionEndReason };

/** The 401 code for a failed session check (guard, refresh, heartbeat, live). */
export type SessionRejectCode = 'SESSION_REPLACED' | 'SESSION_IDLE' | 'SESSION_REVOKED';

export function rejectCodeFor(
  reason: SessionEndReason | string | null | undefined,
): SessionRejectCode {
  if (reason === 'SIGNED_IN_ELSEWHERE') return 'SESSION_REPLACED';
  if (reason === 'IDLE_TIMEOUT') return 'SESSION_IDLE';
  return 'SESSION_REVOKED';
}

const REJECT_MESSAGES: Record<SessionRejectCode, string> = {
  SESSION_REPLACED: 'This account was signed in on another browser or device',
  SESSION_IDLE: 'Signed out after a period of inactivity',
  SESSION_REVOKED: 'Session is no longer valid',
};

export function sessionRejection(reason: SessionEndReason | string | null | undefined) {
  const code = rejectCodeFor(reason);
  return new UnauthorizedException({ code, message: REJECT_MESSAGES[code] });
}

/** Sessions a revocation ended. Announce them after the transaction commits. */
export interface RevokedSessions {
  sessionIds: string[];
  reason: SessionRevokeReason;
}

export type RotateResult =
  | { ok: true; session: IssuedSession; userId: string }
  | {
      ok: false;
      code:
        | 'INVALID_REFRESH_TOKEN'
        | SessionRejectCode
        | 'SESSION_EXPIRED'
        | 'REFRESH_TOKEN_REUSED'
        | 'ACCOUNT_NOT_ACTIVE'
        | 'CSRF_INVALID';
      userId?: string;
      sessionId?: string;
    };

type Tx = Prisma.TransactionClient;

interface LockedSession {
  id: string;
  user_id: string;
  revoked_at: Date | null;
  revoke_reason: SessionRevokeReason | null;
  expires_at: Date;
  last_activity_at: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly events: SessionEvents,
  ) {}

  private sessionTtlMs(): number {
    return this.env.SESSION_TTL_HOURS * 3_600_000;
  }

  private idleMs(): number {
    return this.env.SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  }

  /** Whether a session with this last activity has passed the idle limit at `now`. */
  isIdle(lastActivityAt: Date, now: Date): boolean {
    return lastActivityAt.getTime() + this.idleMs() <= now.getTime();
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
        lastUsedAt: now,
        lastActivityAt: now,
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
   * Rotates a refresh token. Inside one transaction the session row is locked and everything is
   * checked again (revoked, expired, idle, account status, the token's used/revoked state), so a
   * concurrent login elsewhere or logout either wins before the lock or sees the new token. A
   * token that was already used signals theft: its own session is revoked (reuse detection).
   * Refreshing is not activity: `last_activity_at` stays as it is.
   */
  async rotate(rawToken: string, presentedCsrf: string | undefined): Promise<RotateResult> {
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const found = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, sessionId: true, session: { select: { userId: true } } },
    });
    if (!found) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    const sessionId = found.sessionId;
    const userId = found.session.userId;
    if (!this.tokens.verifyCsrfToken(sessionId, presentedCsrf)) {
      return { ok: false, code: 'CSRF_INVALID', userId, sessionId };
    }

    const newRefresh = this.tokens.generateRefreshToken();
    const fail = (code: Exclude<RotateResult, { ok: true }>['code']) =>
      ({ ok: false, code, userId, sessionId }) as const;

    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<LockedSession[]>`
        SELECT id, user_id, revoked_at, revoke_reason, expires_at, last_activity_at
          FROM auth_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const session = rows[0];
      if (!session) return { result: fail('INVALID_REFRESH_TOKEN') };
      if (session.revoked_at) return { result: fail(rejectCodeFor(session.revoke_reason)) };

      const token = await tx.refreshToken.findUnique({
        where: { id: found.id },
        select: { usedAt: true, revokedAt: true, expiresAt: true },
      });
      if (!token || token.revokedAt) return { result: fail('SESSION_REVOKED') };
      if (token.usedAt) {
        const revoked = await this.revokeInTx(tx, [sessionId], 'REUSE_DETECTED', now);
        return { result: fail('REFRESH_TOKEN_REUSED'), revoked };
      }
      if (token.expiresAt <= now || session.expires_at <= now) {
        return { result: fail('SESSION_EXPIRED') };
      }
      if (this.isIdle(session.last_activity_at, now)) {
        const revoked = await this.revokeInTx(tx, [sessionId], 'IDLE_TIMEOUT', now);
        return { result: fail('SESSION_IDLE'), revoked };
      }
      const user = await tx.user.findUnique({
        where: { id: session.user_id },
        select: { id: true, role: true, mustChangePassword: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE') {
        const revoked = await this.revokeInTx(tx, [sessionId], 'ACCOUNT_DISABLED', now);
        return { result: fail('ACCOUNT_NOT_ACTIVE'), revoked };
      }

      // The row lock serializes refreshes of one session; the condition is a second guard.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: found.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        const revoked = await this.revokeInTx(tx, [sessionId], 'REUSE_DETECTED', now);
        return { result: fail('REFRESH_TOKEN_REUSED'), revoked };
      }
      await tx.refreshToken.create({
        data: {
          sessionId,
          tokenHash: this.tokens.hashRefreshToken(newRefresh),
          expiresAt: session.expires_at,
        },
      });
      await tx.authSession.update({ where: { id: sessionId }, data: { lastUsedAt: now } });
      return { result: null, user, expiresAt: session.expires_at };
    });

    if (outcome.result !== null) {
      if ('revoked' in outcome && outcome.revoked) await this.announce(outcome.revoked);
      return outcome.result;
    }
    const principal = this.principalFor(outcome.user, sessionId);
    return {
      ok: true,
      userId,
      session: {
        principal,
        accessToken: await this.tokens.signAccessToken(principal),
        refreshToken: newRefresh,
        csrfToken: this.tokens.csrfTokenForSession(sessionId),
        sessionExpiresAt: outcome.expiresAt,
      },
    };
  }

  /** Whether `sessionId` is a session of `userId` (a token's sid must belong to its sub). */
  async isOwnedBy(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.prisma.client.authSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    return session?.userId === userId;
  }

  /** Session id that owns a refresh token, if the token exists (used by logout). */
  async sessionIdForRefreshToken(rawToken: string): Promise<string | null> {
    const token = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
      select: { sessionId: true },
    });
    return token?.sessionId ?? null;
  }

  /**
   * The one session check (guard, refresh, heartbeat, live). PostgreSQL decides; a denylist
   * entry in Redis only rejects faster. A session found idle is revoked here (`IDLE_TIMEOUT`).
   * `userId` is the token's subject: a session of another user is treated as missing (and never
   * revoked or touched on that token's behalf).
   */
  async checkSession(sessionId: string, userId: string): Promise<SessionCheck> {
    try {
      const reason = await this.redis.client.get(`${REVOKED_KEY_PREFIX}${sessionId}`);
      if (reason) return { ok: false, reason: toEndReason(reason) };
    } catch {
      // Redis down: PostgreSQL answers.
    }
    const now = new Date();
    const session = await this.prisma.client.authSession.findUnique({
      where: { id: sessionId },
      select: {
        userId: true,
        revokedAt: true,
        revokeReason: true,
        expiresAt: true,
        lastActivityAt: true,
        user: { select: { status: true } },
      },
    });
    if (!session || session.userId !== userId) return { ok: false, reason: 'MISSING' };
    if (session.revokedAt) return { ok: false, reason: session.revokeReason ?? 'ADMIN' };
    if (session.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };
    if (session.user.status !== 'ACTIVE') return { ok: false, reason: 'NOT_ACTIVE' };
    if (this.isIdle(session.lastActivityAt, now)) {
      const revoked = await this.revokeSession(sessionId, 'IDLE_TIMEOUT');
      // Revoked just now by another request: report its reason.
      if (revoked.sessionIds.length === 0) return this.checkSession(sessionId, userId);
      return { ok: false, reason: 'IDLE_TIMEOUT' };
    }
    return { ok: true, userId: session.userId };
  }

  /**
   * Records activity: one conditional update, so a revoked, expired or already idle session is
   * never revived. Throws the matching 401 when nothing was updated.
   */
  async heartbeat(sessionId: string, userId: string): Promise<void> {
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - this.idleMs());
    const updated = await this.prisma.client.$executeRaw`
      UPDATE auth_sessions SET last_activity_at = ${now}
       WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL
         AND last_activity_at > ${idleCutoff} AND expires_at > ${now}`;
    if (updated === 1) return;
    const check = await this.checkSession(sessionId, userId);
    throw sessionRejection(check.ok ? 'MISSING' : check.reason);
  }

  /** Revokes one session (and its refresh tokens). Without `tx` it is announced at once. */
  async revokeSession(
    sessionId: string,
    reason: SessionRevokeReason,
    tx?: Tx,
  ): Promise<RevokedSessions> {
    if (tx) return this.revokeInTx(tx, [sessionId], reason, new Date());
    const revoked = await this.prisma.client.$transaction((t) =>
      this.revokeInTx(t, [sessionId], reason, new Date()),
    );
    await this.announce(revoked);
    return revoked;
  }

  /**
   * Revokes every active session of a user, optionally keeping one (the caller's). With `tx`,
   * the caller announces the result after its transaction commits.
   */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string; tx?: Tx } = {},
  ): Promise<RevokedSessions> {
    const run = async (db: Tx) => {
      const active = await db.authSession.findMany({
        where: {
          userId,
          revokedAt: null,
          ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
        },
        select: { id: true },
      });
      return this.revokeInTx(
        db,
        active.map((s) => s.id),
        reason,
        new Date(),
      );
    };
    if (options.tx) return run(options.tx);
    const revoked = await this.prisma.client.$transaction(run);
    await this.announce(revoked);
    return revoked;
  }

  /** Marks sessions and all their refresh tokens revoked. Returns the ids this call ended. */
  private async revokeInTx(
    tx: Tx,
    sessionIds: string[],
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<RevokedSessions> {
    if (sessionIds.length === 0) return { sessionIds: [], reason };
    const ended = await tx.authSession.updateManyAndReturn({
      where: { id: { in: sessionIds }, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
      select: { id: true },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId: { in: sessionIds }, revokedAt: null },
      data: { revokedAt: now },
    });
    return { sessionIds: ended.map((s) => s.id), reason };
  }

  /**
   * After commit: denylist (fast reject) and publish so open live connections end. Never
   * throws; PostgreSQL already says revoked, and live connections re-check it every few seconds.
   */
  async announce(revoked: RevokedSessions | RevokedSessions[]): Promise<void> {
    const list = (Array.isArray(revoked) ? revoked : [revoked]).filter(
      (r) => r.sessionIds.length > 0,
    );
    if (list.length === 0) return;
    // Streams on this process end even when Redis is unavailable.
    for (const r of list) for (const id of r.sessionIds) this.events.dispatchLocal(id, r.reason);
    try {
      const pipeline = this.redis.client.pipeline();
      for (const r of list) {
        for (const id of r.sessionIds) {
          pipeline.set(
            `${REVOKED_KEY_PREFIX}${id}`,
            r.reason,
            'EX',
            this.env.ACCESS_TOKEN_TTL_SECONDS + 60,
          );
          pipeline.publish(
            SESSION_ENDED_CHANNEL,
            JSON.stringify({ sessionId: id, reason: r.reason }),
          );
        }
      }
      await pipeline.exec();
    } catch (err) {
      const count = list.reduce((n, r) => n + r.sessionIds.length, 0);
      this.logger.error(
        `Failed to denylist/publish ${count} session(s): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const REVOKE_REASONS: ReadonlySet<string> = new Set<SessionRevokeReason>([
  'LOGOUT',
  'REUSE_DETECTED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'ACCOUNT_DISABLED',
  'ADMIN',
  'ACCOUNT_DELETED',
  'SIGNED_IN_ELSEWHERE',
  'IDLE_TIMEOUT',
]);

/** Denylist values: a revoke reason, or '1' from older writers. */
export function toEndReason(value: string): SessionEndReason {
  return REVOKE_REASONS.has(value) ? (value as SessionRevokeReason) : 'ADMIN';
}
