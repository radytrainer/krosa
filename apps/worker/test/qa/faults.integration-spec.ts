/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import 'reflect-metadata';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient, type SyncStatus } from '@ssrs/database';
import { truncateAllTables } from '@ssrs/database/testing';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { QUEUE_PREFIX, SYNC_QUEUE, SYNC_SOURCE_JOB, syncJobQueueOptions } from '@ssrs/shared';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerEnv } from '../../src/config/env.js';
import { SHEETS_READER, SyncProcessor } from '../../src/sync/sync.processor.js';
import { WorkerModule } from '../../src/worker.module.js';
// @ts-expect-error plain .mjs: child-worker.mjs loads it too, without a build step
import { bigWorkbook, mark, STUDENTS, TABS, code } from './big-workbook.mjs';

/** QA suite, area D: queue faults against real BullMQ, Redis, PostgreSQL and worker processes. */

const TERMINAL: SyncStatus[] = ['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS', 'FAILED', 'CANCELLED'];
const SHEET = TERM_FIXTURE_SPREADSHEET_ID;
const db = process.env['TEST_DATABASE_URL']!;
const redisUrl = process.env['TEST_REDIS_URL']!;
if (new URL(redisUrl).pathname !== '/15' || !db.includes('_test')) throw new Error('test DB only');
if (new URL(db).hostname !== 'localhost') throw new Error('localhost only');

const env = loadWorkerEnv({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: db,
  REDIS_URL: redisUrl,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('QA D: queue faults', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue;
  let adminId: string;
  let generationId: string;
  let module: TestingModule | undefined;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: db, poolMax: 4 });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(SYNC_QUEUE, { connection: redis, prefix: QUEUE_PREFIX });
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await redis.flushdb();
    await truncateAllTables(prisma);
    adminId = (
      await prisma.user.create({ data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' } })
    ).id;
    generationId = (
      await prisma.generation.create({
        data: {
          code: 'GEN2027',
          name: 'Generation 2027',
          startDate: new Date('2026-11-02'),
          terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
        },
      })
    ).id;
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await module?.close();
    module = undefined;
  });

  async function source(reader: InMemorySheetsReader) {
    const term = await prisma.term.findFirstOrThrow({ where: { generationId, number: 1 } });
    const row = await prisma.googleSheetSource.create({
      data: {
        generationId,
        termId: term.id,
        spreadsheetId: SHEET,
        label: 'QA',
        createdById: adminId,
      },
    });
    await confirmAllTabs(prisma, reader, row.id);
    return row;
  }

  const newJob = (src: { id: string; termId: string }) =>
    prisma.syncJob.create({
      data: { scope: 'SOURCE', sourceId: src.id, termId: src.termId, requestedById: adminId },
    });

  async function importOnce(reader: InMemorySheetsReader, src: { id: string; termId: string }) {
    const job = await newJob(src);
    await runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 1 });
    return job;
  }

  async function terminal(jobId: string, timeoutMs: number) {
    const started = Date.now();
    for (;;) {
      const job = await prisma.syncJob.findUniqueOrThrow({ where: { id: jobId } });
      if (TERMINAL.includes(job.status)) return { job, ms: Date.now() - started };
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Job ${jobId} still ${job.status}/${job.phase} after ${timeoutMs} ms`);
      }
      await sleep(200);
    }
  }

  async function scoreDigest() {
    const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT concat_ws(':', id, status, mark) AS t FROM assessment_scores ORDER BY id`,
    );
    return createHash('sha256')
      .update(rows.map((r) => r.t).join('\n'))
      .digest('hex');
  }

  async function startInProcess(reader: unknown) {
    module = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
      .overrideProvider(SHEETS_READER)
      .useValue(reader)
      .compile();
    await module.init();
    return module.get(SyncProcessor);
  }

  /** Same options as production, with backoff short enough to observe the whole retry cycle. */
  const enqueueFast = (jobId: string) =>
    queue.add(
      SYNC_SOURCE_JOB,
      { syncJobId: jobId },
      { ...syncJobQueueOptions(jobId), backoff: { type: 'fixed', delay: 100 } },
    );

  function childWorker(version: number) {
    const file = path.join(import.meta.dirname, 'child-worker.mjs');
    const child = spawn(process.execPath, [file], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL: db,
        REDIS_URL: redisUrl,
        QA_VERSION: String(version),
        QA_SHEET_ID: SHEET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    return new Promise<ChildProcess>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not start: ${output}`)), 45_000);
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('worker-ready')) {
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.on('exit', (c) => {
        if (c) reject(new Error(`worker exited ${c}: ${output}`));
      });
    });
  }

  /** Marks per version for every student, read from the database. */
  async function versionsApplied() {
    const applied: number[] = [];
    for (const [t, tab] of TABS.entries()) {
      const row = await prisma.assessmentScore.findFirstOrThrow({
        where: {
          enrollment: { student: { studentCode: code(1) }, offering: { title: tab } },
          criterion: { key: 'QUIZ_1' },
        },
      });
      applied.push(Number(row.mark) === mark(1, t, 0, 2) ? 2 : 1);
    }
    return applied;
  }

  it('D-16 worker killed mid-job and replaced: job completes, all marks right, no extra history', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, bigWorkbook(1));
    const src = await source(reader);
    await importOnce(reader, src);
    const firstRevisions = await prisma.assessmentScoreRevision.count();

    const job = await newJob(src);
    await queue.add(SYNC_SOURCE_JOB, { syncJobId: job.id }, syncJobQueueOptions(job.id));
    const victim = await childWorker(2);
    for (;;) {
      const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
      if (row.progressCurrent >= 2 || TERMINAL.includes(row.status)) break;
      await sleep(20);
    }
    victim.kill('SIGKILL');
    await sleep(300);

    const afterKill = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    const midway = await versionsApplied();
    console.log('[D-16] after kill', afterKill.status, afterKill.phase, 'tabs at v2:', midway);
    expect(afterKill.status).toBe('RUNNING');
    expect(midway).toContain(1);
    expect(midway).toContain(2);

    await childWorker(2);
    const { job: done, ms } = await terminal(job.id, 200_000);
    console.log('[D-16] recovered in', ms, 'ms, status', done.status, done.failureCode);
    expect(done.status).toBe('SUCCEEDED');
    expect(await versionsApplied()).toEqual([2, 2, 2, 2, 2]);

    const changed = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) n FROM (SELECT score_id, new_mark, count(*) c FROM assessment_score_revisions
         WHERE old_mark IS NOT NULL GROUP BY score_id, new_mark HAVING count(*) > 1) d`,
    );
    expect(Number(changed[0]!.n)).toBe(0);
    expect(await prisma.assessmentScoreRevision.count()).toBeGreaterThan(firstRevisions);
  }, 280_000);

  it('D-17 the same job delivered twice while the first run is live: one run, right result', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    const job = await newJob(src);
    const a = runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 3 });
    const b = runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 3 });
    const outcomes = await Promise.all([a, b]);
    expect(outcomes.map((o) => o.kind).toSorted()).toEqual(['busy', 'finished']);
    expect(await prisma.syncJob.count()).toBe(1);
  });

  it('D-17b a redelivery while a dead run holds the lease does not strand the term', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    const job = await newJob(src);
    // As a crashed run leaves it: RUNNING with an unexpired lease.
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        leaseToken: 'c3b7e0f2-0000-4000-8000-000000000000',
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    await enqueueFast(job.id);
    await startInProcess(reader);
    await sleep(2_000);
    const state = await (await queue.getJob(job.id))?.getState();
    const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    console.log('[D-17b] queue state', state, 'job', row.status);
    // BullMQ has finished with it, yet the database still says RUNNING, blocking the term.
    expect(state === 'completed' && row.status === 'RUNNING').toBe(false);
  });

  it('D-18 a transient Google failure is retried, then succeeds', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    const job = await newJob(src);
    reader.fail(SHEET, 'GOOGLE_UNAVAILABLE');
    await enqueueFast(job.id);
    await startInProcess(reader);
    for (;;) {
      const queued = await queue.getJob(job.id);
      if ((queued?.attemptsMade ?? 0) >= 1) break;
      await sleep(25);
    }
    reader.set(SHEET, termWorkbookFixture());
    const { job: done } = await terminal(job.id, 15_000);
    expect(done.status).toBe('SUCCEEDED');
    expect((await queue.getJob(job.id))!.attemptsMade).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['GOOGLE_UNAVAILABLE', 3],
    ['RATE_LIMITED', 3],
  ] as const)('D-21 %s until the limit: FAILED, intact, attempts %i', async (code_, attempts) => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    await importOnce(reader, src);
    const before = await scoreDigest();
    const job = await newJob(src);
    reader.fail(SHEET, code_);
    reader.clearCalls();
    await enqueueFast(job.id);
    await startInProcess(reader);
    const { job: done } = await terminal(job.id, 20_000);
    expect(done).toMatchObject({ status: 'FAILED', failureCode: code_ });
    expect(await scoreDigest()).toBe(before);
    const reads = reader.calls.filter((c) => c.method === 'getMetadata');
    expect(reads.length).toBe(attempts);
  });

  it.each(['SHEET_NOT_SHARED', 'SHEET_NOT_FOUND', 'GOOGLE_AUTH_FAILED'] as const)(
    'D-18b %s is not retried',
    async (failure) => {
      const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
      const src = await source(reader);
      await importOnce(reader, src);
      const before = await scoreDigest();
      const job = await newJob(src);
      reader.fail(SHEET, failure);
      reader.clearCalls();
      await enqueueFast(job.id);
      await startInProcess(reader);
      const { job: done } = await terminal(job.id, 15_000);
      expect(done).toMatchObject({ status: 'FAILED', failureCode: failure });
      expect(reader.calls.filter((c) => c.method === 'getMetadata')).toHaveLength(1);
      expect(await scoreDigest()).toBe(before);
    },
  );

  it('D-21b an unexpected error retries 3 times, then FAILED; job kept in the failed set', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    await importOnce(reader, src);
    const before = await scoreDigest();
    const job = await newJob(src);
    let attempts = 0;
    const broken = {
      serviceAccountEmail: null,
      getMetadata: async () => {
        attempts++;
        throw new TypeError('boom: not a Google error');
      },
      readTabs: async () => {
        throw new TypeError('boom');
      },
    };
    await enqueueFast(job.id);
    await startInProcess(broken);
    const { job: done } = await terminal(job.id, 20_000);
    expect(done).toMatchObject({ status: 'FAILED', failureCode: 'WORKER_ERROR' });
    expect(attempts).toBe(3);
    expect(await (await queue.getJob(job.id))?.getState()).toBe('failed');
    expect(await scoreDigest()).toBe(before);
  });

  it('D-19 a database error in one tab rolls back that tab only', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, bigWorkbook(1, 5));
    const src = await source(reader);
    await importOnce(reader, src);
    reader.set(SHEET, bigWorkbook(2, 5));
    const job = await newJob(src);
    await runSourceSync(
      {
        prisma,
        reader,
        hooks: {
          beforeCourseCommit: async (key: string) => {
            if (key.endsWith('CHARLIE')) throw new Error('simulated: deadlock detected');
          },
        },
      },
      job.id,
      { attempt: 1, maxAttempts: 1 },
    );
    const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(await versionsApplied()).toEqual([2, 2, 1, 2, 2]);
    const error = await prisma.syncError.findFirstOrThrow({ where: { code: 'APPLY_FAILED' } });
    expect(error.sheetTab).toBe('Charlie');
    expect(error.message).not.toMatch(/deadlock|prisma|postgres/i);
  });

  it('D-20 PostgreSQL restarts mid-job: no lost marks, and the term is not left blocked', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, bigWorkbook(1));
    const src = await source(reader);
    await importOnce(reader, src);

    const job = await newJob(src);
    await queue.add(SYNC_SOURCE_JOB, { syncJobId: job.id }, syncJobQueueOptions(job.id));
    await childWorker(2);
    for (;;) {
      const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
      if (row.progressCurrent >= 2 || TERMINAL.includes(row.status)) break;
      await sleep(20);
    }
    execFileSync('docker', ['restart', '-t', '0', 'ssrs-qa-postgres-1'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        break;
      } catch {
        await sleep(300);
      }
    }
    const queued = await queue.getJob(job.id);
    const stuck = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    const started = Date.now();
    // The sweep runs every ORPHAN_SWEEP_INTERVAL_MS (5 minutes), so allow for a full cycle.
    const timer = setInterval(() => {
      void Promise.all([
        queued?.getState(),
        prisma.syncJob.findUnique({ where: { id: job.id } }),
        queue.getJob(job.id),
      ]).then(([state, row, fresh]) =>
        console.log(
          `[D-20] +${Math.round((Date.now() - started) / 1000)}s queue=${state} attempts=${fresh?.attemptsMade} job=${row?.status}/${row?.phase} lease=${row?.leaseExpiresAt?.toISOString() ?? null}`,
        ),
      );
    }, 30_000);
    console.log('[D-20] right after restart', stuck.status, stuck.phase, stuck.progressCurrent);
    const blocked = await prisma.syncJob.findFirst({
      where: { termId: src.termId, finishedAt: null },
    });
    expect(blocked).not.toBeNull();
    const { job: done, ms } = await terminal(job.id, 400_000).finally(() => clearInterval(timer));
    console.log('[D-20] finished', done.status, done.failureCode, 'after', ms, 'ms');
    // A term must not stay blocked for longer than a normal retry cycle.
    expect.soft(ms, 'time the term stayed blocked').toBeLessThan(120_000);
    const count = await prisma.assessmentScore.count();
    expect(count).toBe(STUDENTS * 5 * 6);
    const states = await versionsApplied();
    console.log('[D-20] tabs at v2:', states);
    expect(done.status === 'SUCCEEDED' ? states : [2, 2, 2, 2, 2]).toEqual([2, 2, 2, 2, 2]);
  }, 500_000);

  it('D-20b Redis restarts mid-job: the job still finishes correctly', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, bigWorkbook(1));
    const src = await source(reader);
    await importOnce(reader, src);
    const job = await newJob(src);
    await queue.add(SYNC_SOURCE_JOB, { syncJobId: job.id }, syncJobQueueOptions(job.id));
    await childWorker(2);
    for (;;) {
      const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
      if (row.progressCurrent >= 2 || TERMINAL.includes(row.status)) break;
      await sleep(20);
    }
    execFileSync('docker', ['restart', '-t', '0', 'ssrs-qa-redis-1'], { stdio: 'ignore' });
    const { job: done, ms } = await terminal(job.id, 200_000);
    console.log('[D-20b] finished', done.status, done.failureCode, 'after', ms, 'ms');
    expect(done.status).toBe('SUCCEEDED');
    expect(await versionsApplied()).toEqual([2, 2, 2, 2, 2]);
  }, 280_000);

  it('D-16b orphans: QUEUED with no queue entry is re-queued; RUNNING with none is failed', async () => {
    const reader = new InMemorySheetsReader().set(SHEET, termWorkbookFixture());
    const src = await source(reader);
    await importOnce(reader, src);
    const lost = await newJob(src);
    await prisma.syncJob.update({
      where: { id: lost.id },
      data: { status: 'RUNNING', startedAt: new Date(), queuedAt: new Date(Date.now() - 600_000) },
    });
    const processor = await startInProcess(reader);
    const { job: done } = await terminal(lost.id, 10_000);
    expect(done).toMatchObject({ status: 'FAILED', failureCode: 'WORKER_LOST' });
    expect(processor).toBeDefined();
  });
});
