import { Writable } from 'node:stream';
import pino from 'pino';
import { loadApiEnv } from '../config/env.js';
import { buildLoggerParams } from './logger.js';

const env = loadApiEnv({
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  WEB_ORIGIN: 'https://scores.example.edu',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
});

/** A pino logger with the API's real redaction and serializers, writing into an array. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  const { pinoHttp } = buildLoggerParams(env) as {
    pinoHttp: {
      redact: pino.LoggerOptions['redact'];
      serializers: pino.LoggerOptions['serializers'];
    };
  };
  const logger = pino({ redact: pinoHttp.redact, serializers: pinoHttp.serializers }, stream);
  return { logger, lines };
}

describe('log redaction', () => {
  it('logs requests as id, method and URL only: no headers, cookies or bodies', () => {
    const { logger, lines } = capture();
    logger.info({
      req: {
        id: 'req-12345678',
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          cookie: 'ssrs_at=secret',
          authorization: 'Bearer secret',
          'x-csrf-token': 'tok',
        },
        body: { identifier: 'admin', password: 'Correct-Horse-2026' },
      },
    });
    expect(lines[0]?.['req']).toEqual({
      id: 'req-12345678',
      method: 'POST',
      url: '/api/v1/auth/login',
    });
    expect(JSON.stringify(lines)).not.toMatch(/secret|Correct-Horse|tok/);
  });

  it('redacts secret fields in logged objects', () => {
    const { logger, lines } = capture();
    logger.warn({
      dto: {
        password: 'p1',
        currentPassword: 'p2',
        newPassword: 'p3',
        temporaryPassword: 'p4',
        token: 'p5',
        refreshToken: 'p6',
        privateKey: '-----BEGIN PRIVATE KEY-----',
        username: 'admin',
      },
      res: { headers: { 'set-cookie': ['ssrs_rt=secret'] } },
    });
    const dto = lines[0]?.['dto'] as Record<string, string>;
    for (const key of [
      'password',
      'currentPassword',
      'newPassword',
      'temporaryPassword',
      'token',
      'refreshToken',
      'privateKey',
    ]) {
      expect(dto[key]).toBe('[REDACTED]');
    }
    expect(dto['username']).toBe('admin');
    expect(JSON.stringify(lines)).not.toContain('ssrs_rt=secret');
  });
});
