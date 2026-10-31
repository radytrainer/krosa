/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { SignJWT } from 'jose';
import request from 'supertest';
import { vi } from 'vitest';
import { loadApiEnv } from '../../src/config/env.js';
import { RedisService } from '../../src/infra/redis.service.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../src/auth/token.service.js';
import {
  api,
  clearRateLimits,
  login,
  parseSetCookies,
  resetState,
  seedUser,
  WEB_ORIGIN,
  type TestContext,
} from '../support/test-app.js';
import { createHarness, V1, type Harness } from './support.js';

/** QA suite, area A. */

const STUDENT = { username: 'QA-0001', password: 'Plain-Meadow-Quartz-77' };
const OTHER = { username: 'QA-0002', password: 'Plain-Meadow-Quartz-78' };
const LOGIN = `${V1}/auth/login`;
const SECRET = 'integration-test-secret-integration-test-secret';

function loginRaw(ctx: TestContext, identifier: unknown, password: unknown, ip?: string) {
  const req = request(ctx.app.getHttpServer()).post(LOGIN).set('Origin', WEB_ORIGIN);
  if (ip) req.set('X-Forwarded-For', ip);
  return req.send({ identifier, password });
}

const sessionsOf = (ctx: TestContext, userId: string) =>
  ctx.prisma.authSession.findMany({ where: { userId } });

describe('QA A: authentication and sessions', () => {
  let h: Harness;
  let ctx: TestContext;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.reset());
  afterEach(() => vi.restoreAllMocks());

  const seedStudent = (over = {}) => seedUser(ctx, { ...STUDENT, role: 'STUDENT', ...over });

  it('A-01 unknown user and wrong password give the same status, body and headers', async () => {
    await seedStudent();
    const wrong = await loginRaw(ctx, STUDENT.username, 'not-the-password');
    await clearRateLimits(ctx);
    const unknown = await loginRaw(ctx, 'NOBODY-9999', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const shape = (r: request.Response) => ({
      code: r.body.error.code,
      message: r.body.error.message,
      keys: Object.keys(r.body.error).toSorted(),
    });
    expect(shape(unknown)).toEqual(shape(wrong));
    expect(Object.keys(unknown.headers).toSorted()).toEqual(Object.keys(wrong.headers).toSorted());
  });

  it('A-03 disabled: correct password refused, wrong password generic, session refused', async () => {
    const user = await seedStudent();
    const session = api(await login(ctx, STUDENT.username, STUDENT.password));
    const student = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
    await h.admin
      .patch(`${V1}/admin/students/${student.id}/status`, { status: 'DISABLED' })
      .expect(200);

    const right = await loginRaw(ctx, STUDENT.username, STUDENT.password);
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(right.headers['set-cookie']).toBeUndefined();
    expect((await loginRaw(ctx, STUDENT.username, 'wrong')).status).toBe(401);
    await session.get(`${V1}/student/me`).expect(401);
    await session.post(`${V1}/auth/refresh`).expect(401);
  });

  it('A-04 PENDING accounts and locked hashes cannot sign in', async () => {
    await seedStudent({ status: 'PENDING', passwordHash: '!locked:abc' });
    const res = await loginRaw(ctx, STUDENT.username, '!locked:abc');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    await seedStudent({ username: 'QA-0003', status: 'PENDING' });
    await clearRateLimits(ctx);
    const pending = await loginRaw(ctx, 'QA-0003', STUDENT.password);
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe('ACCOUNT_PENDING');
    expect(pending.headers['set-cookie']).toBeUndefined();
  });

  it('A-05 per-IP limit: 429 with Retry-After on the 11th attempt', async () => {
    await clearRateLimits(ctx); // the admin sign-in in reset() counts against this IP
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await loginRaw(ctx, `NOBODY-${i}`, 'x')).status);
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes[10]).toBe(429);
    const blocked = await loginRaw(ctx, 'NOBODY-99', 'x');
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('A-07 case and whitespace variants share the per-username budget', async () => {
    const variants = ['nobody-1', 'NOBODY-1', ' nobody-1', 'nobody-1 ', 'NoBoDy-1', ' nobody-1'];
    const codes: number[] = [];
    for (const v of variants) codes.push((await loginRaw(ctx, v, 'x')).status);
    expect(codes.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(codes[5]).toBe(429);
  });

  it('A-10 recorded: ACCOUNT_LOCKED exists only for real accounts (account discovery)', async () => {
    await seedStudent();
    for (let i = 0; i < 5; i++) await loginRaw(ctx, STUDENT.username, 'wrong');
    await clearRateLimits(ctx);
    const real = await loginRaw(ctx, STUDENT.username, 'wrong');
    for (let i = 0; i < 5; i++) await loginRaw(ctx, 'NOBODY-2', 'wrong');
    await clearRateLimits(ctx);
    const fake = await loginRaw(ctx, 'NOBODY-2', 'wrong');
    // The brief requires the same response. security.md documents this as an exception.
    expect({ status: fake.status, code: fake.body.error.code }).toEqual({
      status: real.status,
      code: real.body.error.code,
    });
  });

  it('A-11 recorded: five wrong guesses by anyone lock the real student out', async () => {
    await seedStudent();
    for (let i = 0; i < 5; i++) await loginRaw(ctx, STUDENT.username, 'wrong');
    await clearRateLimits(ctx);
    const res = await loginRaw(ctx, STUDENT.username, STUDENT.password);
    // Measured effect, reported as a risk: the correct password is refused during the lock.
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('A-09 lockout resets after a successful sign-in', async () => {
    await seedStudent();
    for (let i = 0; i < 4; i++) await loginRaw(ctx, STUDENT.username, 'wrong');
    await clearRateLimits(ctx);
    await loginRaw(ctx, STUDENT.username, STUDENT.password);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: STUDENT.username } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('A-12 refresh issues new tokens and the old refresh token stops working', async () => {
    await seedStudent();
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const res = await api(s).post(`${V1}/auth/refresh`).expect(204);
    const next = parseSetCookies(res);
    expect(next.get('ssrs_rt')!.value).not.toBe(s.cookies.get('ssrs_rt')!.value);
    // Same claims within one second give the same JWT, so only its presence is checked.
    expect(next.get('ssrs_at')!.value).toBeTruthy();
    await api(s).get(`${V1}/auth/me`).expect(200);
  });

  it('A-13 replaying an old refresh token revokes the whole chain', async () => {
    const user = await seedStudent();
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const old = s.cookies.get('ssrs_rt')!.value;
    const res = await api(s).post(`${V1}/auth/refresh`).expect(204);
    const current = parseSetCookies(res).get('ssrs_rt')!.value;
    const replay = (token: string) =>
      request(ctx.app.getHttpServer())
        .post(`${V1}/auth/refresh`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .set('Cookie', `ssrs_rt=${encodeURIComponent(token)}`);
    const reused = await replay(old);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    // The legitimate newest token is dead too, and so is the access token.
    expect((await replay(current)).status).toBe(401);
    await api(s).get(`${V1}/auth/me`).expect(401);
    const [session] = await sessionsOf(ctx, user.id);
    expect(session!.revokeReason).toBe('REUSE_DETECTED');
  });

  it('A-14 two simultaneous refreshes never leave two valid chains', async () => {
    const user = await seedStudent();
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const results = await Promise.all([1, 2].map(() => api(s).post(`${V1}/auth/refresh`)));
    const ok = results.filter((r) => r.status === 204);
    expect(ok.length).toBeLessThanOrEqual(1);
    const live = await ctx.prisma.refreshToken.count({
      where: { session: { userId: user.id, revokedAt: null }, usedAt: null },
    });
    expect(live).toBeLessThanOrEqual(1);
  });

  it('A-15 logout revokes access and refresh at once', async () => {
    await seedStudent();
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = api(s);
    const before = s.cookies.get('ssrs_at')!.value;
    await a.post(`${V1}/auth/logout`).expect(204);
    await request(ctx.app.getHttpServer())
      .get(`${V1}/auth/me`)
      .set('Cookie', `ssrs_at=${before}`)
      .expect(401);
    const refresh = await request(ctx.app.getHttpServer())
      .post(`${V1}/auth/refresh`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', `ssrs_rt=${encodeURIComponent(s.cookies.get('ssrs_rt')!.value)}`);
    expect(refresh.status).toBe(401);
  });

  it('A-16 logout with only the refresh cookie works', async () => {
    const user = await seedStudent();
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    await request(ctx.app.getHttpServer())
      .post(`${V1}/auth/logout`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', `ssrs_rt=${encodeURIComponent(s.cookies.get('ssrs_rt')!.value)}`)
      .expect(204);
    const [session] = await sessionsOf(ctx, user.id);
    expect(session!.revokedAt).not.toBeNull();
  });

  describe('forced password change', () => {
    const TEMP = 'Temp-Pass-Forced-2026';

    it('A-17 every student and admin route is refused until the password is changed', async () => {
      await seedStudent({ password: TEMP, mustChangePassword: true });
      const s = api(await login(ctx, STUDENT.username, TEMP));
      for (const path of [
        '/student/me',
        '/student/me/results',
        '/student/me/summary',
        '/student/me/courses',
        '/student/me/courses/00000000-0000-7000-8000-000000000000',
      ]) {
        const res = await s.get(`${V1}${path}`);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      expect((await s.get(`${V1}/admin/dashboard`)).status).toBe(403);
      await s.get(`${V1}/auth/me`).expect(200);
    });

    it('A-18 neither refresh nor a new sign-in clears the flag', async () => {
      await seedStudent({ password: TEMP, mustChangePassword: true });
      const session = await login(ctx, STUDENT.username, TEMP);
      await api(session).post(`${V1}/auth/refresh`).expect(204);
      await api(session).get(`${V1}/student/me`).expect(403);
      const again = api(await login(ctx, STUDENT.username, TEMP));
      await again.get(`${V1}/student/me`).expect(403);
    });

    it('A-18b changing the password in one session lets that session through', async () => {
      await seedStudent({ password: TEMP, mustChangePassword: true });
      const session = api(await login(ctx, STUDENT.username, TEMP));
      await session
        .post(`${V1}/auth/change-password`, {
          currentPassword: TEMP,
          newPassword: STUDENT.password,
        })
        .expect(204);
      expect((await session.get(`${V1}/student/me`)).status).not.toBe(403);
    });

    it('A-19 an expired temporary password cannot sign in', async () => {
      await seedStudent({
        password: TEMP,
        mustChangePassword: true,
        passwordExpiresAt: new Date(Date.now() - 1000),
      });
      const res = await loginRaw(ctx, STUDENT.username, TEMP);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
    });

    it('A-19b an expired temporary password cannot be exchanged from an old session', async () => {
      const user = await seedStudent({ password: TEMP, mustChangePassword: true });
      const session = api(await login(ctx, STUDENT.username, TEMP));
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { passwordExpiresAt: new Date(Date.now() - 1000) },
      });
      const res = await session.post(`${V1}/auth/change-password`, {
        currentPassword: TEMP,
        newPassword: 'Another-Long-Phrase-2026',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('admin reset', () => {
    const resetFor = async (userId: string) => {
      const s = await ctx.prisma.student.findUniqueOrThrow({ where: { userId } });
      return h.admin.post(`${V1}/admin/students/${s.id}/reset-password`).expect(200);
    };

    it('A-20 ends the session at once: access token, refresh token, old password', async () => {
      const user = await seedStudent();
      const session = await login(ctx, STUDENT.username, STUDENT.password);
      const s = api(session);
      await s.get(`${V1}/auth/me`).expect(200);
      await resetFor(user.id);
      await s.get(`${V1}/auth/me`).expect(401);
      await s.post(`${V1}/auth/refresh`).expect(401);
      expect((await loginRaw(ctx, STUDENT.username, STUDENT.password)).status).toBe(401);
    });

    it('A-21 reset during a Redis failure: the token is refused once Redis is back', async () => {
      const user = await seedStudent();
      const s = api(await login(ctx, STUDENT.username, STUDENT.password));
      const redis = ctx.app.get(RedisService).client;
      const spy = vi.spyOn(redis, 'pipeline').mockImplementation(() => {
        throw new Error('Connection is closed.');
      });
      await resetFor(user.id);
      spy.mockRestore();
      await s.get(`${V1}/auth/me`).expect(401);
    });

    it('A-22 disable during a Redis failure: the token is refused once Redis is back', async () => {
      const user = await seedStudent();
      const s = api(await login(ctx, STUDENT.username, STUDENT.password));
      const redis = ctx.app.get(RedisService).client;
      const student = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
      const spy = vi.spyOn(redis, 'pipeline').mockImplementation(() => {
        throw new Error('Connection is closed.');
      });
      await h.admin
        .patch(`${V1}/admin/students/${student.id}/status`, { status: 'DISABLED' })
        .expect(200);
      spy.mockRestore();
      await s.get(`${V1}/student/me`).expect(401);
    });

    it('A-22b a Redis restart that loses the denylist does not resurrect a revoked session', async () => {
      const user = await seedStudent();
      const s = api(await login(ctx, STUDENT.username, STUDENT.password));
      await resetFor(user.id);
      await s.get(`${V1}/auth/me`).expect(401);
      await ctx.redis.flushdb();
      await s.get(`${V1}/auth/me`).expect(401);
    });
  });

  describe('cookies', () => {
    it('A-23 local attributes', async () => {
      await seedStudent();
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const at = s.cookies.get('ssrs_at')!.attrs;
      const rt = s.cookies.get('ssrs_rt')!.attrs;
      const csrf = s.cookies.get('ssrs_csrf')!.attrs;
      expect(at).toContain('httponly');
      expect(at).toContain('samesite=lax');
      expect(at).toContain('path=/api');
      expect(rt).toContain('httponly');
      expect(rt).toContain('samesite=strict');
      expect(rt).toContain('path=/api/v1/auth');
      expect(csrf).not.toContain('httponly');
    });

    it('A-24 production refuses http origins, insecure cookies and fixture mode', () => {
      const base = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379/0',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
      };
      expect(() => loadApiEnv({ ...base, WEB_ORIGIN: 'http://school.example' })).toThrow();
      expect(() =>
        loadApiEnv({ ...base, WEB_ORIGIN: 'https://school.example', COOKIE_SECURE: 'false' }),
      ).toThrow();
      expect(() =>
        loadApiEnv({
          ...base,
          WEB_ORIGIN: 'https://school.example',
          SHEETS_TEST_MODE: 'fixtures',
        }),
      ).toThrow();
      expect(loadApiEnv({ ...base, WEB_ORIGIN: 'https://school.example' }).COOKIE_SECURE).toBe(
        true,
      );
    });
  });

  describe('A-27 tampered access tokens', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sign = (claims: object, secret = SECRET, issuer = JWT_ISSUER, audience = JWT_AUDIENCE) =>
      new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret));
    const withToken = (token: string) =>
      request(ctx.app.getHttpServer())
        .get(`${V1}/admin/dashboard`)
        .set('Cookie', `ssrs_at=${token}`);

    it('rejects alg none, a wrong key, wrong issuer and audience, and a changed role', async () => {
      const user = await seedStudent();
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const real = s.cookies.get('ssrs_at')!.value;
      const [header, payload, signature] = real.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
        sub: string;
        sid: string;
      };
      const base = { sub: user.id, sid: claims.sid, role: 'ADMIN', mcp: false };

      const tokens = {
        none: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, role: 'ADMIN' })}.`,
        noneUpper: `${b64({ alg: 'NONE', typ: 'JWT' })}.${b64({ ...claims, role: 'ADMIN' })}.`,
        role: `${header}.${b64({ ...claims, role: 'ADMIN' })}.${signature}`,
        wrongKey: await sign(base, 'a-completely-different-secret-value-000'),
        wrongIssuer: await sign(base, SECRET, 'someone-else'),
        wrongAudience: await sign(base, SECRET, JWT_ISSUER, 'someone-else'),
        garbage: 'garbage',
        empty: '',
      };
      for (const [name, token] of Object.entries(tokens)) {
        expect((await withToken(token)).status, name).toBe(401);
      }
    });

    it('rejects an expired token with ACCESS_TOKEN_EXPIRED', async () => {
      const token = await new SignJWT({ role: 'ADMIN', sid: 'x', mcp: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('x')
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(SECRET));
      const res = await withToken(token);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ACCESS_TOKEN_EXPIRED');
    });
  });

  it('A-28 a session removed from the database no longer authenticates', async () => {
    const user = await seedStudent();
    const s = api(await login(ctx, STUDENT.username, STUDENT.password));
    await ctx.prisma.authSession.deleteMany({ where: { userId: user.id } });
    await s.get(`${V1}/auth/me`).expect(401);
  });

  it('A-29 CSRF: other session token and missing token are refused', async () => {
    await seedStudent();
    await seedUser(ctx, { ...OTHER, role: 'STUDENT' });
    const mine = await login(ctx, STUDENT.username, STUDENT.password);
    const theirs = await login(ctx, OTHER.username, OTHER.password);
    const none = await mine.agent.post(`${V1}/auth/logout`).set('Origin', WEB_ORIGIN);
    expect(none.status).toBe(403);
    const wrong = await mine.agent
      .post(`${V1}/auth/logout`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', theirs.csrf);
    expect(wrong.status).toBe(403);
    await api(mine).get(`${V1}/auth/me`).expect(200);
  });

  it('A-30 change password revokes other sessions and enforces the limit', async () => {
    await seedStudent();
    const a = api(await login(ctx, STUDENT.username, STUDENT.password));
    const b = api(await login(ctx, STUDENT.username, STUDENT.password));
    await a
      .post(`${V1}/auth/change-password`, {
        currentPassword: STUDENT.password,
        newPassword: 'Another-Long-Phrase-2026',
      })
      .expect(204);
    await b.get(`${V1}/auth/me`).expect(401);
    await a.get(`${V1}/auth/me`).expect(200);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await a.post(`${V1}/auth/change-password`, {
            currentPassword: 'wrong',
            newPassword: 'Another-Long-Phrase-2027',
          })
        ).status,
      );
    }
    expect(statuses).toContain(429);
  });

  it('A-31 refresh past the absolute lifetime fails', async () => {
    const user = await seedStudent();
    const s = api(await login(ctx, STUDENT.username, STUDENT.password));
    await ctx.prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await s.post(`${V1}/auth/refresh`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('A-32 disabled then enabled: old sessions stay dead', async () => {
    const user = await seedStudent();
    const s = api(await login(ctx, STUDENT.username, STUDENT.password));
    const student = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
    const url = `${V1}/admin/students/${student.id}/status`;
    await h.admin.patch(url, { status: 'DISABLED' }).expect(200);
    await h.admin.patch(url, { status: 'ACTIVE' }).expect(200);
    await s.get(`${V1}/auth/me`).expect(401);
    await s.post(`${V1}/auth/refresh`).expect(401);
    expect((await loginRaw(ctx, STUDENT.username, STUDENT.password)).status).toBe(200);
  });
});

describe('QA A: timing and Secure cookies', () => {
  it('A-02 unknown user and wrong password take about the same time', async () => {
    const h = await createHarness();
    await h.reset();
    await seedUser(h.ctx, { ...STUDENT, role: 'STUDENT' });
    const sample = async (identifier: string) => {
      await clearRateLimits(h.ctx);
      await h.ctx.prisma.user.updateMany({
        where: { username: STUDENT.username },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
      const t = performance.now();
      await loginRaw(h.ctx, identifier, 'wrong-password-value');
      return performance.now() - t;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 30; i++) {
      known.push(await sample(STUDENT.username));
      unknown.push(await sample('NOBODY-TIMING'));
    }
    const median = (a: number[]) => a.toSorted((x, y) => x - y)[15]!;
    const [k, u] = [median(known), median(unknown)];
    console.log(`[A-02] median known ${k.toFixed(1)} ms, unknown ${u.toFixed(1)} ms`);
    await h.close();
    expect(Math.abs(k - u) / Math.max(k, u)).toBeLessThan(0.25);
  }, 60_000);

  it('A-23b with COOKIE_SECURE on, all three cookies are Secure', async () => {
    const h = await createHarness({ env: { COOKIE_SECURE: 'true' } });
    await resetState(h.ctx);
    await seedUser(h.ctx, { ...STUDENT, role: 'STUDENT' });
    const res = await loginRaw(h.ctx, STUDENT.username, STUDENT.password);
    expect(res.status).toBe(200);
    const cookies = parseSetCookies(res);
    await h.close();
    for (const name of ['ssrs_at', 'ssrs_rt', 'ssrs_csrf']) {
      expect(cookies.get(name)!.attrs, name).toContain('secure');
    }
  }, 30_000);
});

describe('QA A: limits that need a trusted proxy', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { TRUST_PROXY_HOPS: '1' } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.reset());

  it('A-06 per-username limit holds across different client IPs', async () => {
    await seedUser(h.ctx, { ...STUDENT, role: 'STUDENT' });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await loginRaw(h.ctx, 'NOBODY-5', 'wrong', `203.0.113.${i + 1}`)).status);
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(codes[5]).toBe(429);
  });
});

describe('QA A: no trusted proxy', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { TRUST_PROXY_HOPS: '0' } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.reset());

  it('A-08 a spoofed X-Forwarded-For cannot dodge the IP limit', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await loginRaw(h.ctx, `NOBODY-${i}`, 'x', `198.51.100.${i + 1}`)).status);
    }
    expect(codes[10]).toBe(429);
  });
});
