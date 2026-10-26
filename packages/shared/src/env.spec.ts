import { z } from 'zod';
import { EnvValidationError, envFields, parseEnv } from './env.js';

const schema = z.object({
  NODE_ENV: envFields.nodeEnv,
  PORT: envFields.port(4000),
  DATABASE_URL: envFields.postgresUrl,
  REDIS_URL: envFields.redisUrl,
  WEB_ORIGIN: envFields.origin,
  FLAG: envFields.booleanFlag(false),
});

const valid = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://:secret@localhost:6379',
  WEB_ORIGIN: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('applies defaults and coercion', () => {
    const env = parseEnv(schema, { ...valid, PORT: '8080', FLAG: '1' });
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 8080, FLAG: true });
  });

  it('reports every invalid variable without leaking values', () => {
    let error: unknown;
    try {
      parseEnv(schema, {
        DATABASE_URL: 'mysql://user:topsecret@host/db',
        REDIS_URL: 'not a url',
        WEB_ORIGIN: 'http://localhost:3000/path',
        PORT: '70000',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const err = error as EnvValidationError;
    expect(err.issues.map((i) => i.split(':')[0])).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'WEB_ORIGIN', 'PORT']),
    );
    expect(err.message).not.toContain('topsecret');
  });

  it('accepts origins with a trailing slash', () => {
    expect(
      parseEnv(schema, { ...valid, WEB_ORIGIN: 'https://scores.example.edu/' }).WEB_ORIGIN,
    ).toBe('https://scores.example.edu/');
  });
});
