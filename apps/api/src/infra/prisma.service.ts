import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@ssrs/database';
import { API_ENV, type ApiEnv } from '../config/env.js';

/** Owns the PrismaClient lifecycle. Inject `PrismaService` and use `.client`. */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = createPrismaClient({
      connectionString: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    });
  }

  /** Connects and runs one query at startup: fails fast and loads the query compiler early. */
  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    await this.ping();
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
