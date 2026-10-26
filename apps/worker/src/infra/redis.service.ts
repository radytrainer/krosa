import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { WORKER_ENV, type WorkerEnv } from '../config/env.js';

/** General-purpose Redis connection (heartbeat, cache invalidation). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(WORKER_ENV) env: WorkerEnv) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectionName: 'ssrs-worker',
    });
    this.client.on('error', (err: Error) => this.logger.warn(`Redis error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
