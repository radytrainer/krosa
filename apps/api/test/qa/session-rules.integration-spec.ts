/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SignJWT } from 'jose';
import request from 'supertest';
import { vi } from 'vitest';
import { RedisService } from '../../src/infra/redis.service.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../src/auth/token.service.js';
import {
  clearRateLimits,
  createTestApp,
  insertSession,
  login,
  resetState,
  seedUser,
  WEB_ORIGIN,
  type LoggedIn,
  type TestContext,
} from '../support/test-app.js';
import { testAdminPassword, testPassword, testStudentPassword } from '../support/credentials.js';

/**
 * QA area S: session rules (Rule A one session per user, Rule B inactivity logout), checked with
 * the saved cookies sent directly to the API, independent of any cookie jar. Complements
 * apps/api/test/session-rules.integration-spec.ts (backend-dev) with: a normal route and a
 * refresh-cookie-only request after logout, Rule A for admins on every path, a real Redis
 * disconnect (not a spy), rotated cookies after reuse, the heartbeat throttle, and the session
 * check's use of the token subject.
 */
const V1 = '/api/v1';
const IDLE_SECONDS = 60;
const ADMIN = { username: 'qa-admin', password: testAdminPassword() };
const STUDENT = { username: 'QA-S-0001', password: testStudentPassword() };
const OTHER = { username: 'QA-S-0002', password: testPassword('qa-s-other') };

interface Saved {
  at: string;
  rt: string;
  csrf: string;
}
const saved = (s: LoggedIn): Saved => ({
  at: s.cookies.get('ssrs_at')!.value,
  rt: s.cookies.get('ssrs_rt')!.value,
  csrf: s.cookies.get('ssrs_csrf')!.value,
});
const all = (s: Saved) => `ssrs_at=${s.at}; ssrs_rt=${s.rt}; ssrs_csrf=${s.csrf}`;

/** Really disconnects an ioredis client (offline queue is off, so commands then fail fast). */
async function takeDown(client: import('ioredis').Redis): Promise<void> {
  const ended = new Promise<void>((r) => client.once('end', () => r()));
  client.disconnect();
  await ended;
}
async function bringUp(client: import('ioredis').Redis): Promise<void> {
  if (client.status === 'ready') return;
  await client.connect();
}

describe('QA S: session rules with saved tokens (integration)', () => {
  let ctx: TestContext;
  let base: string;
  const http = () => request(ctx.app.getHttpServer());

  const route = (s: Saved, path: string) =>
    http().get(`${V1}${path}`).set('Cookie', `ssrs_at=${s.at}; ssrs_csrf=${s.csrf}`);
  /** Refresh with only the refresh + CSRF cookies (no access cookie), as after its Max-Age. */
  const refreshOnly = (s: Saved) =>
    http()
      .post(`${V1}/auth/refresh`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', `ssrs_rt=${s.rt}; ssrs_csrf=${s.csrf}`);
  const heartbeat = (s: Saved) =>
    http()
      .post(`${V1}/auth/heartbeat`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .set('Cookie', all(s));
  const live = async (s: Saved) => {
    const controller = new AbortController();
    const res = await fetch(`${base}${V1}/auth/live`, {
      headers: { Cookie: all(s), 'X-CSRF-Token': s.csrf },
      signal: controller.signal,
    });
    const body = res.status === 200 ? null : ((await res.json()) as { error?: { code?: string } });
    if (res.status === 200) controller.abort();
    return { status: res.status, code: body?.error?.code };
  };

  /** Every path with the saved tokens; returns "status code" per path. */
  async function everyPath(s: Saved, normal: string) {
    const r = await route(s, normal);
    const me = await route(s, '/auth/me');
    const hb = await heartbeat(s);
    const lv = await live(s);
    const rf = await refreshOnly(s);
    return {
      normal: `${r.status} ${r.body?.error?.code}`,
      me: `${me.status} ${me.body?.error?.code}`,
      heartbeat: `${hb.status} ${hb.body?.error?.code}`,
      live: `${lv.status} ${lv.code}`,
      refresh: `${rf.status} ${rf.body?.error?.code}`,
    };
  }
  const allAre = (code: string) => ({
    normal: `401 ${code}`,
    me: `401 ${code}`,
    heartbeat: `401 ${code}`,
    live: `401 ${code}`,
    refresh: `401 ${code}`,
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
  afterAll(async () => ctx.close());
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetState(ctx);
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
    await seedUser(ctx, { ...OTHER, role: 'STUDENT' });
  });

  it('S-01 logout: saved access and refresh tokens are refused at once on every path', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    await route(a, '/student/me').expect(200);
    await http()
      .post(`${V1}/auth/logout`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', a.csrf)
      .set('Cookie', all(a))
      .expect(204);
    const result = await everyPath(a, '/student/me');
    console.log('[S-01]', JSON.stringify(result));
    expect(result).toEqual(allAre('SESSION_REVOKED'));
  });

  it('S-02 Rule A (admin): the first admin session is refused on every path after a second login', async () => {
    const a = saved(await login(ctx, ADMIN.username, ADMIN.password));
    await route(a, '/admin/generations').expect(200);
    const b = saved(await login(ctx, ADMIN.username, ADMIN.password));
    const result = await everyPath(a, '/admin/generations');
    console.log('[S-02]', JSON.stringify(result));
    expect(result).toEqual(allAre('SESSION_REPLACED'));
    await route(b, '/admin/generations').expect(200);
  });

  it('S-03 Rule A (student): the first student session is refused on every path', async () => {
    const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
    const b = saved(await login(ctx, STUDENT.username, STUDENT.password));
    const result = await everyPath(a, '/student/me');
    console.log('[S-03]', JSON.stringify(result));
    expect(result).toEqual(allAre('SESSION_REPLACED'));
    await route(b, '/student/me').expect(200);
  });

  it('S-04 Rule A also applies to a login that must change its password', async () => {
    await ctx.prisma.user.updateMany({
      where: { username: STUDENT.username },
      data: { mustChangePassword: true },
    });
    const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
    await login(ctx, STUDENT.username, STUDENT.password);
    const me = await route(a, '/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REPLACED');
  });

  it('S-05 idle: saved tokens are refused and a heartbeat does not revive the session', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    await heartbeat(a).expect(204);
    await ctx.prisma.authSession.updateMany({
      where: { userId: s.body.user.id },
      data: { lastActivityAt: new Date(Date.now() - (IDLE_SECONDS + 1) * 1000) },
    });
    // The first request to notice is a normal route this time (not the heartbeat).
    const result = await everyPath(a, '/student/me');
    console.log('[S-05]', JSON.stringify(result));
    expect(result).toEqual(allAre('SESSION_IDLE'));
    const row = await ctx.prisma.authSession.findFirstOrThrow({
      where: { userId: s.body.user.id },
    });
    expect(row.revokeReason).toBe('IDLE_TIMEOUT');
    expect(row.lastActivityAt.getTime()).toBeLessThan(Date.now() - IDLE_SECONDS * 1000);
  });

  it('S-06 idle boundary: a session just under the limit still works and is refreshed by a heartbeat', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    await ctx.prisma.authSession.updateMany({
      where: { userId: s.body.user.id },
      data: { lastActivityAt: new Date(Date.now() - (IDLE_SECONDS - 5) * 1000) },
    });
    await heartbeat(a).expect(204);
    await route(a, '/student/me').expect(200);
  });

  it('S-07 Redis disconnected (real client disconnect): a revoked session stays refused, a valid one works', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    const b = saved(await login(ctx, OTHER.username, OTHER.password));
    await http()
      .post(`${V1}/auth/logout`)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', a.csrf)
      .set('Cookie', all(a))
      .expect(204);
    await ctx.redis.flushdb(); // no denylist entry left: only PostgreSQL can refuse
    const client = ctx.app.get(RedisService).client;
    await takeDown(client);
    try {
      expect(client.status).not.toBe('ready');
      const meA = await route(a, '/auth/me');
      const meB = await route(b, '/auth/me');
      const studentA = await route(a, '/student/me');
      const hbA = await heartbeat(a);
      const rfA = await refreshOnly(a);
      console.log(
        '[S-07] redis',
        client.status,
        'revoked:',
        meA.status,
        meA.body?.error?.code,
        studentA.status,
        hbA.status,
        rfA.status,
        'valid:',
        meB.status,
      );
      expect(meA.status).toBe(401);
      expect(studentA.status).toBe(401);
      expect(hbA.status).toBe(401);
      expect(rfA.status).toBe(401);
      expect(meB.status).toBe(200);
    } finally {
      await bringUp(client);
    }
  });

  it('S-08 Redis disconnected: a second login still ends the first session (Rule A without Redis)', async () => {
    const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
    const client = ctx.app.get(RedisService).client;
    await takeDown(client);
    try {
      const second = await http()
        .post(`${V1}/auth/login`)
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: STUDENT.username, password: STUDENT.password });
      const meA = await route(a, '/auth/me');
      console.log(
        '[S-08] login with Redis down:',
        second.status,
        second.body?.error?.code ?? '',
        '| A after:',
        meA.status,
        meA.body?.error?.code ?? '',
      );
      // Whatever the login answered, A must never be usable after a successful second login.
      if (second.status === 200) expect(meA.status).toBe(401);
      else expect(meA.status).toBe(200);
    } finally {
      await bringUp(client);
    }
  });

  it('S-09 reused refresh token: refused, and the rotated cookies of that session die with it', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const old = saved(s);
    const rotated = await refreshOnly(old).expect(204);
    const cookies = (rotated.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0]!,
    );
    const pick = (name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split('=')[1];
    const fresh: Saved = {
      at: pick('ssrs_at')!,
      rt: pick('ssrs_rt')!,
      csrf: pick('ssrs_csrf') ?? old.csrf,
    };
    await route(fresh, '/student/me').expect(200);
    const reused = await refreshOnly(old);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    const result = await everyPath(fresh, '/student/me');
    console.log('[S-09] rotated after reuse', JSON.stringify(result));
    for (const v of Object.values(result)) expect(v.startsWith('401')).toBe(true);
    // The CSRF cookie is one value per session and survives a refresh (frontend relies on it).
    expect(pick('ssrs_csrf') ?? old.csrf).toBe(old.csrf);
  });

  it('S-10 heartbeat is throttled per user (10/min) and the throttle never revives anything', async () => {
    const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await heartbeat(a)).status);
    console.log('[S-10] heartbeat statuses', statuses.join(','));
    expect(statuses.slice(0, 10).every((x) => x === 204)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    await route(a, '/auth/me').expect(200);
  });

  it("S-11 a heartbeat cannot be pointed at another user's session (token subject vs session owner)", async () => {
    const mine = await login(ctx, STUDENT.username, STUDENT.password);
    const other = await login(ctx, OTHER.username, OTHER.password);
    const otherSid = (
      await ctx.prisma.authSession.findFirstOrThrow({ where: { userId: other.body.user.id } })
    ).id;
    // Requires the signing secret (not available to an attacker): defence in depth only.
    const forged = await new SignJWT({ role: 'STUDENT', sid: otherSid, mcp: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(mine.body.user.id)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode(ctx.env.JWT_ACCESS_SECRET));
    const res = await http()
      .get(`${V1}/auth/me`)
      .set('Cookie', `ssrs_at=${forged}; ssrs_csrf=${saved(mine).csrf}`);
    console.log('[S-11] mismatched sub/sid on /auth/me:', res.status, res.body?.error?.code ?? '');
    expect(res.status).toBe(401);
  });

  it('S-12 an expired session (expires_at passed) is refused on every path', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    await ctx.prisma.authSession.updateMany({
      where: { userId: s.body.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const result = await everyPath(a, '/student/me');
    console.log('[S-12]', JSON.stringify(result));
    for (const v of Object.values(result)) expect(v.startsWith('401')).toBe(true);
  });

  it('S-13 a disabled user is refused on every path at once (no positive cache)', async () => {
    const s = await login(ctx, STUDENT.username, STUDENT.password);
    const a = saved(s);
    await route(a, '/student/me').expect(200);
    await ctx.prisma.user.updateMany({
      where: { username: STUDENT.username },
      data: { status: 'DISABLED' },
    });
    const result = await everyPath(a, '/student/me');
    console.log('[S-13]', JSON.stringify(result));
    for (const v of Object.values(result)) expect(v.startsWith('401')).toBe(true);
  });

  it('S-14 a failed login on B (wrong password, then locked) touches neither A nor its live slot', async () => {
    const a = saved(await login(ctx, STUDENT.username, STUDENT.password));
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await http()
        .post(`${V1}/auth/login`)
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: STUDENT.username, password: testPassword('qa-wrong') });
      statuses.push(r.status);
    }
    // Correct password while locked out (the lockout keys must not be cleared here).
    const locked = await http()
      .post(`${V1}/auth/login`)
      .set('Origin', WEB_ORIGIN)
      .send({ identifier: STUDENT.username, password: STUDENT.password });
    console.log(
      '[S-14] wrong:',
      statuses.join(','),
      'locked correct:',
      locked.status,
      locked.body?.error?.code,
    );
    expect(locked.status).toBe(429);
    const result = await everyPath(a, '/student/me');
    expect(result.normal).toBe('200 undefined');
    expect(result.heartbeat).toBe('204 undefined');
    expect(result.live).toBe('200 undefined');
    expect(await ctx.prisma.authSession.count({ where: { revokedAt: { not: null } } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.sessions.replaced' } })).toBe(
      0,
    );
  });

  it('S-15 audit: one auth.sessions.replaced per replacing login, with revokedCount and no tokens', async () => {
    const first = await login(ctx, STUDENT.username, STUDENT.password);
    // A second, older session inserted directly: the next login revokes two.
    await insertSession(ctx, first.body.user.id);
    const second = await login(ctx, STUDENT.username, STUDENT.password);
    await clearRateLimits(ctx);
    await login(ctx, STUDENT.username, STUDENT.password);
    const rows = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.sessions.replaced' },
      orderBy: { createdAt: 'asc' },
    });
    console.log('[S-15] counts', rows.map((r) => JSON.stringify(r.metadata)).join(' '));
    expect(rows.map((r) => (r.metadata as { revokedCount: number }).revokedCount)).toEqual([2, 1]);
    const text = JSON.stringify(rows);
    for (const s of [first, second]) {
      for (const name of ['ssrs_at', 'ssrs_rt', 'ssrs_csrf']) {
        expect(text).not.toContain(s.cookies.get(name)!.value);
      }
    }
    expect(Object.keys(rows[0]!.metadata as object)).toEqual(['revokedCount']);
  });
});
