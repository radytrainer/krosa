import { envFields, parseEnv } from '@ssrs/shared';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: envFields.nodeEnv,
  LOG_LEVEL: envFields.logLevel,
  DATABASE_URL: envFields.postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
  REDIS_URL: envFields.redisUrl,
  /** Concurrent sync jobs processed by one worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  /** Upper bound on sync jobs started per minute (each job makes ~3 Google API requests). */
  SYNC_JOBS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(50),
  // Google service account — same settings as the API (see .env.example).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY: z.string().min(1).optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}

export const WORKER_ENV = Symbol('WORKER_ENV');
