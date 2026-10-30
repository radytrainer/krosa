import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { QUEUE_PREFIX, SYNC_QUEUE } from '@ssrs/shared';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
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
const ID = TERM_FIXTURE_SPREADSHEET_ID;
const SECOND_ID = '1SecondSpreadsheetId0000000000000000000000';
const MARKS = 74;
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
  let termIds: Record<number, string>;
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
    reader.set(ID, termWorkbookFixture()).clearCalls();
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    generationId = (
      await admin
        .post(`${V1}/generations`, {
          code: 'GEN2027',
          name: 'Generation 2027',
          startDate: '2026-11-02',
        })
        .expect(201)
    ).body.id;
    const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
    termIds = Object.fromEntries(
      (terms.body as { id: string; number: number }[]).map((t) => [t.number, t.id]),
    );
    sourceId = (
      await admin
        .post(`${V1}/terms/${termIds[1]}/sources`, { url: urlFor(ID), label: 'Term 1' })
        .expect(201)
    ).body.id;
    await confirmAllTabs(ctx.prisma, reader, sourceId);
  });

  /** A confirmed Term 2 workbook, optionally broken afterwards. */
  async function connectSecond(): Promise<string> {
    const sheet = termWorkbookFixture();
    sheet.tabs['_meta']![3]![1] = 2;
    reader.set(SECOND_ID, sheet);
    const second = (
      await admin
        .post(`${V1}/terms/${termIds[2]}/sources`, { url: urlFor(SECOND_ID), label: 'Term 2' })
        .expect(201)
    ).body.id as string;
    await confirmAllTabs(ctx.prisma, reader, second);
    return second;
  }

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
      progress: { current: 6, total: 6 },
      errorCount: 0,
      counts: { students: { created: 3 }, scores: { created: MARKS } },
    });
    expect(done.body.children).toEqual([]);

    const list = await admin.get(`${V1}/sync?status=SUCCEEDED`).expect(200);
    expect(list.body.data.map((j: { id: string }) => j.id)).toEqual([jobId]);
    const history = await admin.get(`${V1}/sources/${sourceId}/sync-history`).expect(200);
    expect(history.body.meta.total).toBe(1);
    const source = await admin.get(`${V1}/sources/${sourceId}`).expect(200);
    expect(source.body).toMatchObject({ lastSyncJobId: jobId, ownedOfferings: 5 });

    // The next sync of the same source is allowed once the previous one finished.
    await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202);
  });

  it('accepts exactly one of many simultaneous sync requests for a source', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId })),
    );
    const statuses = responses.map((r) => r.status).toSorted();
    expect(statuses).toEqual([202, 409, 409, 409, 409, 409]);
    const accepted = responses.find((r) => r.status === 202)!.body.jobId as string;
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body.error).toMatchObject({ code: 'SYNC_IN_PROGRESS', jobId: accepted });
    }
    // The partial unique index allows one unfinished job per source; the losers left no rows.
    expect(await ctx.prisma.syncJob.count({ where: { sourceId } })).toBe(1);
  });

  it('applies a job once even when it is delivered twice at the same time', async () => {
    const jobId = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202)).body
      .jobId as string;
    const outcomes = await Promise.all([runJob(jobId), runJob(jobId)]);
    // One run holds the lease; the other backs off without writing anything.
    expect(outcomes.map((o) => o.kind).toSorted()).toEqual(['busy', 'finished']);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'sync.completed', entityId: jobId } }),
    ).toBe(1);
    const done = await ctx.prisma.syncJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.status).toBe('SUCCEEDED');
    // No duplicates: one row per student and mark, one creation revision per mark.
    expect(await ctx.prisma.student.count()).toBe(3);
    expect(await ctx.prisma.assessmentScore.count()).toBe(MARKS);
    expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(MARKS);
  });

  it('exposes row-level errors and retries failed jobs as new jobs', async () => {
    const broken = termWorkbookFixture();
    broken.tabs['Logic']![1]![5] = 120;
    broken.tabs['Logic']![2]![6] = '38,5';
    reader.set(ID, broken);
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
      sheetTab: 'Logic',
      rowNumber: 2,
      criterionKey: 'QUIZ_1',
      rawValue: '120',
    });
    const filtered = await admin
      .get(`${V1}/sync/${jobId}/errors?code=INVALID_MARK&sheetTab=Logic`)
      .expect(200);
    expect(filtered.body.meta.total).toBe(2);

    reader.set(ID, termWorkbookFixture());
    const retry = await admin.post(`${V1}/sync/${jobId}/retry`).expect(202);
    expect(retry.body.jobId).not.toBe(jobId);
    await runJob(retry.body.jobId);
    const retried = (await admin.get(`${V1}/sync/${retry.body.jobId}`).expect(200)).body;
    expect(retried).toMatchObject({ status: 'SUCCEEDED', retryOfId: jobId });

    const notRetryable = await admin.post(`${V1}/sync/${retry.body.jobId}/retry`).expect(409);
    expect(notRetryable.body.error.code).toBe('JOB_NOT_RETRYABLE');
  });

  it('records a failed sync without importing anything', async () => {
    reader.fail(ID, 'SHEET_NOT_SHARED');
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runJob(jobId);
    const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_NOT_SHARED' });
    expect(job.failureMessage).toContain('ssrs-sync@example-project.iam.gserviceaccount.com');
    expect(await ctx.prisma.student.count()).toBe(0);
  });

  it('runs a generation sync as independent per-source jobs with honest aggregation', async () => {
    // The Term 2 workbook has one tab whose headers changed since it was confirmed.
    await connectSecond();
    const changed = termWorkbookFixture();
    changed.tabs['_meta']![3]![1] = 2;
    changed.tabs['Logic']![0]![5] = 'Quiz one 10%';
    reader.set(SECOND_ID, changed);

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

  /** Runs a whole-generation sync, breaking `tabs` first; returns the finished parent. */
  async function syncBroken(
    mutate: (tabs: ReturnType<typeof termWorkbookFixture>['tabs']) => void,
  ) {
    const broken = termWorkbookFixture();
    mutate(broken.tabs);
    reader.set(ID, broken);
    const { jobId } = (
      await admin.post(`${V1}/sync`, { scope: 'GENERATION', generationId }).expect(202)
    ).body;
    const queued = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
    for (const child of queued.children) await runJob(child.id);
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
  }

  describe('job issues', () => {
    it('shows no rows and a zero total for a job with no issues', async () => {
      const job = await syncBroken((tabs) => {
        tabs['BCU']![2]![1] = 'BOPHA'; // undo the fixture's swapped name
        tabs['BCU']![2]![2] = 'CHAN';
      });
      expect(job).toMatchObject({ status: 'SUCCEEDED', errorCount: 0, warningCount: 0 });
      const rows = await admin.get(`${V1}/sync/${job.id}/errors`).expect(200);
      expect(rows.body).toMatchObject({ data: [], meta: { total: 0 }, tabs: [] });
    });

    it('rolls one source issues up to the parent, without copying rows', async () => {
      const job = await syncBroken((tabs) => {
        tabs['Logic']![1]![5] = 120;
        tabs['Logic']![2]![6] = '38,5';
      });
      const issues = job.errorCount + job.warningCount;
      expect(job.errorCount).toBe(2);
      const rows = await admin.get(`${V1}/sync/${job.id}/errors`).expect(200);
      expect(rows.body.meta.total).toBe(issues);
      expect(rows.body.tabs).toEqual(['BCU', 'Logic']);
      expect(rows.body.data[0]).toMatchObject({
        severity: 'ERROR',
        code: 'INVALID_MARK',
        sheetTab: 'Logic',
        rowNumber: 2,
        source: { id: sourceId, label: 'Term 1' },
      });
      expect(await ctx.prisma.syncError.count({ where: { jobId: job.id } })).toBe(0);

      const child = await admin.get(`${V1}/sync/${job.children[0].id}/errors`).expect(200);
      expect(child.body.meta.total).toBe(issues);
    });

    it('rolls up several sources, sums totals and filters by source and tab', async () => {
      await connectSecond();
      const second = await ctx.prisma.googleSheetSource.findUniqueOrThrow({
        where: { spreadsheetId: SECOND_ID },
      });
      const broken = termWorkbookFixture();
      broken.tabs['_meta']![3]![1] = 2;
      broken.tabs['PL']![1]![5] = 500;
      reader.set(SECOND_ID, broken);

      const job = await syncBroken((tabs) => (tabs['Logic']![1]![5] = 120));
      const [one, two] = job.children;
      expect(job.errorCount).toBe(one.errorCount + two.errorCount);
      expect(job.warningCount).toBe(one.warningCount + two.warningCount);
      expect(job.errorCount).toBe(2);

      const all = await admin.get(`${V1}/sync/${job.id}/errors?pageSize=100`).expect(200);
      expect(all.body.meta.total).toBe(job.errorCount + job.warningCount);
      expect(new Set(all.body.data.map((e: { id: string }) => e.id)).size).toBe(
        all.body.meta.total,
      );

      const onlySecond = await admin
        .get(`${V1}/sync/${job.id}/errors?sourceId=${second.id}`)
        .expect(200);
      expect(onlySecond.body.meta.total).toBe(
        two.source.id === second.id
          ? two.errorCount + two.warningCount
          : one.errorCount + one.warningCount,
      );
      expect(
        onlySecond.body.data.every((e: { source: { id: string } }) => e.source.id === second.id),
      ).toBe(true);

      const byTab = await admin.get(`${V1}/sync/${job.id}/errors?sheetTab=PL`).expect(200);
      expect(byTab.body.data.map((e: { code: string }) => e.code)).toEqual(['INVALID_MARK']);

      // A source's own job lists only its own issues.
      for (const child of job.children) {
        const own = await admin.get(`${V1}/sync/${child.id}/errors?pageSize=100`).expect(200);
        expect(own.body.meta.total).toBe(child.errorCount + child.warningCount);
        for (const e of own.body.data) expect(e.source.id).toBe(child.source.id);
      }
    });

    it('paginates rolled-up issues', async () => {
      const job = await syncBroken((tabs) => {
        tabs['Logic']![1]![5] = 120;
        tabs['Logic']![1]![6] = 130;
        tabs['Logic']![1]![7] = 140;
      });
      const first = await admin.get(`${V1}/sync/${job.id}/errors?pageSize=2`).expect(200);
      const second = await admin.get(`${V1}/sync/${job.id}/errors?pageSize=2&page=2`).expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta.total).toBe(4);
      expect(second.body.data).toHaveLength(2);
      const ids = [...first.body.data, ...second.body.data].map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(4);
    });

    it('counts a job-level skipped-workbook warning, labelled with no source', async () => {
      await connectSecond();
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202); // stays queued
      const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'ALL' }).expect(202)).body;
      const queued = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      await runJob(queued.children[0].id);
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      const rows = await admin.get(`${V1}/sync/${jobId}/errors?pageSize=100`).expect(200);
      expect(rows.body.meta.total).toBe(job.errorCount + job.warningCount);
      expect(rows.body.data).toContainEqual(
        expect.objectContaining({ code: 'SOURCE_BUSY', source: null }),
      );
    });
  });

  describe('sync targets', () => {
    it('lists active generations with their terms', async () => {
      const res = await admin.get(`${V1}/sync/targets`).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: generationId, code: 'GEN2027' });
      expect(res.body[0].terms.map((t: { id: string }) => t.id)).toEqual(
        [1, 2, 3, 4, 5].map((n) => termIds[n]),
      );
    });

    it('resolves a Generation and Term pair to that term workbook', async () => {
      const { jobId } = (
        await admin
          .post(`${V1}/sync`, { scope: 'TERM', generationId, termId: termIds[1] })
          .expect(202)
      ).body;
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      expect(job).toMatchObject({
        scope: 'SOURCE',
        source: {
          id: sourceId,
          generation: { name: 'Generation 2027' },
          term: { name: 'Term 1' },
        },
      });
    });

    it('rejects a term from another generation and a term with no workbook', async () => {
      const other = (
        await admin
          .post(`${V1}/generations`, { code: 'GEN2030', name: 'Empty', startDate: '2030-01-07' })
          .expect(201)
      ).body;
      const mismatch = await admin
        .post(`${V1}/sync`, { scope: 'TERM', generationId: other.id, termId: termIds[1] })
        .expect(422);
      expect(mismatch.body.error.code).toBe('TERM_NOT_IN_GENERATION');
      expect(mismatch.body.error.message).toContain('Empty');
      const empty = await admin
        .post(`${V1}/sync`, { scope: 'TERM', generationId, termId: termIds[3] })
        .expect(422);
      expect(empty.body.error).toMatchObject({
        code: 'NO_WORKBOOK_FOR_TERM',
        message: 'Generation 2027, Term 3 has no active workbook.',
      });
      await admin.post(`${V1}/sync`, { scope: 'TERM', generationId }).expect(400);
      expect(await ctx.prisma.syncJob.count()).toBe(0);
    });

    it('syncs one term number across every active generation, and retries it the same way', async () => {
      await connectSecond();
      const { jobId } = (
        await admin.post(`${V1}/sync`, { scope: 'ALL', termNumber: 2 }).expect(202)
      ).body;
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      expect(job).toMatchObject({ scope: 'ALL', termNumber: 2 });
      expect(
        job.children.map((c: { source: { term: { number: number } } }) => c.source.term.number),
      ).toEqual([2]);

      reader.fail(SECOND_ID, 'SHEET_NOT_SHARED');
      await runJob(job.children[0].id);
      const retry = await admin.post(`${V1}/sync/${jobId}/retry`).expect(202);
      const again = (await admin.get(`${V1}/sync/${retry.body.jobId}`).expect(200)).body;
      expect(again).toMatchObject({ termNumber: 2, retryOfId: jobId });

      const none = await admin.post(`${V1}/sync`, { scope: 'ALL', termNumber: 4 }).expect(422);
      expect(none.body.error.code).toBe('NO_SOURCES');
      await admin.post(`${V1}/sync`, { scope: 'ALL', termNumber: 0 }).expect(400);
    });

    it('still opens old jobs, which have no term number', async () => {
      const old = await ctx.prisma.syncJob.create({
        data: {
          scope: 'ALL',
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          requestedById: (await ctx.prisma.user.findFirstOrThrow()).id,
        },
      });
      const job = (await admin.get(`${V1}/sync/${old.id}`).expect(200)).body;
      expect(job).toMatchObject({ termNumber: null, source: null, generation: null, children: [] });
      expect((await admin.get(`${V1}/sync/${old.id}/errors`).expect(200)).body.meta.total).toBe(0);
    });
  });

  it('skips busy sources in multi-source syncs and reports them', async () => {
    await connectSecond();
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
    expect(rows.map((r) => r['student_id'])).toEqual(['PNC2027-001', 'PNC2027-002', 'PNC2027-003']);
    expect(rows[0]).toMatchObject({ student_name: 'DARA SOK', class: 'A' });

    const session = await login(ctx, 'pnc2027-002', rows[1]!['temporary_password']!);
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
