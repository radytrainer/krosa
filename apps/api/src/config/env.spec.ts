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

  it('treats a blank SENTRY_DSN as not set', () => {
    expect(loadApiEnv({ ...base, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
    expect(loadApiEnv({ ...base, SENTRY_DSN: '  ' }).SENTRY_DSN).toBeUndefined();
    expect(() => loadApiEnv({ ...base, SENTRY_DSN: 'not a url' })).toThrow(EnvValidationError);
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

  it('allows the fixture test mode only outside production', () => {
    expect(loadApiEnv({ ...base, SHEETS_TEST_MODE: 'fixtures' }).SHEETS_TEST_MODE).toBe('fixtures');
    expect(() =>
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://scores.example.edu',
        SHEETS_TEST_MODE: 'fixtures',
      }),
    ).toThrow(/SHEETS_TEST_MODE/);
    expect(() => loadApiEnv({ ...base, SHEETS_TEST_MODE: 'google' })).toThrow(EnvValidationError);
  });
});

describe('session settings (decisions.md SR2, SR5)', () => {
  it('defaults to a 15-minute idle limit and a 5-minute heartbeat', () => {
    const env = loadApiEnv(base);
    expect(env.SESSION_IDLE_TIMEOUT_SECONDS).toBe(900);
    expect(env.SESSION_HEARTBEAT_INTERVAL_SECONDS).toBe(300);
    expect(env.LIVE_MAX_PER_SESSION).toBe(3);
    expect(env.LIVE_MAX_PER_USER).toBe(5);
  });

  it('enforces the minimums', () => {
    expect(() => loadApiEnv({ ...base, SESSION_IDLE_TIMEOUT_SECONDS: '59' })).toThrow(
      EnvValidationError,
    );
    expect(() =>
      loadApiEnv({
        ...base,
        SESSION_HEARTBEAT_INTERVAL_SECONDS: '9',
        SESSION_IDLE_TIMEOUT_SECONDS: '60',
      }),
    ).toThrow(EnvValidationError);
  });

  it('keeps the heartbeat at most a third of the idle limit', () => {
    const short = { ...base, SESSION_IDLE_TIMEOUT_SECONDS: '60', ACCESS_TOKEN_TTL_SECONDS: '60' };
    expect(
      loadApiEnv({ ...short, SESSION_HEARTBEAT_INTERVAL_SECONDS: '20' })
        .SESSION_HEARTBEAT_INTERVAL_SECONDS,
    ).toBe(20);
    expect(() => loadApiEnv({ ...short, SESSION_HEARTBEAT_INTERVAL_SECONDS: '21' })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses an access token that outlives the idle limit', () => {
    expect(() =>
      loadApiEnv({
        ...base,
        SESSION_IDLE_TIMEOUT_SECONDS: '600',
        SESSION_HEARTBEAT_INTERVAL_SECONDS: '60',
        ACCESS_TOKEN_TTL_SECONDS: '900',
      }),
    ).toThrow(EnvValidationError);
  });
});
