import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@ssrs/database';
import { WORKER_ENV, type WorkerEnv } from '../config/env.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(WORKER_ENV) env: WorkerEnv) {
    this.client = createPrismaClient({
      connectionString: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
