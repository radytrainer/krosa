import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  connectionString: string;
  /** Max pool size for the pg driver adapter. */
  poolMax?: number;
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

/**
 * Gives every term of a generation the default programs and classes (migration
 * 20261103090000_term_enrollments holds them). Terms that already have programs are left alone.
 */
export async function applyTermDefaults(
  db: Pick<PrismaClient, '$executeRaw'>,
  generationId: string,
): Promise<void> {
  await db.$executeRaw`SELECT ssrs_apply_term_defaults(id) FROM terms WHERE generation_id = ${generationId}::uuid`;
}

/**
 * Gives a generation the official letter-grade scale, confirmed (decisions.md G5; migration
 * 20261113090000_grade_scale_2026_11 holds it). A generation that already has bands is left alone.
 */
export async function applyGradeDefaults(
  db: Pick<PrismaClient, '$executeRaw'>,
  generationId: string,
): Promise<void> {
  await db.$executeRaw`SELECT ssrs_apply_grade_defaults(${generationId}::uuid)`;
}

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
  });
  return new PrismaClient({ adapter, log: options.log ?? ['warn', 'error'] });
}
