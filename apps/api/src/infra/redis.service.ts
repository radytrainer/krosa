import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../config/env.js';

const READY_TIMEOUT_MS = 10_000;

/**
 * Shared Redis connection for cache, rate limiting and the session denylist.
 * BullMQ creates its own connections (it requires different retry settings).
 * The offline queue is disabled so commands fail fast instead of piling up during an outage.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectionName: 'ssrs-api',
    });
    this.client.on('error', (err: Error) => this.logger.warn(`Redis error: ${err.message}`));
  }

  /** Waits for the initial connection so the app never starts with Redis unreachable. */
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis not ready after ${READY_TIMEOUT_MS} ms`));
      }, READY_TIMEOUT_MS);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off('ready', onReady);
      };
      this.client.on('ready', onReady);
    });
  }

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
