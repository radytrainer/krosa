import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { WORKER_ENV, type WorkerEnv } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisService } from '../infra/redis.service.js';
import { heartbeatKey, heartbeatTtlSeconds, type HeartbeatPayload } from './heartbeat.js';

/**
 * Verifies dependencies at startup (fail fast) and publishes a periodic liveness record so
 * the API can report whether any sync worker is running.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  readonly workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly startedAt = new Date().toISOString();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.prisma.ping();
    await this.beat();
    this.timer = setInterval(() => {
      this.beat().catch((err: unknown) =>
        this.logger.warn(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, this.env.WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Worker ${this.workerId} ready (concurrency ${this.env.WORKER_CONCURRENCY})`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    clearInterval(this.timer);
    await this.redis.client.del(heartbeatKey(this.workerId)).catch(() => undefined);
    this.logger.log(`Worker ${this.workerId} stopped${signal ? ` (${signal})` : ''}`);
  }

  private async beat(): Promise<void> {
    const payload: HeartbeatPayload = {
      workerId: this.workerId,
      pid: process.pid,
      startedAt: this.startedAt,
      at: new Date().toISOString(),
    };
    await this.redis.client.set(
      heartbeatKey(this.workerId),
      JSON.stringify(payload),
      'EX',
      heartbeatTtlSeconds(this.env.WORKER_HEARTBEAT_INTERVAL_MS),
    );
  }
}
