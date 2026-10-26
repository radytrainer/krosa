import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  connectionString: string;
  /** Max pool size for the pg driver adapter. */
  poolMax?: number;
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
  });
  return new PrismaClient({ adapter, log: options.log ?? ['warn', 'error'] });
}
