import request from 'supertest';
import {
  WEB_ORIGIN,
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const OTHER_ADMIN = { username: 'admin2', password: 'Admin-Second-Pass-2026' };
const STUDENT = { username: 'GEN26-0001', password: 'Student-Initial-Pass-2026' };
const PARTNER = 'https://partner.example.org';

describe('Security hardening (integration)', () => {
  describe('rate limiting', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp({ env: { RATE_LIMIT_PER_MINUTE: '20' } });
    });
    afterAll(async () => ctx.close());
    beforeEach(async () => resetState(ctx));

    it('limits every IP globally, with Retry-After, but never health probes', async () => {
      const server = ctx.app.getHttpServer();
      for (let i = 0; i < 20; i++) await request(server).get('/api/v1/auth/me').expect(401);
      const limited = await request(server).get('/api/v1/auth/me').expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Health stays reachable for load balancers even while the IP is limited.
      await request(server).get('/api/v1/health').expect(200);
    });
  });

  describe('refresh limit', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp({ env: { RATE_LIMIT_PER_MINUTE: '1000' } });
    });
    afterAll(async () => ctx.close());
    beforeEach(async () => resetState(ctx));

    it('allows 30 refreshes per IP per minute, checked before any token', async () => {
      const server = ctx.app.getHttpServer();
      for (let i = 0; i < 30; i++) {
        const res = await request(server).post('/api/v1/auth/refresh').set('Origin', WEB_ORIGIN);
        expect(res.status).toBe(401); // no refresh cookie
      }
      const limited = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      // Other routes still have budget: the global limit is separate.
      await request(server).get('/api/v1/auth/me').expect(401);
    });
  });

  describe('per-admin credential limit', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    });
    afterAll(async () => ctx.close());
    beforeEach(async () => resetState(ctx));

    it('allows 20 credential operations per admin per minute, shared across endpoints', async () => {
      await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
      await seedUser(ctx, { ...OTHER_ADMIN, role: 'ADMIN' });
      const user = await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      const student = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
      const admin = api(await login(ctx, ADMIN.username, ADMIN.password));

      for (let i = 0; i < 19; i++) {
        await admin.post(`/api/v1/admin/students/${student.id}/reset-password`).expect(200);
      }
      // The bulk endpoint shares the same budget: this is operation 20.
      await admin
        .post('/api/v1/admin/students/issue-credentials', {
          studentIds: [student.id],
          onlyPending: false,
        })
        .expect(200);
      const limited = await admin
        .post(`/api/v1/admin/students/${student.id}/reset-password`)
        .expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');

      // The budget is per admin, not global.
      const other = api(await login(ctx, OTHER_ADMIN.username, OTHER_ADMIN.password));
      await other.post(`/api/v1/admin/students/${student.id}/reset-password`).expect(200);
    });
  });

  describe('CSRF and CORS', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp({ env: { CORS_ORIGINS: PARTNER } });
    });
    afterAll(async () => ctx.close());
    beforeEach(async () => {
      await resetState(ctx);
      await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    });

    const body = { code: 'GEN2030', name: 'Generation 2030', startDate: '2030-01-07' };

    it('rejects unsafe requests without, or with a foreign, Origin', async () => {
      const session = await login(ctx, ADMIN.username, ADMIN.password);
      const noOrigin = await session.agent
        .post('/api/v1/admin/generations')
        .set('X-CSRF-Token', session.csrf)
        .send(body)
        .expect(403);
      expect(noOrigin.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
      const foreign = await session.agent
        .post('/api/v1/admin/generations')
        .set('Origin', 'https://evil.example')
        .set('X-CSRF-Token', session.csrf)
        .send(body)
        .expect(403);
      expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
      // A Referer from the web origin is accepted when Origin is absent.
      await session.agent
        .post('/api/v1/admin/generations')
        .set('Referer', `${WEB_ORIGIN}/admin/generations`)
        .set('X-CSRF-Token', session.csrf)
        .send(body)
        .expect(201);
    });

    it('requires the CSRF token of the same session', async () => {
      const a = await login(ctx, ADMIN.username, ADMIN.password);
      const b = await login(ctx, ADMIN.username, ADMIN.password);
      const missing = await a.agent
        .post('/api/v1/admin/generations')
        .set('Origin', WEB_ORIGIN)
        .send(body)
        .expect(403);
      expect(missing.body.error.code).toBe('CSRF_INVALID');
      // Another session's token (e.g. tossed from a sibling subdomain) does not work.
      const crossed = await a.agent
        .post('/api/v1/admin/generations')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', b.csrf)
        .send(body)
        .expect(403);
      expect(crossed.body.error.code).toBe('CSRF_INVALID');
      // Safe methods need neither.
      await a.agent.get('/api/v1/admin/generations').expect(200);
    });

    it('answers CORS only for configured origins, with credentials and never a wildcard', async () => {
      const server = ctx.app.getHttpServer();
      const allowed = await request(server)
        .options('/api/v1/admin/generations')
        .set('Origin', PARTNER)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(allowed.headers['access-control-allow-origin']).toBe(PARTNER);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const denied = await request(server)
        .options('/api/v1/admin/generations')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();

      // The CSRF Origin check accepts the configured origin too.
      const session = await login(ctx, ADMIN.username, ADMIN.password);
      await session.agent
        .post('/api/v1/admin/generations')
        .set('Origin', PARTNER)
        .set('X-CSRF-Token', session.csrf)
        .send(body)
        .expect(201);
    });
  });

  describe('response headers', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    });
    afterAll(async () => ctx.close());

    it('sends hardening headers and no CORS headers by default', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['x-request-id']).toMatch(/^[\w.-]{8,64}$/);
    });
  });
});
