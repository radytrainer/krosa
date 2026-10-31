/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { runSourceSync } from '@ssrs/sync';
import { termWorkbookFixture, type FakeSpreadsheet } from '@ssrs/sheets/testing';
import { confirmAllTabs } from '@ssrs/sync/testing';
import { vi } from 'vitest';
import type { TestContext } from '../support/test-app.js';
import {
  ADMIN_V1,
  confirmBody,
  createHarness,
  editedFixture,
  SHEET_A,
  SHEET_B,
  sheetUrl,
  V1,
  type Api,
  type Harness,
  type Tab,
} from './support.js';

/** QA suite, area E: Generation/Term targets, issues roll-up, changing a term's sheet. */

const CODE_1 = 'PNC2027-001';
const SHEET_T2 = '1QaTermTwoSheet0000000000000000000000000';
const SHEET_T3 = '1QaTermThreeSheet00000000000000000000000';

interface Issue {
  id: string;
  code: string;
  sheetTab: string | null;
  source: { id: string; label: string } | null;
}

/** A workbook for any term: no _meta, `bad` invalid cells on Logic. */
function sheetFor(bad: number): FakeSpreadsheet {
  const sheet = termWorkbookFixture();
  delete sheet.tabs['_meta'];
  const logic = sheet.tabs['Logic']!;
  for (let i = 0; i < bad; i++) {
    const row = logic[1 + (i % 3)]!;
    row[5 + (i % 6)] = `bad-${i}`;
  }
  return sheet;
}

describe('QA E: Sync Center', () => {
  let h: Harness;
  let ctx: TestContext;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.reset());
  afterEach(() => vi.restoreAllMocks());

  async function connectTerm(term: number, id: string, sheet: FakeSpreadsheet) {
    h.reader.set(id, sheet);
    const src = (
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.terms[term]}/sources`, {
          url: sheetUrl(id),
          label: `Term ${term}`,
        })
        .expect(201)
    ).body as { id: string };
    await confirmAllTabs(ctx.prisma, h.reader, src.id);
    return src.id;
  }

  describe('targets', () => {
    it('E-01 / E-02 targets list each generation with its own terms; a mismatch is 422', async () => {
      const other = (
        await h.admin
          .post(`${ADMIN_V1}/generations`, {
            code: 'GEN2028',
            name: 'Generation 2028',
            startDate: '2027-11-01',
          })
          .expect(201)
      ).body;
      const otherTerms = (
        await h.admin.get(`${ADMIN_V1}/generations/${other.id}/terms`).expect(200)
      ).body;
      const targets = (await h.admin.get(`${ADMIN_V1}/sync/targets`).expect(200)).body as {
        id: string;
        terms: { id: string }[];
      }[];
      const mine = targets.find((t) => t.id === h.generationId)!;
      expect(mine.terms.map((t) => t.id)).toEqual(Object.values(h.terms));

      const res = await h.admin.post(`${ADMIN_V1}/sync`, {
        scope: 'TERM',
        generationId: h.generationId,
        termId: otherTerms[0].id,
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TERM_NOT_IN_GENERATION');
    });

    it('E-02b a term with no workbook, and missing required ids, give clear errors', async () => {
      const none = await h.admin.post(`${ADMIN_V1}/sync`, {
        scope: 'TERM',
        generationId: h.generationId,
        termId: h.termId,
      });
      expect(none.status).toBe(422);
      expect(none.body.error.code).toBe('NO_WORKBOOK_FOR_TERM');
      for (const body of [
        { scope: 'TERM' },
        { scope: 'SOURCE' },
        { scope: 'GENERATION' },
        { scope: 'NOPE' },
        { scope: 'TERM', generationId: h.generationId },
        { scope: 'ALL', termNumber: 0 },
        { scope: 'ALL', termNumber: 6 },
        { scope: 'ALL', termNumber: 'one' },
      ]) {
        const res = await h.admin.post(`${ADMIN_V1}/sync`, body);
        expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(res.status, JSON.stringify(body)).toBeLessThan(500);
        expect(res.status, JSON.stringify(body)).not.toBe(202);
      }
    });

    it('E-03 all generations + term 2 covers exactly the term 2 sources', async () => {
      await connectTerm(1, SHEET_A, sheetFor(0));
      const t2 = await connectTerm(2, SHEET_T2, sheetFor(0));
      const { jobId } = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'ALL', termNumber: 2 }).expect(202)
      ).body;
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(job.children.map((c: { source: { id: string } }) => c.source.id)).toEqual([t2]);
      expect(job.termNumber).toBe(2);
      for (const c of job.children) await h.runJob(c.id);
    });

    it('E-04 old jobs with no term or term number still list and open', async () => {
      const src = await connectTerm(1, SHEET_A, sheetFor(0));
      const user = await ctx.prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
      const old = await ctx.prisma.syncJob.create({
        data: {
          scope: 'SOURCE',
          sourceId: src,
          termId: null,
          status: 'SUCCEEDED',
          finishedAt: new Date('2026-01-01'),
          requestedById: user.id,
        },
      });
      const list = (await h.admin.get(`${ADMIN_V1}/sync?includeChildren=true`).expect(200)).body;
      expect(list.data.map((j: { id: string }) => j.id)).toContain(old.id);
      const one = (await h.admin.get(`${ADMIN_V1}/sync/${old.id}`).expect(200)).body;
      expect(one).toMatchObject({ id: old.id, termNumber: null, counts: expect.anything() });
    });
  });

  describe('issues roll-up', () => {
    async function twoSourceJob() {
      const a = await connectTerm(2, SHEET_T2, sheetFor(6));
      const b = await connectTerm(3, SHEET_T3, sheetFor(5));
      const { jobId } = (
        await h.admin
          .post(`${ADMIN_V1}/sync`, { scope: 'GENERATION', generationId: h.generationId })
          .expect(202)
      ).body;
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      for (const child of job.children) await h.runJob(child.id);
      const done = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      return { jobId, a, b, job: done };
    }

    const allPages = async (jobId: string, pageSize: number, filter = '') => {
      const rows: Issue[] = [];
      for (let page = 1; page < 50; page++) {
        const res = await h.admin
          .get(`${ADMIN_V1}/sync/${jobId}/errors?page=${page}&pageSize=${pageSize}${filter}`)
          .expect(200);
        rows.push(...(res.body.data as Issue[]));
        if ((res.body.data as Issue[]).length === 0) break;
      }
      return rows;
    };

    it('E-05 / E-06 / E-07 job page: all issues once; source page: only its own; totals add up', async () => {
      const { jobId, a, b, job } = await twoSourceJob();
      const first = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}/errors?pageSize=100`).expect(200))
        .body;
      const childA = job.children.find((c: { source: { id: string } }) => c.source.id === a);
      const childB = job.children.find((c: { source: { id: string } }) => c.source.id === b);
      const ownA = await allPages(childA.id, 100);
      const ownB = await allPages(childB.id, 100);

      expect(ownA.every((i) => i.source?.id === a)).toBe(true);
      expect(ownB.every((i) => i.source?.id === b)).toBe(true);
      expect(first.meta.total).toBe(ownA.length + ownB.length);
      expect(job.errorCount + job.warningCount).toBe(first.meta.total);
      expect(childA.errorCount + childA.warningCount).toBe(ownA.length);
      expect(childB.errorCount + childB.warningCount).toBe(ownB.length);
      expect(ownA.filter((i) => i.code === 'INVALID_MARK')).toHaveLength(6);
      expect(ownB.filter((i) => i.code === 'INVALID_MARK')).toHaveLength(5);
    });

    it('E-08 pagination: no duplicates or gaps at any page size, past the end is empty', async () => {
      const { jobId } = await twoSourceJob();
      const whole = await allPages(jobId, 100);
      for (const size of [1, 2, 3, 7]) {
        const paged = await allPages(jobId, size);
        expect(
          paged.map((i) => i.id),
          `pageSize ${size}`,
        ).toEqual(whole.map((i) => i.id));
      }
      const past = await h.admin.get(`${ADMIN_V1}/sync/${jobId}/errors?page=999`).expect(200);
      expect(past.body.data).toEqual([]);
      expect(past.body.meta.total).toBe(whole.length);
    });

    it('E-08b filters: severity, code, tab and source', async () => {
      const { jobId, a } = await twoSourceJob();
      const whole = await allPages(jobId, 100);
      const invalid = await allPages(jobId, 100, '&code=INVALID_MARK');
      expect(invalid).toHaveLength(whole.filter((i) => i.code === 'INVALID_MARK').length);
      const logic = await allPages(jobId, 100, '&sheetTab=Logic');
      expect(logic).toHaveLength(whole.filter((i) => i.sheetTab === 'Logic').length);
      const onlyA = await allPages(jobId, 100, `&sourceId=${a}`);
      expect(onlyA).toHaveLength(whole.filter((i) => i.source?.id === a).length);
      const bad = await h.admin.get(`${ADMIN_V1}/sync/${jobId}/errors?severity=NOPE`);
      expect(bad.status).toBe(400);
    });

    it('E-08c a busy source shows as a job-level warning and is counted', async () => {
      const a = await connectTerm(2, SHEET_T2, sheetFor(1));
      await connectTerm(3, SHEET_T3, sheetFor(1));
      const running = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: a }).expect(202)
      ).body.jobId;
      const { jobId } = (
        await h.admin
          .post(`${ADMIN_V1}/sync`, { scope: 'GENERATION', generationId: h.generationId })
          .expect(202)
      ).body;
      await h.runJob(running);
      const parent = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      for (const child of parent.children) await h.runJob(child.id);
      const done = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      const rows = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}/errors?pageSize=100`).expect(200))
        .body;
      expect(rows.data.filter((i: Issue) => i.code === 'SOURCE_BUSY')).toHaveLength(1);
      expect(done.errorCount + done.warningCount).toBe(rows.meta.total);
    });
  });

  describe('changing a term sheet', () => {
    let sourceA: string;
    let student: Api;
    const results = async () => (await student.get(`${V1}/student/me/results`).expect(200)).body;

    beforeEach(async () => {
      sourceA = await h.importSheet();
      student = await h.activate(CODE_1);
      h.reader.set(SHEET_B, {
        ...editedFixture((s) => (s.tabs['Logic']![1]![5] = 55)),
        title: 'Sheet B',
      });
    });

    const change = async () =>
      (
        await h.admin
          .post(`${ADMIN_V1}/terms/${h.termId}/sources/change`, {
            url: sheetUrl(SHEET_B),
            label: 'Sheet B',
          })
          .expect(201)
      ).body.id as string;
    const statusOf = async (spreadsheetId: string) =>
      (await ctx.prisma.googleSheetSource.findUniqueOrThrow({ where: { spreadsheetId } })).status;

    it('E-10 / D-01 every step before the sync leaves score data byte-identical', async () => {
      const start = await h.digest();
      const same = async (step: string) => {
        const now = await h.digest();
        for (const table of [
          'assessment_scores',
          'assessment_score_revisions',
          'enrollments',
          'grading_schemes',
          'grading_scheme_items',
          'students',
        ]) {
          expect(now[table], `${step}: ${table}`).toBe(start[table]);
        }
      };
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.termId}/sources/check`, { url: sheetUrl(SHEET_B) })
        .expect(200);
      await same('check');
      const id = await change();
      await same('change');
      await h.admin.post(`${ADMIN_V1}/sources/${id}/detect`).expect(200);
      await same('detect');
      await h.review(id);
      await same('confirm tabs');
      await h.previewAndConfirm(id);
      await same('preview');
    });

    it('E-11 what the student sees stays identical before the sync, for unchanged names', async () => {
      const before = await results();
      const id = await change();
      await h.review(id);
      await h.previewAndConfirm(id);
      expect(await results()).toEqual(before);
    });

    it('E-11b a renamed subject on the new sheet stays invisible until the sync (T1)', async () => {
      const before = await results();
      const id = await change();
      await h.admin.post(`${ADMIN_V1}/sources/${id}/detect`).expect(200);
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${id}/mappings`).expect(200))
        .body as Tab[];
      const logic = tabs.find((t) => t.tabName === 'Logic')!;
      const body = confirmBody(logic, 'Logic');
      body.columns = body.columns.map((c) =>
        c.role === 'CRITERION' && (c as { name?: string }).name === 'Quiz 1'
          ? { ...c, name: 'Renamed quiz' }
          : c,
      );
      await h.admin
        .post(`${ADMIN_V1}/sources/${id}/mappings/${logic.id}/confirm`, body)
        .expect(200);
      // Force a fresh read: a cached view would hide the change for up to 10 minutes.
      await ctx.redis.flushdb();
      expect(JSON.stringify(await results())).toBe(JSON.stringify(before));
    });

    it('E-22 discarding a new sheet undoes what its Confirm tab changed', async () => {
      const before = await results();
      const id = await change();
      await h.admin.post(`${ADMIN_V1}/sources/${id}/detect`).expect(200);
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${id}/mappings`).expect(200))
        .body as Tab[];
      const logic = tabs.find((t) => t.tabName === 'Logic')!;
      const body = confirmBody(logic, 'Logic');
      body.columns = body.columns.map((c) =>
        c.role === 'CRITERION' && (c as { name?: string }).name === 'Quiz 1'
          ? { ...c, name: 'Renamed quiz' }
          : c,
      );
      await h.admin
        .post(`${ADMIN_V1}/sources/${id}/mappings/${logic.id}/confirm`, body)
        .expect(200);
      await h.admin.post(`${ADMIN_V1}/sources/${id}/discard`).expect(200);
      await ctx.redis.flushdb();
      const offering = await ctx.prisma.courseOffering.findFirstOrThrow({
        where: { title: 'Logic' },
      });
      const names = await results();
      expect.soft(offering.sourceId, 'offering still points at the discarded sheet').toBe(sourceA);
      expect
        .soft(JSON.stringify(names), 'student sees the discarded name')
        .not.toContain('Renamed quiz');
      expect(JSON.stringify(names)).toBe(JSON.stringify(before));
    });

    it('E-22b the workaround: a sync of the old sheet restores names and ownership', async () => {
      const before = await results();
      const id = await change();
      await h.admin.post(`${ADMIN_V1}/sources/${id}/detect`).expect(200);
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${id}/mappings`).expect(200))
        .body as Tab[];
      const logic = tabs.find((t) => t.tabName === 'Logic')!;
      const body = confirmBody(logic, 'Logic');
      body.columns = body.columns.map((c) =>
        c.role === 'CRITERION' && (c as { name?: string }).name === 'Quiz 1'
          ? { ...c, name: 'Renamed quiz' }
          : c,
      );
      await h.admin
        .post(`${ADMIN_V1}/sources/${id}/mappings/${logic.id}/confirm`, body)
        .expect(200);
      await h.admin.post(`${ADMIN_V1}/sources/${id}/discard`).expect(200);
      await h.reader.set(SHEET_A, termWorkbookFixture());
      await h.sync(sourceA);
      const offering = await ctx.prisma.courseOffering.findFirstOrThrow({
        where: { title: 'Logic' },
      });
      expect(offering.sourceId).toBe(sourceA);
      const names = (r: {
        terms: {
          courses: {
            title: string;
            criteria: { name: string; order: number; contribution: string }[];
            finalScore: string;
            schemeVersion: number;
          }[];
        }[];
      }) =>
        r.terms.flatMap((t) =>
          t.courses.map((c) => ({
            title: c.title,
            total: c.finalScore,
            version: c.schemeVersion,
            criteria: c.criteria.map((x) => `${x.order}:${x.name}:${x.contribution}`),
          })),
        );
      expect(names(await results())).toEqual(names(before));
    });

    it('E-12 sync without a preview is refused, as is an unconfirmed preview', async () => {
      const id = await change();
      await h.review(id);
      const direct = await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id });
      expect(direct.status).toBe(422);
      expect(direct.body.error.code).toBe('PREVIEW_REQUIRED');
      await h.admin.post(`${ADMIN_V1}/sources/${id}/preview`).expect(201);
      const unconfirmed = await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id });
      expect(unconfirmed.status).toBe(422);
    });

    it('E-13 a preview cannot be confirmed through another source', async () => {
      const id = await change();
      await h.review(id);
      const preview = (await h.admin.post(`${ADMIN_V1}/sources/${id}/preview`).expect(201)).body;
      const res = await h.admin.post(
        `${ADMIN_V1}/sources/${sourceA}/preview/${preview.id}/confirm`,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('E-15 a failure partway leaves every table and the active sheet unchanged', async () => {
      const id = await change();
      await h.review(id);
      await h.previewAndConfirm(id);
      const before = await h.digest();
      const { jobId } = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id }).expect(202)
      ).body;
      let n = 0;
      await runSourceSync(
        {
          prisma: ctx.prisma,
          reader: h.reader,
          hooks: {
            beforeCourseCommit: async () => {
              if (++n === 3) throw new Error('simulated database failure');
            },
          },
        },
        jobId,
        { attempt: 1, maxAttempts: 1 },
      );
      const job = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_CHANGE_REJECTED' });
      const after = await h.digest();
      for (const table of [
        'assessment_scores',
        'assessment_score_revisions',
        'students',
        'grading_schemes',
      ]) {
        expect(after[table], table).toBe(before[table]);
      }
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await statusOf(SHEET_B)).toBe('PENDING');
    });

    it('E-19 retry of a failed sheet change after its preview was voided is refused', async () => {
      const id = await change();
      await h.review(id);
      await h.previewAndConfirm(id);
      const sheet = editedFixture((s) => (s.tabs['Logic']![1]![5] = 56));
      h.reader.set(SHEET_B, sheet);
      const { jobId } = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id }).expect(202)
      ).body;
      await h.runJob(jobId);
      const failed = (await h.admin.get(`${ADMIN_V1}/sync/${jobId}`).expect(200)).body;
      expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'PREVIEW_STALE' });

      const before = await h.digest();
      const retry = await h.admin.post(`${ADMIN_V1}/sync/${jobId}/retry`);
      if (retry.status === 202) await h.runJob(retry.body.jobId);
      expect((await h.digest())['assessment_scores']).toBe(before['assessment_scores']);
      expect(await statusOf(SHEET_B)).toBe('PENDING');
    });

    it('E-17b the old sheet cannot sync while the new sheet syncs, and vice versa', async () => {
      const id = await change();
      await h.review(id);
      await h.previewAndConfirm(id);
      const { jobId } = (
        await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: id }).expect(202)
      ).body;
      const old = await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: sourceA });
      expect(old.status).toBe(409);
      h.reader.set('1QaYetAnotherSheet0000000000000000000000', termWorkbookFixture());
      const switching = await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/sources/change`, {
        url: sheetUrl('1QaYetAnotherSheet0000000000000000000000'),
        label: 'C',
      });
      expect(switching.status).toBe(409);
      await h.runJob(jobId);
    });

    it('E-18 each step is audited with no secrets', async () => {
      const id = await change();
      await h.review(id);
      await h.previewAndConfirm(id);
      await h.sync(id);
      const actions = (await ctx.prisma.auditLog.findMany({ select: { action: true } })).map(
        (a) => a.action,
      );
      for (const action of [
        'source.switched',
        'source.preview.run',
        'source.preview.confirmed',
        'source.promoted',
      ]) {
        expect(actions, action).toContain(action);
      }
      const logs = await ctx.prisma.auditLog.findMany();
      expect(JSON.stringify(logs)).not.toMatch(/\$argon2|password"|privateKey|temporaryPassword/i);
    });

    it('E-20 discard, preview and confirm are blocked on an archived generation (T9)', async () => {
      const id = await change();
      await h.review(id);
      const preview = (await h.admin.post(`${ADMIN_V1}/sources/${id}/preview`).expect(201)).body;
      await h.admin.post(`${ADMIN_V1}/generations/${h.generationId}/archive`).expect(200);
      // Confirm first: a second preview would void this one and hide what confirm does.
      const responses = {
        confirm: await h.admin.post(`${ADMIN_V1}/sources/${id}/preview/${preview.id}/confirm`),
        preview: await h.admin.post(`${ADMIN_V1}/sources/${id}/preview`),
        discard: await h.admin.post(`${ADMIN_V1}/sources/${id}/discard`),
      };
      expect(Object.fromEntries(Object.entries(responses).map(([k, r]) => [k, r.status]))).toEqual({
        preview: 409,
        confirm: 409,
        discard: 409,
      });
    });
  });
});
