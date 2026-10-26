import argon2 from 'argon2';
import request from 'supertest';
import {
  clearRateLimits,
  createTestApp,
  login,
  parseSetCookies,
  resetState,
  seedUser,
  WEB_ORIGIN,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const STUDENT = { username: 'GEN26-0001', password: 'Student-Initial-Pass-2026' };
const NEW_PASSWORD = 'a brand new passphrase 2026';

const change = (s: Awaited<ReturnType<typeof login>>, body: object) =>
  s.agent
    .post('/api/v1/auth/change-password')
    .set('Origin', WEB_ORIGIN)
    .set('X-CSRF-Token', s.csrf)
    .send(body);

describe('Authentication & authorization (integration)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
  });

  describe('POST /auth/login', () => {
    it('signs in, sets hardened cookies and never returns secrets', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username, password: ADMIN.password })
        .expect(200);

      expect(res.body.user).toMatchObject({
        username: 'admin',
        role: 'ADMIN',
        mustChangePassword: false,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|Admin-Initial/);

      const cookies = parseSetCookies(res);
      expect(cookies.get('ssrs_at')!.attrs).toMatch(/httponly/);
      expect(cookies.get('ssrs_at')!.attrs).toMatch(/path=\/api(;|$)/);
      expect(cookies.get('ssrs_at')!.attrs).toMatch(/samesite=lax/);
      expect(cookies.get('ssrs_rt')!.attrs).toMatch(/httponly/);
      expect(cookies.get('ssrs_rt')!.attrs).toMatch(/path=\/api\/v1\/auth/);
      expect(cookies.get('ssrs_rt')!.attrs).toMatch(/samesite=strict/);
      expect(cookies.get('ssrs_csrf')!.attrs).not.toMatch(/httponly/);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'auth.login.success' },
      });
      expect(audit).not.toBeNull();
    });

    it('accepts student IDs case-insensitively with surrounding whitespace', async () => {
      const { body } = await login(ctx, '  gen26-0001 ', STUDENT.password);
      expect(body.user.role).toBe('STUDENT');
    });

    it('gives identical responses for a wrong password and an unknown account', async () => {
      const wrong = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username, password: 'not the password' })
        .expect(401);
      const unknown = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: 'nobody-here', password: 'not the password' })
        .expect(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.error.code).toBe(wrong.body.error.code);
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('rejects requests without a matching Origin (login CSRF)', async () => {
      const body = { identifier: ADMIN.username, password: ADMIN.password };
      const none = await http().post('/api/v1/auth/login').send(body).expect(403);
      expect(none.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
      await http()
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.example')
        .send(body)
        .expect(403);
    });

    it('validates input and rejects unknown fields (no mass assignment)', async () => {
      const missing = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username })
        .expect(400);
      expect(missing.body.error.code).toBe('VALIDATION_FAILED');
      await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username, password: ADMIN.password, role: 'ADMIN' })
        .expect(400);
    });

    it('locks the account progressively after repeated failures', async () => {
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/v1/auth/login')
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: ADMIN.username, password: `wrong-${i}` })
          .expect(401);
      }
      await clearRateLimits(ctx);
      const locked = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username, password: ADMIN.password })
        .expect(429);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
      expect(user.failedLoginCount).toBe(5);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.account.locked' } })).toBe(1);
    });

    it('rate-limits attempts per identifier and per IP', async () => {
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/v1/auth/login')
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: 'ghost', password: 'x' });
      }
      const perId = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: 'ghost', password: 'x' })
        .expect(429);
      expect(perId.body.error.code).toBe('RATE_LIMITED');

      await clearRateLimits(ctx);
      for (let i = 0; i < 10; i++) {
        await http()
          .post('/api/v1/auth/login')
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: `ghost-${i}`, password: 'x' });
      }
      const perIp = await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: 'ghost-new', password: 'x' })
        .expect(429);
      expect(perIp.headers['retry-after']).toBeDefined();
    });

    it('refuses disabled, pending and expired-temporary-password accounts', async () => {
      await seedUser(ctx, {
        username: 'disabled-admin',
        password: ADMIN.password,
        status: 'DISABLED',
      });
      await seedUser(ctx, {
        username: 'pending-admin',
        password: ADMIN.password,
        status: 'PENDING',
      });
      await seedUser(ctx, {
        username: 'expired-admin',
        password: ADMIN.password,
        mustChangePassword: true,
        passwordExpiresAt: new Date(Date.now() - 1000),
      });
      const codes: string[] = [];
      for (const identifier of ['disabled-admin', 'pending-admin', 'expired-admin']) {
        const res = await http()
          .post('/api/v1/auth/login')
          .set('Origin', WEB_ORIGIN)
          .send({ identifier, password: ADMIN.password })
          .expect(403);
        codes.push(res.body.error.code);
      }
      expect(codes).toEqual(['ACCOUNT_DISABLED', 'ACCOUNT_PENDING', 'TEMPORARY_PASSWORD_EXPIRED']);
    });

    it('upgrades hashes created with weaker Argon2 parameters on login', async () => {
      const weak = await argon2.hash(ADMIN.password, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 1,
        parallelism: 1,
      });
      await seedUser(ctx, {
        username: 'legacy-admin',
        password: ADMIN.password,
        passwordHash: weak,
      });
      await login(ctx, 'legacy-admin', ADMIN.password);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'legacy-admin' } });
      expect(user.passwordHash).toMatch(/m=19456/);
      expect(user.passwordHash).toMatch(/t=2/);
    });
  });

  describe('sessions', () => {
    it('GET /auth/me requires a valid access token', async () => {
      await http().get('/api/v1/auth/me').expect(401);
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      const me = await s.agent.get('/api/v1/auth/me').expect(200);
      expect(me.body).toMatchObject({ role: 'STUDENT', student: { studentCode: 'GEN26-0001' } });

      await http().get('/api/v1/auth/me').set('Cookie', 'ssrs_at=not-a-jwt').expect(401);
    });

    it('rotates refresh tokens and revokes the session when an old token is reused', async () => {
      const s = await login(ctx, ADMIN.username, ADMIN.password);
      const firstRefresh = s.cookies.get('ssrs_rt')!.value;
      const firstAccess = s.cookies.get('ssrs_at')!.value;

      const rotated = await s.agent
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);
      const secondRefresh = parseSetCookies(rotated).get('ssrs_rt')!.value;
      expect(secondRefresh).not.toBe(firstRefresh);
      await s.agent.get('/api/v1/auth/me').expect(200);

      // An attacker replays the first (already used) refresh token.
      const replay = await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .set('Cookie', `ssrs_rt=${firstRefresh}`)
        .expect(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      // The whole session is now dead: the latest refresh token and old access tokens fail.
      await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .set('Cookie', `ssrs_rt=${secondRefresh}`)
        .expect(401);
      const revoked = await http()
        .get('/api/v1/auth/me')
        .set('Cookie', `ssrs_at=${firstAccess}`)
        .expect(401);
      expect(revoked.body.error.code).toBe('SESSION_REVOKED');
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } }),
      ).toBe(1);
    });

    it('rejects refresh without the session-bound CSRF token and keeps cookies', async () => {
      const s = await login(ctx, ADMIN.username, ADMIN.password);
      const res = await s.agent.post('/api/v1/auth/refresh').set('Origin', WEB_ORIGIN).expect(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
      expect(parseSetCookies(res).size).toBe(0);
      await s.agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', s.csrf).expect(403); // no Origin
    });

    it('rejects unknown refresh tokens', async () => {
      const res = await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('Cookie', 'ssrs_rt=forged-token-value')
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('logout revokes the session so neither token can be reused', async () => {
      const s = await login(ctx, ADMIN.username, ADMIN.password);
      const access = s.cookies.get('ssrs_at')!.value;
      const refresh = s.cookies.get('ssrs_rt')!.value;

      await s.agent
        .post('/api/v1/auth/logout')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .expect(204);

      const me = await http().get('/api/v1/auth/me').set('Cookie', `ssrs_at=${access}`).expect(401);
      expect(me.body.error.code).toBe('SESSION_REVOKED');
      await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .set('Cookie', `ssrs_rt=${refresh}`)
        .expect(401);
      const session = await ctx.prisma.authSession.findFirstOrThrow();
      expect(session.revokeReason).toBe('LOGOUT');
    });

    it('logout works with only the refresh cookie and requires its CSRF token', async () => {
      const s = await login(ctx, ADMIN.username, ADMIN.password);
      const refresh = s.cookies.get('ssrs_rt')!.value;
      await http()
        .post('/api/v1/auth/logout')
        .set('Origin', WEB_ORIGIN)
        .set('Cookie', `ssrs_rt=${refresh}`)
        .expect(403);
      await http()
        .post('/api/v1/auth/logout')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .set('Cookie', `ssrs_rt=${refresh}`)
        .expect(204);
      expect((await ctx.prisma.authSession.findFirstOrThrow()).revokedAt).not.toBeNull();
    });
  });

  describe('authorization guards', () => {
    it('requires the session CSRF token on state-changing requests', async () => {
      const admin = await login(ctx, ADMIN.username, ADMIN.password);
      const student = await login(ctx, STUDENT.username, STUDENT.password);

      const missing = await admin.agent
        .post('/api/v1/test/mutate')
        .set('Origin', WEB_ORIGIN)
        .expect(403);
      expect(missing.body.error.code).toBe('CSRF_INVALID');
      // A token from another session is useless (bound to session id).
      await admin.agent
        .post('/api/v1/test/mutate')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', student.csrf)
        .expect(403);
      await admin.agent
        .post('/api/v1/test/mutate')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrf)
        .expect(200);
    });

    it('enforces roles and denies routes without an access policy', async () => {
      const admin = await login(ctx, ADMIN.username, ADMIN.password);
      const student = await login(ctx, STUDENT.username, STUDENT.password);

      await http().get('/api/v1/test/admin').expect(401);
      await admin.agent.get('/api/v1/test/admin').expect(200);
      await student.agent.get('/api/v1/test/admin').expect(403);
      await student.agent.get('/api/v1/test/student').expect(200);
      await admin.agent.get('/api/v1/test/student').expect(403);
      await student.agent.get('/api/v1/test/any').expect(200);
      await admin.agent.get('/api/v1/test/unannotated').expect(403);
    });

    it('a forged role claim does not grant admin access', async () => {
      const student = await login(ctx, STUDENT.username, STUDENT.password);
      const [h, p, s] = student.cookies.get('ssrs_at')!.value.split('.');
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
      const forged = Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString(
        'base64url',
      );
      await http()
        .get('/api/v1/test/admin')
        .set('Cookie', `ssrs_at=${h}.${forged}.${s}`)
        .expect(401);
    });
  });

  describe('forced password change', () => {
    it('restricts the user to auth routes until the password is changed', async () => {
      await ctx.prisma.user.update({
        where: { username: STUDENT.username },
        data: { mustChangePassword: true, passwordExpiresAt: new Date(Date.now() + 86_400_000) },
      });
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      expect(s.body.user.mustChangePassword).toBe(true);

      const blocked = await s.agent.get('/api/v1/test/student').expect(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await s.agent.get('/api/v1/auth/me').expect(200);

      await s.agent
        .post('/api/v1/auth/change-password')
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', s.csrf)
        .send({ currentPassword: STUDENT.password, newPassword: NEW_PASSWORD })
        .expect(204);

      await s.agent.get('/api/v1/test/student').expect(200);
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { username: STUDENT.username },
      });
      expect(user.mustChangePassword).toBe(false);
      expect(user.passwordExpiresAt).toBeNull();
    });
  });

  describe('POST /auth/change-password', () => {
    it('rejects a wrong current password', async () => {
      const s = await login(ctx, ADMIN.username, ADMIN.password);
      const res = await change(s, { currentPassword: 'nope', newPassword: NEW_PASSWORD }).expect(
        400,
      );
      expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    });

    it('enforces the password policy', async () => {
      const s = await login(ctx, STUDENT.username, STUDENT.password);
      for (const newPassword of ['short', 'password123', 'my-gen26-0001-pass', STUDENT.password]) {
        const res = await change(s, { currentPassword: STUDENT.password, newPassword }).expect(422);
        expect(res.body.error.code).toBe('WEAK_PASSWORD');
        expect(res.body.error.details.length).toBeGreaterThan(0);
      }
    });

    it('changes the password and revokes the user’s other sessions', async () => {
      const a = await login(ctx, ADMIN.username, ADMIN.password);
      const b = await login(ctx, ADMIN.username, ADMIN.password);

      await change(a, { currentPassword: ADMIN.password, newPassword: NEW_PASSWORD }).expect(204);

      await a.agent.get('/api/v1/auth/me').expect(200);
      const other = await b.agent.get('/api/v1/auth/me').expect(401);
      expect(other.body.error.code).toBe('SESSION_REVOKED');

      await http()
        .post('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: ADMIN.username, password: ADMIN.password })
        .expect(401);
      await login(ctx, ADMIN.username, NEW_PASSWORD);
    });
  });

  it('never writes passwords or tokens into audit logs', async () => {
    const s = await login(ctx, ADMIN.username, ADMIN.password);
    await http()
      .post('/api/v1/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ identifier: ADMIN.username, password: 'Wrong-Password-Value' });
    await s.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', s.csrf)
      .send({ currentPassword: ADMIN.password, newPassword: NEW_PASSWORD })
      .expect(204);

    const logs = await ctx.prisma.auditLog.findMany();
    const dump = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      ADMIN.password,
      NEW_PASSWORD,
      'Wrong-Password-Value',
      s.cookies.get('ssrs_rt')!.value,
      s.csrf,
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});
