import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  QUEUE_PREFIX,
  SYNC_QUEUE,
  SYNC_SOURCE_JOB,
  syncJobQueueOptions,
  type SyncSourceJobData,
} from '@ssrs/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../config/env.js';

/** Producer side of the sync queue. The API never runs sync work itself (SYNC-02). */
@Injectable()
export class SyncQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<SyncSourceJobData, string, string>;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectionName: 'ssrs-api-bull',
    });
    this.connection.on('error', () => undefined); // surfaced through enqueue failures
    this.queue = new Queue(SYNC_QUEUE, { connection: this.connection, prefix: QUEUE_PREFIX });
  }

  async enqueue(syncJobId: string): Promise<void> {
    await this.queue.add(SYNC_SOURCE_JOB, { syncJobId }, syncJobQueueOptions(syncJobId));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
