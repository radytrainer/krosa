import { loadWorkerEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://:p@localhost:6379/0',
};

describe('loadWorkerEnv', () => {
  it('allows the fixture test mode only outside production', () => {
    expect(loadWorkerEnv({ ...base, SHEETS_TEST_MODE: 'fixtures' }).SHEETS_TEST_MODE).toBe(
      'fixtures',
    );
    expect(() =>
      loadWorkerEnv({ ...base, NODE_ENV: 'production', SHEETS_TEST_MODE: 'fixtures' }),
    ).toThrow(/SHEETS_TEST_MODE/);
  });
});
