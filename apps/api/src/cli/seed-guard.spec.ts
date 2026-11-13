import { describe, expect, it } from 'vitest';
import { seedRefusal } from './seed-guard.js';

const local = (db: string, host = 'localhost') => `postgresql://app@${host}:5432/${db}`;

describe('seedRefusal', () => {
  it('allows a local disposable database', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'postgres', 'LOCALHOST']) {
      expect(
        seedRefusal({ nodeEnv: 'development', databaseUrl: local('demo', host), allowSsrs: false }),
      ).toBeNull();
    }
    expect(
      seedRefusal({ nodeEnv: 'test', databaseUrl: local('ssrs_test'), allowSsrs: false }),
    ).toBeNull();
  });

  it('refuses NODE_ENV=production, even locally', () => {
    expect(
      seedRefusal({ nodeEnv: 'production', databaseUrl: local('demo'), allowSsrs: true }),
    ).toMatch(/NODE_ENV=production/);
  });

  it('refuses a database that is not local', () => {
    for (const host of ['db.example.com', '10.0.0.5', 'ssrs.abc123.rds.amazonaws.com']) {
      expect(
        seedRefusal({ nodeEnv: 'development', databaseUrl: local('demo', host), allowSsrs: true }),
      ).toMatch(/only a local database/);
    }
  });

  it('refuses ssrs unless --allow-ssrs is given', () => {
    expect(
      seedRefusal({ nodeEnv: 'development', databaseUrl: local('ssrs'), allowSsrs: false }),
    ).toMatch(/real student data/);
    expect(
      seedRefusal({ nodeEnv: 'development', databaseUrl: local('SSRS'), allowSsrs: false }),
    ).toMatch(/real student data/);
    expect(
      seedRefusal({ nodeEnv: 'development', databaseUrl: local('ssrs'), allowSsrs: true }),
    ).toBeNull();
  });

  it('refuses a URL it cannot read or one without a database name', () => {
    expect(
      seedRefusal({ nodeEnv: 'development', databaseUrl: 'not a url', allowSsrs: false }),
    ).toMatch(/not a valid URL/);
    expect(
      seedRefusal({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://app@localhost:5432/',
        allowSsrs: false,
      }),
    ).toMatch(/names no database/);
  });
});
