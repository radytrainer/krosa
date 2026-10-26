import { SignJWT } from 'jose';
import { loadApiEnv } from '../config/env.js';
import { JWT_AUDIENCE, JWT_ISSUER, TokenService } from './token.service.js';

const env = loadApiEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://:p@localhost:6379/0',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-0001',
});
const tokens = new TokenService(env);
const user = {
  userId: '0199a3f0-0000-7000-8000-000000000001',
  role: 'STUDENT' as const,
  sessionId: '0199a3f0-0000-7000-8000-0000000000aa',
  mustChangePassword: true,
};

describe('TokenService', () => {
  it('round-trips an access token', async () => {
    const jwt = await tokens.signAccessToken(user);
    await expect(tokens.verifyAccessToken(jwt)).resolves.toEqual({ ok: true, user });
  });

  it('reports expiry separately from invalid tokens', async () => {
    const issued = new Date('2026-01-01T00:00:00Z');
    const jwt = await tokens.signAccessToken(user, issued);
    const later = new Date(issued.getTime() + (env.ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);
    await expect(tokens.verifyAccessToken(jwt, later)).resolves.toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects tampered tokens and tokens signed with another key', async () => {
    const jwt = await tokens.signAccessToken(user);
    const [h, p, s] = jwt.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'ADMIN' }),
    ).toString('base64url');
    await expect(tokens.verifyAccessToken(`${h}.${forgedPayload}.${s}`)).resolves.toEqual({
      ok: false,
      reason: 'INVALID',
    });

    const other = await new SignJWT({ role: 'ADMIN', sid: 's', mcp: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-completely-different-secret-value-123'));
    await expect(tokens.verifyAccessToken(other)).resolves.toMatchObject({ ok: false });
  });

  it('rejects the "none" algorithm and wrong audience', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'x',
        role: 'ADMIN',
        sid: 's',
        mcp: false,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      }),
    ).toString('base64url');
    await expect(tokens.verifyAccessToken(`${header}.${payload}.`)).resolves.toMatchObject({
      ok: false,
    });

    const wrongAud = await new SignJWT({ role: 'ADMIN', sid: 's', mcp: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuer(JWT_ISSUER)
      .setAudience('someone-else')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    await expect(tokens.verifyAccessToken(wrongAud)).resolves.toMatchObject({ ok: false });
  });

  it('binds CSRF tokens to the session', () => {
    const csrf = tokens.csrfTokenForSession('session-a');
    expect(tokens.verifyCsrfToken('session-a', csrf)).toBe(true);
    expect(tokens.verifyCsrfToken('session-b', csrf)).toBe(false);
    expect(tokens.verifyCsrfToken('session-a', undefined)).toBe(false);
    expect(tokens.verifyCsrfToken('session-a', csrf.slice(0, -1))).toBe(false);
  });

  it('generates high-entropy refresh tokens and hashes them deterministically', () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(tokens.hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hashRefreshToken(a)).toBe(tokens.hashRefreshToken(a));
  });
});
