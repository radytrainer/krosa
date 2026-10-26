import { EnvValidationError } from '@ssrs/shared';
import { loadApiEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://:p@localhost:6379/0',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('loadApiEnv', () => {
  it('derives COOKIE_SECURE from the web origin', () => {
    expect(loadApiEnv(base).COOKIE_SECURE).toBe(false);
    expect(loadApiEnv({ ...base, WEB_ORIGIN: 'https://scores.example.edu' }).COOKIE_SECURE).toBe(
      true,
    );
    expect(loadApiEnv({ ...base, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
  });

  it('rejects short JWT secrets', () => {
    expect(() => loadApiEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('accepts exactly one Google credential mechanism', () => {
    expect(loadApiEnv(base).GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(() =>
      loadApiEnv({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com' }),
    ).toThrow(/GOOGLE_PRIVATE_KEY/);
    expect(() =>
      loadApiEnv({
        ...base,
        GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google-sa.json',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
        GOOGLE_PRIVATE_KEY: 'k',
      }),
    ).toThrow(/either/);
    expect(
      loadApiEnv({
        ...base,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
        GOOGLE_PRIVATE_KEY: 'k',
      }).GOOGLE_SERVICE_ACCOUNT_EMAIL,
    ).toBe('sa@p.iam.gserviceaccount.com');
  });

  it('requires https and secure cookies in production', () => {
    expect(() => loadApiEnv({ ...base, NODE_ENV: 'production' })).toThrow(/WEB_ORIGIN/);
    expect(() =>
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://scores.example.edu',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
    expect(
      loadApiEnv({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://scores.example.edu' }),
    ).toMatchObject({ COOKIE_SECURE: true });
  });
});
