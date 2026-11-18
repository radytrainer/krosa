import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SignJWT } from 'jose';
import request from 'supertest';
import { LiveSlots } from '../src/auth/live-slots.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/token.service.js';
import { RedisService } from '../src/infra/redis.service.js';
import {
  api,
  clearRateLimits,
  createTestApp,
  insertSession,
  login,
  resetState,
  seedUser,
  WEB_ORIGIN,
  type LoggedIn,
  type TestContext,
} from './support/test-app.js';
import { testAdminPassword, testPassword, testStudentPassword } from './support/credentials.js';

/**
 * One session per user (Rule A) and the inactivity logout (Rule B): decisions.md SR1-SR5.
 * Saved tokens of an ended session must be refused at once on every route, refresh, heartbeat
 * and the live stream.
 */
const ADMIN = { username: 'admin', password: testAdminPassword() };
const STUDENT = { username: 'GEN26-0001', password: testStudentPassword() };
const OTHER = { username: 'GEN26-0002', password: testStudentPassword() };
const V1 = '/api/v1';
const IDLE_SECONDS = 60;

/** The cookies of a session as the browser saved them, independent of any agent jar. */
interface Saved {
  cookie: string;
  csrf: string;
}
const saved = (s: LoggedIn): Saved => ({
  cookie: ['ssrs_at', 'ssrs_rt', 'ssrs_csrf']
    .map((name) => `${name}=${s.cookies.get(name)!.value}`)
    .join('; '),
  csrf: s.csrf,
});

interface LiveStream {
  status: number;
  body: unknown;
  headers: Headers;
  /** Raw text received so far. */
  text(): string;
  /** Resolves when the stream ends (server closed it). */
  ended: Promise<void>;
  waitFor(fragment: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Waits until a condition holds (slot release after a client disconnect is asynchronous). */
const eventually = async (check: () => Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('Session rules: one session per user, inactivity logout (integration)', () => {
  let ctx: TestContext;
  let base: string;
  const http = () => request(ctx.app.getHttpServer());

  const me = (s: Saved) => http().get(`${V1}/auth/me`).set('Cookie', s.cookie);
  const refresh = (s: Saved) =>
    http()
      .post(`${V1}/auth/refresh`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', s.cookie);
  const heartbeat = (s: Saved) =>
    http()
      .post(`${V1}/auth/heartbeat`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', s.cookie);

  const openLive = async (
    s: Saved,
    options: { csrf?: string | null; headers?: Record<string, string> } = {},
  ): Promise<LiveStream> => {
    const controller = new AbortController();
    const csrf = options.csrf === undefined ? s.csrf : options.csrf;
    const res = await fetch(`${base}${V1}/auth/live`, {
      headers: {
        Cookie: s.cookie,
        ...(csrf === null ? {} : { 'X-CSRF-Token': csrf }),
        ...options.headers,
      },
      signal: controller.signal,
    });
    let text = '';
    const waiters: (() => void)[] = [];
    if (res.status !== 200) {
      return {
        status: res.status,
        body: await res.json(),
        headers: res.headers,
        text: () => '',
        ended: Promise.resolve(),
        waitFor: () => Promise.resolve(),
        close: () => undefined,
      };
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const ended = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          for (const w of waiters.splice(0)) w();
        }
      } catch {
        // Aborted by the test.
      }
      for (const w of waiters.splice(0)) w();
    })();
    const waitFor = async (fragment: string, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!text.includes(fragment)) {
        if (Date.now() > deadline) throw new Error(`live stream: "${fragment}" not received`);
        await Promise.race([
          new Promise<void>((r) => waiters.push(r)),
          new Promise((r) => setTimeout(r, 50)),
        ]);
      }
    };
    return {
      status: res.status,
      body: null,
      headers: res.headers,
      text: () => text,
      ended,
      waitFor,
      close: () => controller.abort(),
    };
  };

  const ageActivity = (userId: string, seconds: number) =>
    ctx.prisma.authSession.updateMany({
      where: { userId },
      data: { lastActivityAt: new Date(Date.now() - seconds * 1000) },
    });

  beforeAll(async () => {
    ctx = await createTestApp({
      env: {
        SESSION_IDLE_TIMEOUT_SECONDS: String(IDLE_SECONDS),
        SESSION_HEARTBEAT_INTERVAL_SECONDS: '15',
        ACCESS_TOKEN_TTL_SECONDS: '60',
      },
    });
    const server = ctx.app.getHttpServer() as unknown as Server;
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetState(ctx);
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
    await seedUser(ctx, { ...OTHER, role: 'STUDENT' });
  });

  describe('Rule A: one session per user', () => {
    it('a second sign-in ends the first everywhere, at once', async () => {
      const first = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(first);
      await me(a).expect(200);
      const second = await login(ctx, STUDENT.username, STUDENT.password);
      const b = saved(second);

      for (const res of [await me(a), await heartbeat(a), await refresh(a)]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('SESSION_REPLACED');
      }
      // A normal student route too.
      const route = await http().get(`${V1}/student/me`).set('Cookie', a.cookie);
      expect(route.status).toBe(401);
      const live = await openLive(a);
      expect(live.status).toBe(401);
      expect((live.body as { error: { code: string } }).error.code).toBe('SESSION_REPLACED');

      await me(b).expect(200);
      const sessions = await ctx.prisma.authSession.findMany({
        where: { userId: first.body.user.id },
        include: { refreshTokens: true },
      });
      const old = sessions.find((s) => s.revokedAt !== null)!;
      expect(old.revokeReason).toBe('SIGNED_IN_ELSEWHERE');
      expect(old.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
      expect(sessions.filter((s) => s.revokedAt === null)).toHaveLength(1);
    });

    it('applies to admins too', async () => {
      const a = saved(await login(ctx, ADMIN.username, ADMIN.password));
      await login(ctx, ADMIN.username, ADMIN.password);
      const res = await http().get(`${V1}/admin/generations`).set('Cookie', a.cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_REPLACED');
    });

    it('audits the replacement once with a count and no tokens', async () => {
      const first = await login(ctx, STUDENT.username, STUDENT.password);
      await login(ctx, STUDENT.username, STUDENT.password);
      const rows = await ctx.prisma.auditLog.findMany({
        where: { action: 'auth.sessions.replaced' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: first.body.user.id,
        entityType: 'user',
        entityId: first.body.user.id,
        metadata: { revokedCount: 1 },
      });
      const text = JSON.stringify(rows[0]);
      for (const name of ['ssrs_at', 'ssrs_rt', 'ssrs_csrf']) {
        expect(text).not.toContain(first.cookies.get(name)!.value);
      }
      // A first sign-in replaces nothing and writes no such row.
      await login(ctx, OTHER.username, OTHER.password);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.sessions.replaced' } })).toBe(
        1,
      );
    });

    it('a failed sign-in (wrong password, locked out) leaves the session alone', async () => {
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await http()
          .post(`${V1}/auth/login`)
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: STUDENT.username, password: 'wrong-password' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(401);
      expect(statuses).toContain(429);
      await me(a).expect(200);
      expect(await ctx.prisma.authSession.count({ where: { revokedAt: { not: null } } })).toBe(0);
    });

    it('concurrent sign-ins of one user leave exactly one active session', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post(`${V1}/auth/login`)
            .set('Origin', WEB_ORIGIN)
            .send({ identifier: STUDENT.username, password: STUDENT.password }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await ctx.prisma.authSession.count({ where: { revokedAt: null } })).toBe(1);
      expect(
        await ctx.prisma.authSession.count({ where: { revokeReason: 'SIGNED_IN_ELSEWHERE' } }),
      ).toBe(3);
    });

    it('a refresh racing a sign-in elsewhere never leaves the old session usable', async () => {
      for (let round = 0; round < 4; round++) {
        await clearRateLimits(ctx);
        const first = await login(ctx, STUDENT.username, STUDENT.password);
        const [refreshed, other] = await Promise.all([
          first.agent
            .post(`${V1}/auth/refresh`)
            .set('Origin', WEB_ORIGIN)
            .set('X-CSRF-Token', first.csrf),
          http()
            .post(`${V1}/auth/login`)
            .set('Origin', WEB_ORIGIN)
            .send({ identifier: STUDENT.username, password: STUDENT.password }),
        ]);
        expect(other.status).toBe(200);
        expect([204, 401]).toContain(refreshed.status);
        // Whatever cookies A ended up with (rotated or not) are refused.
        const after = await first.agent.get(`${V1}/auth/me`);
        expect(after.status).toBe(401);
        expect(after.body.error.code).toBe('SESSION_REPLACED');
        const again = await first.agent
          .post(`${V1}/auth/refresh`)
          .set('Origin', WEB_ORIGIN)
          .set('X-CSRF-Token', first.csrf);
        expect(again.status).toBe(401);
        const otherCookie = other.headers['set-cookie'] as unknown as string[];
        await http()
          .get(`${V1}/auth/me`)
          .set('Cookie', otherCookie.map((c) => c.split(';')[0]).join('; '))
          .expect(200);
        expect(await ctx.prisma.authSession.count({ where: { revokedAt: null } })).toBe(1);
        await resetState(ctx);
        await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      }
    });
  });

  describe('logout and refresh tokens', () => {
    it('logout: saved tokens are refused on every path', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      await s.agent
        .post(`${V1}/auth/logout`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);
      for (const res of [await me(a), await heartbeat(a), await refresh(a)]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('SESSION_REVOKED');
      }
      const live = await openLive(a);
      expect(live.status).toBe(401);
      expect((live.body as { error: { code: string } }).error.code).toBe('SESSION_REVOKED');
    });

    it('a reused refresh token is refused and revokes only its own session', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const before = saved(s);
      const other = saved(await login(ctx, OTHER.username, OTHER.password));
      await refresh(before).expect(204);
      const reused = await refresh(before).expect(401);
      expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      const session = await ctx.prisma.authSession.findFirstOrThrow({
        where: { userId: s.body.user.id },
      });
      expect(session.revokeReason).toBe('REUSE_DETECTED');
      await me(other).expect(200);
    });

    it('a revoked refresh token is refused even if its session looks active', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      await ctx.prisma.refreshToken.updateMany({ data: { revokedAt: new Date() } });
      const res = await refresh(saved(s)).expect(401);
      expect(res.body.error.code).toBe('SESSION_REVOKED');
    });
  });

  describe('Rule B: inactivity logout', () => {
    it('reports the limits on /auth/me', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const res = await me(saved(s)).expect(200);
      expect(res.body.session).toEqual({
        idleTimeoutSeconds: IDLE_SECONDS,
        heartbeatIntervalSeconds: 15,
      });
    });

    it('only the heartbeat counts as activity', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      await ageActivity(s.body.user.id, 30);
      const read = async () =>
        (await ctx.prisma.authSession.findFirstOrThrow({ where: { userId: s.body.user.id } }))
          .lastActivityAt;
      const aged = await read();
      await me(a).expect(200);
      await http().get(`${V1}/student/me`).set('Cookie', a.cookie);
      await refresh(a).expect(204);
      expect((await read()).getTime()).toBe(aged.getTime());
      await heartbeat(a).expect(204);
      expect((await read()).getTime()).toBeGreaterThan(aged.getTime() + 25_000);
    });

    it('needs the CSRF token', async () => {
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      const res = await http()
        .post(`${V1}/auth/heartbeat`)
        .set('Origin', WEB_ORIGIN)
        .set('Cookie', a.cookie);
      expect(res.status).toBe(403);
    });

    it('works while a password change is required', async () => {
      await ctx.prisma.user.updateMany({
        where: { username: STUDENT.username },
        data: { mustChangePassword: true },
      });
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      await heartbeat(a).expect(204);
    });

    it('an idle session ends on every path and a heartbeat does not revive it', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      await ageActivity(s.body.user.id, IDLE_SECONDS + 1);
      const hb = await heartbeat(a);
      expect(hb.status).toBe(401);
      expect(hb.body.error.code).toBe('SESSION_IDLE');
      for (const res of [await me(a), await refresh(a), await heartbeat(a)]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('SESSION_IDLE');
      }
      expect((await openLive(a)).status).toBe(401);
      const row = await ctx.prisma.authSession.findFirstOrThrow({
        where: { userId: s.body.user.id },
        include: { refreshTokens: true },
      });
      expect(row.revokeReason).toBe('IDLE_TIMEOUT');
      expect(row.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
      expect(row.lastActivityAt.getTime()).toBeLessThan(Date.now() - IDLE_SECONDS * 1000);
    });

    it('refresh of an idle session is refused (refresh is not activity)', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      await ageActivity(s.body.user.id, IDLE_SECONDS + 1);
      const res = await refresh(saved(s)).expect(401);
      expect(res.body.error.code).toBe('SESSION_IDLE');
    });
  });

  describe('Redis', () => {
    it('keeps no positive cache, and a revoked session stays refused with Redis down', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      const b = saved(await login(ctx, OTHER.username, OTHER.password));
      await me(a).expect(200);
      expect(await ctx.redis.keys('ssrs:v1:auth:valid:*')).toEqual([]);

      await s.agent
        .post(`${V1}/auth/logout`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);
      await ctx.redis.flushdb();
      const redis = ctx.app.get(RedisService).client;
      vi.spyOn(redis, 'get').mockRejectedValue(new Error('Connection is closed.'));
      expect((await me(a)).status).toBe(401);
      await me(b).expect(200);
    });
  });

  describe('GET /auth/live', () => {
    it('streams ready with SSE headers, then ended with only a reason on sign-in elsewhere', async () => {
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      const live = await openLive(a);
      expect(live.status).toBe(200);
      expect(live.headers.get('content-type')).toContain('text/event-stream');
      expect(live.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(live.headers.get('x-accel-buffering')).toBe('no');
      await live.waitFor('event: ready');

      const second = await login(ctx, STUDENT.username, STUDENT.password);
      await live.waitFor('event: ended');
      await live.ended;
      expect(live.text()).toBe(
        'event: ready\ndata: {}\n\nevent: ended\ndata: {"reason":"SIGNED_IN_ELSEWHERE"}\n\n',
      );
      expect(live.text()).not.toContain(second.body.user.id);
    });

    it('ends with REVOKED on logout and IDLE_TIMEOUT on the backstop re-check', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const live = await openLive(saved(s));
      await live.waitFor('event: ready');
      await s.agent
        .post(`${V1}/auth/logout`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);
      await live.waitFor('{"reason":"REVOKED"}');

      const t = await login(ctx, OTHER.username, OTHER.password);
      const idle = await openLive(saved(t));
      await idle.waitFor('event: ready');
      await ctx.prisma.authSession.updateMany({
        where: { userId: t.body.user.id },
        data: { lastActivityAt: new Date(Date.now() - (IDLE_SECONDS + 1) * 1000) },
      });
      await idle.waitFor('{"reason":"IDLE_TIMEOUT"}', 15_000);
    }, 30_000);

    it("another user's revocation never reaches this stream", async () => {
      const mine = await openLive(saved(await login(ctx, STUDENT.username, STUDENT.password)));
      await mine.waitFor('event: ready');
      const other = await login(ctx, OTHER.username, OTHER.password);
      await login(ctx, OTHER.username, OTHER.password);
      await other.agent
        .post(`${V1}/auth/logout`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', other.csrf);
      await new Promise((r) => setTimeout(r, 500));
      expect(mine.text()).toBe('event: ready\ndata: {}\n\n');
      mine.close();
    });

    it('limits connections per session and releases a slot on close', async () => {
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      const open = [await openLive(a), await openLive(a), await openLive(a)];
      expect(open.map((l) => l.status)).toEqual([200, 200, 200]);
      const extra = await openLive(a);
      expect(extra.status).toBe(429);
      expect((extra.body as { error: { code: string } }).error.code).toBe(
        'TOO_MANY_LIVE_CONNECTIONS',
      );

      open[0]!.close();
      let next: LiveStream | undefined;
      await eventually(async () => {
        next = await openLive(a);
        return next.status === 200;
      });
      next!.close();
      for (const l of open) l.close();
    });

    it('limits connections per user across sessions', async () => {
      const first = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(first);
      const b = saved(await insertSession(ctx, first.body.user.id));
      const open = [
        await openLive(a),
        await openLive(a),
        await openLive(a),
        await openLive(b),
        await openLive(b),
      ];
      expect(open.map((l) => l.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await openLive(b)).status).toBe(429);
      // Closing one frees its slot for the user.
      open[3]!.close();
      let next: LiveStream | undefined;
      await eventually(async () => {
        next = await openLive(b);
        return next.status === 200;
      });
      next!.close();
      for (const l of open) l.close();
    });

    it('counts per process when Redis is unavailable', async () => {
      const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
      const redis = ctx.app.get(RedisService).client;
      vi.spyOn(redis, 'eval').mockRejectedValue(new Error('Connection is closed.'));
      const open = [await openLive(a), await openLive(a), await openLive(a)];
      expect(open.map((l) => l.status)).toEqual([200, 200, 200]);
      expect((await openLive(a)).status).toBe(429);
      open[0]!.close();
      await eventually(async () => {
        const next = await openLive(a);
        next.close();
        return next.status === 200;
      });
      for (const l of open) l.close();
    });

    it('needs the session CSRF token and refuses cross-site requests, before taking a slot', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      const other = saved(await login(ctx, OTHER.username, OTHER.password));
      const refused = [
        await openLive(a, { csrf: null }),
        await openLive(a, { csrf: other.csrf }),
        await openLive(a, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      ];
      for (const r of refused) {
        expect(r.status).toBe(403);
        expect((r.body as { error: { code: string } }).error.code).toBe('CSRF_INVALID');
      }
      const sid = (
        await ctx.prisma.authSession.findFirstOrThrow({ where: { userId: s.body.user.id } })
      ).id;
      expect(await ctx.redis.zcard(`ssrs:v1:auth:live:session:${sid}`)).toBe(0);
      const ok = await openLive(a, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(ok.status).toBe(200);
      ok.close();
    });

    it('a client that leaves while the slot is being taken does not keep it', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const a = saved(s);
      const slots = ctx.app.get(LiveSlots);
      const original = slots.acquire.bind(slots);
      vi.spyOn(slots, 'acquire').mockImplementation(async (...args) => {
        await new Promise((r) => setTimeout(r, 400));
        return original(...args);
      });
      const controller = new AbortController();
      const pending = fetch(`${base}${V1}/auth/live`, {
        headers: { Cookie: a.cookie, 'X-CSRF-Token': a.csrf },
        signal: controller.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await pending;
      const sid = (
        await ctx.prisma.authSession.findFirstOrThrow({ where: { userId: s.body.user.id } })
      ).id;
      await new Promise((r) => setTimeout(r, 600));
      await eventually(
        async () => (await ctx.redis.zcard(`ssrs:v1:auth:live:session:${sid}`)) === 0,
      );
    });

    it('password change, admin reset and disable each end an open stream and its refresh token', async () => {
      // Password change in one session ends the user's other session.
      const first = await login(ctx, STUDENT.username, STUDENT.password);
      const second = saved(await insertSession(ctx, first.body.user.id));
      const live1 = await openLive(second);
      await live1.waitFor('event: ready');
      await api(first)
        .post(`${V1}/auth/change-password`, {
          currentPassword: STUDENT.password,
          newPassword: testPassword('session-rules-new'),
        })
        .expect(204);
      await live1.waitFor('{"reason":"REVOKED"}');
      expect((await refresh(second)).status).toBe(401);

      const admin = api(await login(ctx, ADMIN.username, ADMIN.password));
      const student = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: OTHER.username },
      });

      // Admin reset.
      const r = saved(await login(ctx, OTHER.username, OTHER.password));
      const live2 = await openLive(r);
      await live2.waitFor('event: ready');
      await admin.post(`${V1}/admin/students/${student.id}/reset-password`).expect(200);
      await live2.waitFor('{"reason":"REVOKED"}');
      expect((await refresh(r)).status).toBe(401);

      // Disable (the account is ACTIVE again after the reset; sign in with a fresh session).
      const sessionUser = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: student.userId },
      });
      const d = saved(await insertSession(ctx, sessionUser.id));
      const live3 = await openLive(d);
      await live3.waitFor('event: ready');
      await admin
        .patch(`${V1}/admin/students/${student.id}/status`, { status: 'DISABLED' })
        .expect(200);
      await live3.waitFor('{"reason":"REVOKED"}');
      expect((await refresh(d)).status).toBe(401);
    });

    it('closes without ended when the access token expires', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const sid = (
        await ctx.prisma.authSession.findFirstOrThrow({ where: { userId: s.body.user.id } })
      ).id;
      const short = await new SignJWT({ role: 'STUDENT', sid, mcp: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(s.body.user.id)
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
        .sign(new TextEncoder().encode(ctx.env.JWT_ACCESS_SECRET));
      const live = await openLive({
        cookie: `ssrs_at=${short}; ssrs_csrf=${s.csrf}`,
        csrf: s.csrf,
      });
      expect(live.status).toBe(200);
      await live.ended;
      expect(live.text()).toBe('event: ready\ndata: {}\n\n');
      // The session itself is fine: refresh and reconnect.
      await me(saved(s)).expect(200);
    });

    it('ends a stream on this process even when Redis cannot publish', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const live = await openLive(saved(s));
      await live.waitFor('event: ready');
      const redis = ctx.app.get(RedisService).client;
      vi.spyOn(redis, 'pipeline').mockImplementation(() => {
        throw new Error('Connection is closed.');
      });
      await s.agent
        .post(`${V1}/auth/logout`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);
      await live.waitFor('{"reason":"REVOKED"}', 2000);
    });
  });
});
