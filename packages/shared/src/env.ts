import { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates environment variables against a Zod schema. Error messages name the variable
 * and the problem but never echo the value, because values are frequently secrets.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}

/** Reusable field schemas. */
export const envFields = {
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback),
  logLevel: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  booleanFlag: (fallback: boolean) =>
    z
      .enum(['true', 'false', '1', '0'])
      .default(fallback ? 'true' : 'false')
      .transform((v) => v === 'true' || v === '1'),
  postgresUrl: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),
  redisUrl: z
    .string()
    .url()
    .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),
  origin: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return u.origin === v.replace(/\/$/, '');
    }, 'must be an origin (scheme://host[:port]) without a path'),
};
