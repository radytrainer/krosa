import {
  cloneSpreadsheet,
  FIXTURE_SPREADSHEET_ID,
  InMemorySheetsReader,
  workbookFixture,
} from '@ssrs/sheets/testing';
import { QUEUE_PREFIX, SYNC_QUEUE } from '@ssrs/shared';
import { runSourceSync } from '@ssrs/sync';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { UTF8_BOM } from '../src/common/csv.js';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const V1 = '/api/v1/admin';
const SECOND_ID = '1SecondSpreadsheetId0000000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** Parses the simple CSV produced by the API (no embedded newlines in these fixtures). */
function parseCsv(text: string): Record<string, string>[] {
  const [header, ...lines] = text.replace(UTF8_BOM, '').trim().split('\r\n');
  const keys = header!.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [keys[i]!, v])));
}

describe('Synchronization API (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;
  let sourceId: string;
  let queue: Queue;
  let queueRedis: Redis;

  /** Runs a queued job the way the worker would. */
  const runJob = (jobId: string) =>
    runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
    queueRedis = new Redis(ctx.env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(SYNC_QUEUE, { connection: queueRedis, prefix: QUEUE_PREFIX });
  });

  afterAll(async () => {
    await queue.close();
    await queueRedis.quit();
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(FIXTURE_SPREADSHEET_ID, workbookFixture('GEN2026')).clearCalls();
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    generationId = (
      await admin
        .post(`${V1}/generations`, {
          code: 'GEN2026',
          name: 'Generation 2026',
          startDate: '2026-01-05',
        })
        .expect(201)
    ).body.id;
    sourceId = (
      await admin
        .post(`${V1}/generations/${generationId}/sources`, {
          url: urlFor(FIXTURE_SPREADSHEET_ID),
          label: 'Main',
        })
        .expect(201)
    ).body.id;
  });

  it('queues a source sync, rejects overlapping requests and reports the result', async () => {
    const res = await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202);
    const jobId = res.body.jobId as string;

    const queued = await queue.getJob(jobId);
    expect(queued?.name).toBe('sync.source');
    expect(queued?.data).toEqual({ syncJobId: jobId });
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'sync.requested', entityId: jobId } }),
    ).toBe(1);

    const busy = await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(409);
    expect(busy.body.error).toMatchObject({ code: 'SYNC_IN_PROGRESS', jobId });

    const pending = await admin.get(`${V1}/sync/${jobId}`).expect(200);
    expect(pending.body).toMatchObject({
      status: 'QUEUED',
      scope: 'SOURCE',
      source: { id: sourceId },
      requestedBy: { username: 'admin' },
    });

    await runJob(jobId);
    const done = await admin.get(`${V1}/sync/${jobId}`).expect(200);
    expect(done.body).toMatchObject({
      status: 'SUCCEEDED',
      progress: { current: 3, total: 3 },
      errorCount: 0,
      counts: { students: { created: 3 }, scores: { created: 29 } },
    });
    expect(done.body.children).toEqual([]);

    const list = await admin.get(`${V1}/sync?status=SUCCEEDED`).expect(200);
    expect(list.body.data.map((j: { id: string }) => j.id)).toEqual([jobId]);
    const history = await admin.get(`${V1}/sources/${sourceId}/sync-history`).expect(200);
    expect(history.body.meta.total).toBe(1);
    const source = await admin.get(`${V1}/sources/${sourceId}`).expect(200);
    expect(source.body).toMatchObject({ lastSyncJobId: jobId, ownedOfferings: 2 });

    // The next sync of the same source is allowed once the previous one finished.
    await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202);
  });

  it('exposes row-level errors and retries failed jobs as new jobs', async () => {
    const broken = cloneSpreadsheet(workbookFixture('GEN2026'));
    broken.tabs['T1 Math']![2]![2] = 11;
    broken.tabs['T1 Math']![3]![4] = '38,5';
    reader.set(FIXTURE_SPREADSHEET_ID, broken);
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runJob(jobId);

    const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(job).toMatchObject({ status: 'SUCCEEDED_WITH_ERRORS', errorCount: 2 });
    const errors = await admin
      .get(`${V1}/sync/${jobId}/errors?severity=ERROR&pageSize=1`)
      .expect(200);
    expect(errors.body.meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(errors.body.data[0]).toMatchObject({
      code: 'INVALID_MARK',
      sheetTab: 'T1 Math',
      rowNumber: 3,
      criterionKey: 'Q1',
      rawValue: '11',
    });
    const filtered = await admin
      .get(`${V1}/sync/${jobId}/errors?code=INVALID_MARK&sheetTab=T1%20Math`)
      .expect(200);
    expect(filtered.body.meta.total).toBe(2);

    reader.set(FIXTURE_SPREADSHEET_ID, workbookFixture('GEN2026'));
    const retry = await admin.post(`${V1}/sync/${jobId}/retry`).expect(202);
    expect(retry.body.jobId).not.toBe(jobId);
    await runJob(retry.body.jobId);
    const retried = (await admin.get(`${V1}/sync/${retry.body.jobId}`).expect(200)).body;
    expect(retried).toMatchObject({ status: 'SUCCEEDED', retryOfId: jobId });

    const notRetryable = await admin.post(`${V1}/sync/${retry.body.jobId}/retry`).expect(409);
    expect(notRetryable.body.error.code).toBe('JOB_NOT_RETRYABLE');
  });

  it('records a failed sync without importing anything', async () => {
    reader.fail(FIXTURE_SPREADSHEET_ID, 'SHEET_NOT_SHARED');
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runJob(jobId);
    const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_NOT_SHARED' });
    expect(job.failureMessage).toContain('ssrs-sync@example-project.iam.gserviceaccount.com');
    expect(await ctx.prisma.student.count()).toBe(0);
  });

  it('runs a generation sync as independent per-source jobs with honest aggregation', async () => {
    // A second file in the same generation that defines the same courses: its courses are
    // rejected (owned by the first source) while its marks for the first source stay intact.
    reader.set(SECOND_ID, workbookFixture('GEN2026'));
    await admin
      .post(`${V1}/generations/${generationId}/sources`, {
        url: urlFor(SECOND_ID),
        label: 'Second',
      })
      .expect(201);

    const first = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202)).body
      .jobId;
    await runJob(first);

    const { jobId } = (
      await admin.post(`${V1}/sync`, { scope: 'GENERATION', generationId }).expect(202)
    ).body;
    const parent = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(parent).toMatchObject({
      scope: 'GENERATION',
      status: 'QUEUED',
      progress: { current: 0, total: 2 },
    });
    expect(parent.children).toHaveLength(2);
    for (const child of parent.children) expect(await queue.getJob(child.id)).toBeDefined();

    for (const child of parent.children) await runJob(child.id);
    const done = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(done.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(done.children.map((c: { status: string }) => c.status).toSorted()).toEqual([
      'SUCCEEDED',
      'SUCCEEDED_WITH_ERRORS',
    ]);

    // Top-level listing hides children unless asked.
    const top = await admin.get(`${V1}/sync?scope=GENERATION`).expect(200);
    expect(top.body.meta.total).toBe(1);
    const all = await admin.get(`${V1}/sync?includeChildren=true`).expect(200);
    expect(all.body.meta.total).toBe(4);
  });

  it('skips busy sources in multi-source syncs and reports them', async () => {
    reader.set(SECOND_ID, workbookFixture('GEN2026'));
    await admin
      .post(`${V1}/generations/${generationId}/sources`, {
        url: urlFor(SECOND_ID),
        label: 'Second',
      })
      .expect(201);
    await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202); // stays queued

    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'ALL' }).expect(202)).body;
    const parent = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(parent.children).toHaveLength(1);
    expect(parent.warningCount).toBe(1);
    const warnings = await admin.get(`${V1}/sync/${jobId}/errors`).expect(200);
    expect(warnings.body.data[0]).toMatchObject({ code: 'SOURCE_BUSY', severity: 'WARNING' });

    const allBusy = await admin.post(`${V1}/sync`, { scope: 'ALL' }).expect(409);
    expect(allBusy.body.error.code).toBe('SYNC_IN_PROGRESS');
  });

  it('validates requests', async () => {
    await admin.post(`${V1}/sync`, { scope: 'SOURCE' }).expect(400);
    await admin.post(`${V1}/sync`, { scope: 'EVERYTHING' }).expect(400);
    const empty = (
      await admin
        .post(`${V1}/generations`, { code: 'GEN2030', name: 'Empty', startDate: '2030-01-07' })
        .expect(201)
    ).body;
    expect(
      (await admin.post(`${V1}/sync`, { scope: 'GENERATION', generationId: empty.id }).expect(422))
        .body.error.code,
    ).toBe('NO_SOURCES');
    await admin.patch(`${V1}/sources/${sourceId}`, { status: 'DISABLED' }).expect(200);
    expect(
      (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(409)).body.error.code,
    ).toBe('SOURCE_DISABLED');
    await admin.get(`${V1}/sync/0199a3f0-0000-7000-8000-000000000000`).expect(404);
  });

  it('issues credentials in bulk once, as a CSV the students can sign in with', async () => {
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runJob(jobId);

    const res = await admin.post(`${V1}/students/issue-credentials`, { generationId }).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="credentials-\d{12}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-issued-count']).toBe('3');
    const rows = parseCsv(res.text);
    expect(rows.map((r) => r['student_id'])).toEqual(['GEN26-0001', 'GEN26-0002', 'GEN26-0003']);
    expect(rows[0]).toMatchObject({ student_name: 'Example Student A', class: 'A' });

    const session = await login(ctx, 'gen26-0002', rows[1]!['temporary_password']!);
    expect(session.body.user).toMatchObject({ role: 'STUDENT', mustChangePassword: true });

    // Already-issued accounts are not reset by a second run.
    const again = await admin
      .post(`${V1}/students/issue-credentials`, { generationId })
      .expect(200);
    expect(again.headers['x-issued-count']).toBe('0');

    const logs = JSON.stringify(await ctx.prisma.auditLog.findMany());
    for (const row of rows) expect(logs).not.toContain(row['temporary_password']);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'student.credentials.issued' } }),
    ).toBe(3);

    expect(
      (await admin.post(`${V1}/students/issue-credentials`, {}).expect(422)).body.error.code,
    ).toBe('SELECTION_REQUIRED');
  });

  it('is admin-only', async () => {
    await seedUser(ctx, {
      username: 'GEN26-0009',
      password: 'Student-Initial-Pass-2026',
      role: 'STUDENT',
    });
    const student = api(await login(ctx, 'GEN26-0009', 'Student-Initial-Pass-2026'));
    await student.post(`${V1}/sync`, { scope: 'ALL' }).expect(403);
    await student.get(`${V1}/sync`).expect(403);
    await student.post(`${V1}/students/issue-credentials`, { generationId }).expect(403);
  });
});
