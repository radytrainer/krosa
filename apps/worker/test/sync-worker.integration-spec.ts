import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PrismaClient, SyncStatus } from '@ssrs/database';
import { truncateAllTables } from '@ssrs/database/testing';
import {
  FIXTURE_SPREADSHEET_ID,
  InMemorySheetsReader,
  workbookFixture,
} from '@ssrs/sheets/testing';
import { QUEUE_PREFIX, SYNC_QUEUE, SYNC_SOURCE_JOB, syncJobQueueOptions } from '@ssrs/shared';
import { loadRootEnv } from '@ssrs/shared/node';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerEnv } from '../src/config/env.js';
import { PrismaService } from '../src/infra/prisma.service.js';
import { SHEETS_READER } from '../src/sync/sync.processor.js';
import { WorkerModule } from '../src/worker.module.js';

const TERMINAL: SyncStatus[] = ['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

function testEnv() {
  loadRootEnv();
  const db = process.env['TEST_DATABASE_URL'];
  const redis = process.env['TEST_REDIS_URL'];
  if (!db || !redis || new URL(redis).pathname !== '/15') {
    throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL (database 15) must be set');
  }
  return loadWorkerEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db,
    REDIS_URL: redis,
  });
}

describe('Sync worker (integration)', () => {
  const env = testEnv();
  let redis: Redis;
  let queue: Queue;
  let worker: TestingModule | undefined;
  let prisma: PrismaClient;
  let reader: InMemorySheetsReader;
  let adminId: string;
  let generationId: string;

  async function startWorker() {
    worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
      .overrideProvider(SHEETS_READER)
      .useValue(reader)
      .compile();
    await worker.init();
    prisma = worker.get(PrismaService).client;
  }

  async function createSource(spreadsheetId: string) {
    return prisma.googleSheetSource.create({
      data: { generationId, spreadsheetId, label: spreadsheetId.slice(0, 8), createdById: adminId },
    });
  }

  async function waitForTerminal(jobId: string, timeoutMs = 20_000) {
    const started = Date.now();
    for (;;) {
      const job = await prisma.syncJob.findUniqueOrThrow({ where: { id: jobId } });
      if (TERMINAL.includes(job.status)) return job;
      if (Date.now() - started > timeoutMs) throw new Error(`Job ${jobId} still ${job.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function seed() {
    await truncateAllTables(prisma);
    adminId = (
      await prisma.user.create({ data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' } })
    ).id;
    generationId = (
      await prisma.generation.create({
        data: {
          code: 'GEN2026',
          name: 'Generation 2026',
          startDate: new Date('2026-01-05'),
          terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
        },
      })
    ).id;
  }

  beforeAll(async () => {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(SYNC_QUEUE, { connection: redis, prefix: QUEUE_PREFIX });
  });

  beforeEach(async () => {
    await redis.flushdb();
    reader = new InMemorySheetsReader().set(FIXTURE_SPREADSHEET_ID, workbookFixture('GEN2026'));
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
  });

  it('processes a queued job end to end through BullMQ', async () => {
    await startWorker();
    await seed();
    const source = await createSource(FIXTURE_SPREADSHEET_ID);
    const job = await prisma.syncJob.create({
      data: { scope: 'SOURCE', sourceId: source.id, requestedById: adminId },
    });

    await queue.add(SYNC_SOURCE_JOB, { syncJobId: job.id }, syncJobQueueOptions(job.id));
    const done = await waitForTerminal(job.id);

    expect(done.status).toBe('SUCCEEDED');
    expect(await prisma.student.count()).toBe(3);
    expect(await prisma.assessmentScore.count()).toBe(29);
    const queued = await queue.getJob(job.id);
    expect(await queued?.getState()).toBe('completed');
  });

  it('recovers orphaned jobs at startup', async () => {
    // Seed with a throwaway context, then start the worker so recovery sees the orphans.
    await startWorker();
    await seed();
    const lostSource = await createSource('1LostSpreadsheetId00000000000000000000000');
    const queuedSource = await createSource(FIXTURE_SPREADSHEET_ID);
    const lost = await prisma.syncJob.create({
      data: {
        scope: 'SOURCE',
        sourceId: lostSource.id,
        requestedById: adminId,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    const waiting = await prisma.syncJob.create({
      data: { scope: 'SOURCE', sourceId: queuedSource.id, requestedById: adminId },
    });
    await worker!.close();

    await startWorker();
    const lostAfter = await waitForTerminal(lost.id);
    expect(lostAfter).toMatchObject({ status: 'FAILED', failureCode: 'WORKER_LOST' });
    const waitingAfter = await waitForTerminal(waiting.id);
    expect(waitingAfter.status).toBe('SUCCEEDED');
  });
});
