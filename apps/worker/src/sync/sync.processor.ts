import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SheetsReader } from '@ssrs/sheets';
import {
  QUEUE_PREFIX,
  SYNC_JOB_ATTEMPTS,
  SYNC_QUEUE,
  SYNC_SOURCE_JOB,
  syncJobQueueOptions,
  type SyncSourceJobData,
} from '@ssrs/shared';
import { reportError } from '@ssrs/shared/node';
import { failJob, runSourceSync, type SyncLogger } from '@ssrs/sync';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { WORKER_ENV, type WorkerEnv } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';

export const SHEETS_READER = Symbol('SHEETS_READER');

/** Queue states in which BullMQ still owns the job (it will run or is running). */
const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/**
 * The periodic sweep ignores jobs younger than this: the API records a job, then enqueues it,
 * and a job caught between the two must not be touched.
 */
export const SWEEP_GRACE_MS = 2 * 60_000;

/**
 * Consumes `sync.source` jobs. Transient Google failures are retried by BullMQ with backoff;
 * every other outcome is recorded in `sync_jobs` by the engine. BullMQ's stalled-job checks
 * hand jobs of a crashed worker to another worker; jobs that can no longer run are recovered
 * at startup (see `recoverOrphans`).
 */
@Injectable()
export class SyncProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SyncProcessor.name);
  private worker: Worker<SyncSourceJobData> | undefined;
  private connection: Redis | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(SHEETS_READER) private readonly reader: SheetsReader,
    private readonly prisma: PrismaService,
  ) {}

  private syncLogger(jobId: string): SyncLogger {
    return {
      info: (message, context) => this.logger.log({ msg: message, syncJobId: jobId, ...context }),
      warn: (message, context) => this.logger.warn({ msg: message, syncJobId: jobId, ...context }),
      error: (message, context) =>
        this.logger.error({ msg: message, syncJobId: jobId, ...context }),
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    // BullMQ workers need blocking connections that never give up on a request.
    const connection = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'ssrs-worker-bull',
    });
    this.connection = connection;
    await this.recoverOrphans(connection);
    this.worker = new Worker<SyncSourceJobData>(SYNC_QUEUE, (job) => this.process(job), {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: this.env.WORKER_CONCURRENCY,
      limiter: { max: this.env.SYNC_JOBS_PER_MINUTE, duration: 60_000 },
      lockDuration: 120_000,
    });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`Queue worker error: ${err.message}`));
    this.logger.log(`Consuming queue "${SYNC_QUEUE}" (concurrency ${this.env.WORKER_CONCURRENCY})`);

    // Startup recovery only catches orphans that exist when a worker starts. A worker that keeps
    // running re-checks periodically, so a job lost by another (crashed) worker is not left
    // RUNNING until the next deploy.
    this.sweepTimer = setInterval(() => {
      this.recoverOrphans(connection, { olderThanMs: SWEEP_GRACE_MS }).catch((err: unknown) =>
        this.logger.warn(
          `Orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.env.ORPHAN_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    // Waits for active jobs to finish; BullMQ re-delivers anything interrupted.
    await this.worker?.close();
    await this.connection?.quit().catch(() => this.connection?.disconnect());
  }

  async process(job: Job<SyncSourceJobData>): Promise<string> {
    const { syncJobId } = job.data;
    const outcome = await runSourceSync(
      { prisma: this.prisma.client, reader: this.reader, logger: this.syncLogger(syncJobId) },
      syncJobId,
      { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? SYNC_JOB_ATTEMPTS },
    );
    if (outcome.kind === 'retry') {
      // Throwing hands the job back to BullMQ, which retries it after the backoff delay.
      throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    if (outcome.kind === 'busy') {
      // A duplicate delivery while another run holds the job's lease. That run owns the outcome;
      // if it has in fact died, the orphan sweep marks the job WORKER_LOST.
      this.logger.warn({ msg: 'Duplicate delivery ignored; job is running elsewhere', syncJobId });
      return 'BUSY';
    }
    return outcome.status;
  }

  /** After the final attempt of an unexpected error, make sure the job is not left RUNNING. */
  private async onFailed(job: Job<SyncSourceJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? SYNC_JOB_ATTEMPTS;
    this.logger.warn({
      msg: 'Sync attempt failed',
      syncJobId: job.data.syncJobId,
      attempt: job.attemptsMade,
      error: err.message,
    });
    if (job.attemptsMade >= attempts) {
      reportError(err, { service: 'worker', syncJobId: job.data.syncJobId });
      await failJob(
        this.prisma.client,
        job.data.syncJobId,
        'WORKER_ERROR',
        'The sync could not be completed. Retry it; if it keeps failing, check the worker logs.',
      );
    }
  }

  /**
   * Reconciles database state with the queue at startup:
   *  - QUEUED in the database but unknown to the queue (e.g. Redis was flushed) → re-enqueue.
   *  - RUNNING in the database but no longer live in the queue (worker died after BullMQ gave
   *    up) → FAILED with WORKER_LOST; an admin can retry it safely (sync is idempotent).
   */
  async recoverOrphans(
    connection: Redis,
    options: { olderThanMs?: number } = {},
  ): Promise<{ requeued: number; failed: number }> {
    const queue = new Queue<SyncSourceJobData, string, string>(SYNC_QUEUE, {
      connection,
      prefix: QUEUE_PREFIX,
    });
    let requeued = 0;
    let failed = 0;
    try {
      const pending = await this.prisma.client.syncJob.findMany({
        where: {
          scope: 'SOURCE',
          status: { in: ['QUEUED', 'RUNNING'] },
          ...(options.olderThanMs
            ? { queuedAt: { lt: new Date(Date.now() - options.olderThanMs) } }
            : {}),
        },
        select: { id: true, status: true },
      });
      for (const job of pending) {
        const queued = await queue.getJob(job.id);
        const state = queued ? await queued.getState() : 'missing';
        if (LIVE_STATES.has(state)) continue;
        if (job.status === 'QUEUED') {
          if (queued) await queued.remove();
          await queue.add(SYNC_SOURCE_JOB, { syncJobId: job.id }, syncJobQueueOptions(job.id));
          requeued++;
        } else {
          await failJob(
            this.prisma.client,
            job.id,
            'WORKER_LOST',
            'The worker stopped while processing this job. Retry the sync.',
          );
          failed++;
        }
      }
    } finally {
      await queue.close();
    }
    if (requeued || failed)
      this.logger.warn(`Recovered sync jobs: ${requeued} re-queued, ${failed} marked failed`);
    return { requeued, failed };
  }
}
