import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { ApiEnv } from '../config/env.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** Paths redacted from every log line. Keep in sync with docs/security.md §8. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.temporaryPassword',
  '*.token',
  '*.refreshToken',
  '*.privateKey',
];

export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers['x-request-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  const id = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

export function buildLoggerParams(env: ApiEnv): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: resolveRequestId,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      mixin: () => ({ service: 'api' }),
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    },
  };
}
