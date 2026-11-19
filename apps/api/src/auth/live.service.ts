import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { decodeJwt } from 'jose';
import type { AuthUser } from './auth.types.js';
import { CSRF_HEADER } from './cookies.js';
import { LiveSlots } from './live-slots.js';
import { SessionEvents } from './session-events.js';
import { SessionService, type SessionEndReason } from './session.service.js';
import { TokenService } from './token.service.js';

export const LIVE_PING_INTERVAL_MS = 25_000;
/**
 * Covers lost messages, Redis outages and the idle limit (decisions.md SR4); also renews the
 * connection's slot, so it must stay well under LIVE_SLOT_TTL_MS.
 */
export const LIVE_BACKSTOP_INTERVAL_MS = 10_000;

/** The only reasons a live stream ever reports; no ids or other data. */
export type LiveEndedReason = 'SIGNED_IN_ELSEWHERE' | 'IDLE_TIMEOUT' | 'REVOKED';

export function liveReasonFor(reason: SessionEndReason | string): LiveEndedReason {
  if (reason === 'SIGNED_IN_ELSEWHERE' || reason === 'IDLE_TIMEOUT') return reason;
  return 'REVOKED';
}

/**
 * `GET /auth/live`: a server-sent event stream that tells the browser when its session ends.
 * `ended` is sent on a pub/sub message for this session or when the periodic re-check fails;
 * the stream closes without `ended` when the access token expires (the client refreshes and
 * reconnects).
 */
@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly events: SessionEvents,
    private readonly slots: LiveSlots,
    private readonly tokens: TokenService,
  ) {}

  async open(user: AuthUser, accessToken: string, req: Request, res: Response): Promise<void> {
    // GET is not covered by CsrfGuard; this stream needs the session's token anyway, so a page on
    // another site cannot hold connections (and slots) open with the user's cookies.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'Cross-site request rejected',
      });
    }
    const header = req.headers[CSRF_HEADER];
    if (
      !this.tokens.verifyCsrfToken(user.sessionId, typeof header === 'string' ? header : undefined)
    ) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'Missing or invalid CSRF token',
      });
    }

    // Registered before the slot is taken, so a client that leaves during acquire() frees it.
    let closed = false;
    let close: (ended?: LiveEndedReason) => void = () => {
      closed = true;
    };
    req.on('close', () => close());
    res.on('close', () => close());
    res.on('error', () => close());

    const slot = await this.slots.acquire(user.sessionId, user.userId);
    if (!slot) {
      throw new HttpException(
        { code: 'TOO_MANY_LIVE_CONNECTIONS', message: 'Too many open live connections' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (closed || req.destroyed || res.destroyed) {
      await slot.release();
      return;
    }

    const timers: NodeJS.Timeout[] = [];
    let unlisten: (() => void) | null = null;
    close = (ended?: LiveEndedReason) => {
      if (closed) return;
      closed = true;
      for (const t of timers) clearTimeout(t);
      unlisten?.();
      void slot.release();
      if (ended && res.writable) {
        res.write(`event: ended\ndata: ${JSON.stringify({ reason: ended })}\n\n`);
      }
      if (!res.writableEnded) res.end();
    };
    const renew = () => (closed || !res.writable ? Promise.resolve() : slot.renew());

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');

    unlisten = this.events.listen(
      user.sessionId,
      (reason) => close(liveReasonFor(reason)),
      () => close(),
    );
    const end = (reason?: LiveEndedReason) => close(reason);
    // A revocation between the guard's check and listen() would otherwise wait for the backstop.
    void this.recheck(user, end, renew);

    timers.push(
      setInterval(() => {
        if (!closed && res.writable) res.write(': ping\n\n');
      }, LIVE_PING_INTERVAL_MS),
    );
    timers.push(
      setInterval(() => {
        void this.recheck(user, end, renew);
      }, LIVE_BACKSTOP_INTERVAL_MS),
    );
    const exp = decodeJwt(accessToken).exp;
    if (typeof exp === 'number') {
      timers.push(setTimeout(() => close(), Math.max(0, exp * 1000 - Date.now())));
    }
  }

  private async recheck(
    user: AuthUser,
    close: (ended?: LiveEndedReason) => void,
    renew: () => Promise<void>,
  ): Promise<void> {
    try {
      const check = await this.sessions.checkSession(user.sessionId, user.userId);
      if (!check.ok) return close(liveReasonFor(check.reason));
      await renew();
    } catch (err) {
      // Database unavailable: keep the stream; the next check decides.
      this.logger.warn(`Live re-check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
