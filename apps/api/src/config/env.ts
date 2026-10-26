import { envFields, parseEnv } from '@ssrs/shared';
import { z } from 'zod';

export const apiEnvSchema = z
  .object({
    NODE_ENV: envFields.nodeEnv,
    API_PORT: envFields.port(4000),
    LOG_LEVEL: envFields.logLevel,
    DATABASE_URL: envFields.postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: envFields.redisUrl,
    WEB_ORIGIN: envFields.origin,
    /** Number of reverse-proxy hops to trust for client IPs (0 = none). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    SWAGGER_ENABLED: envFields.booleanFlag(false),

    /** HS256 key for access tokens; also derives CSRF tokens. ≥ 32 characters of randomness. */
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** Absolute session lifetime; refreshing never extends it. */
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24 * 7),
    /** Lifetime of admin-issued temporary passwords. */
    TEMP_PASSWORD_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    /** Defaults to true when WEB_ORIGIN is https. */
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),

    // Google service account (docs/security.md §5). Optional: without it, source registration
    // and sync report GOOGLE_NOT_CONFIGURED. Use EITHER a mounted key file OR email + key.
    GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
    /** PEM private key; literal "\n" sequences are converted to newlines. */
    GOOGLE_PRIVATE_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const inline =
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL !== undefined || env.GOOGLE_PRIVATE_KEY !== undefined;
    if (inline && (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_PRIVATE_KEY'],
        message: 'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set together',
      });
    }
    if (inline && env.GOOGLE_APPLICATION_CREDENTIALS) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_APPLICATION_CREDENTIALS'],
        message:
          'configure either GOOGLE_APPLICATION_CREDENTIALS or the inline email/key, not both',
      });
    }
  })
  .transform(({ COOKIE_SECURE, ...env }) => ({
    ...env,
    COOKIE_SECURE:
      COOKIE_SECURE === undefined
        ? env.WEB_ORIGIN.startsWith('https://')
        : COOKIE_SECURE === 'true',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'must be https in production',
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}

export const API_ENV = Symbol('API_ENV');
