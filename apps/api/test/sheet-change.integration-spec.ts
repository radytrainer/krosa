import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const STUDENT_PASSWORD = 'River-Lantern-Morning-48';
const V1 = '/api/v1/admin';
const SHEET_A = TERM_FIXTURE_SPREADSHEET_ID;
const SHEET_B = '1NewTermWorkbookSheetB000000000000000000';
const SHEET_C = '1NewTermWorkbookSheetC000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const MARKS = 74;

interface Column {
  columnIndex: number;
  headerLabel: string;
  role: string;
  proposedName: string | null;
  proposedWeight: string | null;
}
interface Tab {
  id: string;
  tabName: string;
  status: string;
  columns: Column[];
  carriedFrom: { subject: string; headersMatch: boolean } | null;
}

/** Sheet B: the same workbook, with one changed Logic mark for student 001. */
function sheetB() {
  const sheet = termWorkbookFixture();
  sheet.title = 'Sheet B';
  sheet.tabs['Logic']![1]![5] = 55;
  return sheet;
}

describe('Changing the sheet of a term (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let student: ReturnType<typeof api>;
  let termId: string;
  let generationId: string;
  let sourceA: string;

  const runJob = (jobId: string, deps = {}) =>
    runSourceSync({ prisma: ctx.prisma, reader, ...deps }, jobId, { attempt: 1, maxAttempts: 1 });

  const results = async () =>
    (await student.get('/api/v1/student/me/results').expect(200)).body as unknown;

  const quiz1 = async () => {
    const score = await ctx.prisma.assessmentScore.findFirstOrThrow({
      where: {
        enrollment: { student: { studentCode: 'PNC2027-001' } },
        criterion: { key: 'QUIZ_1', offering: { externalKey: 'T1-LOGIC' } },
      },
    });
    return score;
  };

  const statusOf = async (spreadsheetId: string) =>
    (await ctx.prisma.googleSheetSource.findUniqueOrThrow({ where: { spreadsheetId } })).status;

  const change = (id = SHEET_B, label = 'Sheet B') =>
    admin.post(`${V1}/terms/${termId}/sources/change`, { url: urlFor(id), label });

  /** Detects the tabs of a pending sheet and confirms all of them with what was carried over. */
  async function reviewTabs(sourceId: string) {
    await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
    const tabs = (await admin.get(`${V1}/sources/${sourceId}/mappings`).expect(200)).body as Tab[];
    for (const tab of tabs) {
      await admin
        .post(`${V1}/sources/${sourceId}/mappings/${tab.id}/confirm`, {
          subjectName: tab.carriedFrom?.subject ?? tab.tabName,
          columns: tab.columns.map((c) => ({
            columnIndex: c.columnIndex,
            role: c.role,
            ...(c.role === 'CRITERION' ? { name: c.proposedName, weight: c.proposedWeight } : {}),
          })),
        })
        .expect(200);
    }
    return tabs;
  }

  async function previewAndConfirm(sourceId: string) {
    const preview = (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201)).body;
    await admin.post(`${V1}/sources/${sourceId}/preview/${preview.id}/confirm`).expect(200);
    return preview;
  }

  /** A pending sheet B, reviewed and with a confirmed preview, ready to sync. */
  async function readyToSync(id = SHEET_B) {
    const source = (await change(id).expect(201)).body as { id: string };
    await reviewTabs(source.id);
    await previewAndConfirm(source.id);
    return source.id;
  }

  async function sync(sourceId: string, deps = {}) {
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runJob(jobId, deps);
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
  }

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader
      .set(SHEET_A, termWorkbookFixture())
      .set(SHEET_B, sheetB())
      .set(SHEET_C, termWorkbookFixture())
      .clearCalls();
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
    termId = terms.body[0].id;
    sourceA = (
      await admin
        .post(`${V1}/terms/${termId}/sources`, { url: urlFor(SHEET_A), label: 'Sheet A' })
        .expect(201)
    ).body.id;
    await confirmAllTabs(ctx.prisma, reader, sourceA);
    await sync(sourceA);
    await admin.post(`${V1}/terms/${termId}/release`, { visible: true }).expect(200);

    const row = await ctx.prisma.student.findUniqueOrThrow({
      where: { studentCode: 'PNC2027-001' },
    });
    const issued = await admin.post(`${V1}/students/${row.id}/reset-password`).expect(200);
    student = api(await login(ctx, 'PNC2027-001', issued.body.temporaryPassword));
    await student
      .post('/api/v1/auth/change-password', {
        currentPassword: issued.body.temporaryPassword,
        newPassword: STUDENT_PASSWORD,
      })
      .expect(204);
  });

  describe('checking a sheet', () => {
    it('shows the workbook name and tabs, and changes nothing', async () => {
      const res = await admin
        .post(`${V1}/terms/${termId}/sources/check`, { url: urlFor(SHEET_B) })
        .expect(200);
      expect(res.body).toEqual({
        spreadsheetId: SHEET_B,
        spreadsheetTitle: 'Sheet B',
        tabs: ['_meta', 'ALL', 'Logic', 'ENG', 'PL', 'BCU', 'MsOffice'],
      });
      expect(await ctx.prisma.googleSheetSource.count()).toBe(1);
    });

    it('rejects invalid links and unreadable sheets with a clear code', async () => {
      const bad = await admin
        .post(`${V1}/terms/${termId}/sources/check`, { url: 'not a url' })
        .expect(422);
      expect(bad.body.error.code).toBe('INVALID_URL');
      reader.fail(SHEET_B, 'SHEET_NOT_SHARED');
      const closed = await change().expect(422);
      expect(closed.body.error.code).toBe('SHEET_NOT_SHARED');
    });

    it('keeps _meta for another term a hard error', async () => {
      const wrong = sheetB();
      wrong.tabs['_meta']![3]![1] = 2;
      reader.set(SHEET_B, wrong);
      expect((await change().expect(422)).body.error.code).toBe('TERM_MISMATCH');
    });
  });

  describe('switching', () => {
    it('leaves student scores identical until a sync completes', async () => {
      const before = await results();
      const source = (await change().expect(201)).body;
      expect(source).toMatchObject({ status: 'PENDING', label: 'Sheet B' });
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      await reviewTabs(source.id);
      await previewAndConfirm(source.id);
      expect(await results()).toEqual(before);

      const [row] = (await admin.get(`${V1}/term-workbooks`).expect(200)).body.filter(
        (r: { term: { id: string } }) => r.term.id === termId,
      );
      expect(row).toMatchObject({
        active: { label: 'Sheet A' },
        pending: { label: 'Sheet B', previewState: 'CONFIRMED' },
        runningJobId: null,
      });
    });

    it('records each switch in the audit log, with no secrets', async () => {
      await change().expect(201);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.switched' },
      });
      expect(audit).toMatchObject({ actorType: 'USER', entityType: 'source' });
      expect(audit.metadata).toMatchObject({
        termId,
        oldSpreadsheetId: SHEET_A,
        newSpreadsheetId: SHEET_B,
      });
    });

    it('is rejected while a sync of the term is running', async () => {
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA }).expect(202);
      const res = await change().expect(409);
      expect(res.body.error.code).toBe('SYNC_IN_PROGRESS');
      expect(await ctx.prisma.googleSheetSource.count()).toBe(1);
    });

    it('keeps one running sync per term across the active and pending sheets', async () => {
      const pending = await readyToSync();
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA }).expect(202);
      const res = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: pending })
        .expect(409);
      expect(res.body.error.code).toBe('SYNC_IN_PROGRESS');
    });

    it('refuses the active sheet itself, and a sheet used by another term', async () => {
      expect((await change(SHEET_A).expect(409)).body.error.code).toBe('SAME_SHEET');
      // Without _meta the sheet passes the term check and reaches the "already used" rule.
      const noMeta = termWorkbookFixture();
      delete noMeta.tabs['_meta'];
      reader.set(SHEET_A, noMeta);
      const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
      const term2 = terms.body[1].id as string;
      const res = await admin
        .post(`${V1}/terms/${term2}/sources/change`, { url: urlFor(SHEET_A), label: 'x' })
        .expect(409);
      expect(res.body.error.code).toBe('SOURCE_EXISTS');
    });

    it('removing a synced sheet keeps scores, and a new sheet then goes through review', async () => {
      const before = await results();
      await admin.patch(`${V1}/sources/${sourceA}`, { status: 'DISABLED' }).expect(200);
      expect(await results()).toEqual(before);

      const source = (await change().expect(201)).body as { id: string };
      expect(await statusOf(SHEET_B)).toBe('PENDING');
      const tabs = await reviewTabs(source.id);
      expect(tabs.find((t) => t.tabName === 'Logic')?.carriedFrom?.subject).toBe('Logic');
      await previewAndConfirm(source.id);
      expect(await results()).toEqual(before);

      await sync(source.id);
      expect(await statusOf(SHEET_B)).toBe('ACTIVE');
      expect(await statusOf(SHEET_A)).toBe('DISABLED');
      expect(await results()).not.toEqual(before);
    });

    it('cannot remove the active sheet while a new sheet is waiting', async () => {
      await change().expect(201);
      const res = await admin.patch(`${V1}/sources/${sourceA}`, { status: 'DISABLED' }).expect(409);
      expect(res.body.error.code).toBe('PENDING_SHEET_EXISTS');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
    });

    it('a never-synced term can connect the same sheet again after removing it', async () => {
      const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
      const term2 = terms.body[1].id as string;
      const connect = () =>
        admin.post(`${V1}/terms/${term2}/sources`, { url: urlFor(SHEET_C), label: 'Term 2' });
      const noMeta = termWorkbookFixture();
      delete noMeta.tabs['_meta'];
      reader.set(SHEET_C, noMeta);
      const source = (await connect().expect(201)).body as { id: string; status: string };
      await admin.patch(`${V1}/sources/${source.id}`, { status: 'DISABLED' }).expect(200);
      const again = (await connect().expect(201)).body as { id: string; status: string };
      expect(again).toMatchObject({ id: source.id, status: 'ACTIVE' });
    });

    it('closes the old path: a synced term cannot swap sheets by disabling', async () => {
      await admin.patch(`${V1}/sources/${sourceA}`, { status: 'DISABLED' }).expect(200);
      const res = await admin
        .post(`${V1}/terms/${termId}/sources`, { url: urlFor(SHEET_B), label: 'Sneaky' })
        .expect(409);
      expect(res.body.error.code).toBe('USE_CHANGE_SHEET');
      const back = await admin.patch(`${V1}/sources/${sourceA}`, { status: 'ACTIVE' }).expect(409);
      expect(back.body.error.code).toBe('USE_CHANGE_SHEET');
    });

    it('discards a pending sheet and replaces it with a newer one', async () => {
      const source = (await change().expect(201)).body;
      await change(SHEET_C, 'Sheet C').expect(201);
      expect(await statusOf(SHEET_B)).toBe('DISABLED');
      expect(await statusOf(SHEET_C)).toBe('PENDING');

      const pending = await ctx.prisma.googleSheetSource.findUniqueOrThrow({
        where: { spreadsheetId: SHEET_C },
      });
      await admin.post(`${V1}/sources/${pending.id}/discard`).expect(200);
      expect(await statusOf(SHEET_C)).toBe('DISABLED');
      expect(
        (await admin.post(`${V1}/sources/${source.id}/discard`).expect(409)).body.error.code,
      ).toBe('NOT_PENDING');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
    });
  });

  describe('reviewing', () => {
    it('carries over mappings by tab name but asks for confirmation', async () => {
      const source = (await change().expect(201)).body;
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      const tabs = (await admin.get(`${V1}/sources/${source.id}/mappings`).expect(200))
        .body as Tab[];
      expect(tabs.every((t) => t.status === 'DRAFT')).toBe(true);
      const office = tabs.find((t) => t.tabName === 'MsOffice')!;
      expect(office.carriedFrom).toEqual({ subject: 'MsOffice', headersMatch: true });
      expect(office.columns.find((c) => c.headerLabel === 'MS WORD')).toMatchObject({
        proposedWeight: '30',
      });
    });

    it('flags a tab whose headers differ from the active sheet', async () => {
      const edited = sheetB();
      edited.tabs['PL']![0]![5] = 'Quiz one 20%';
      reader.set(SHEET_B, edited);
      const source = (await change().expect(201)).body;
      const detected = await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      const pl = detected.body.tabs.find((t: { tabName: string }) => t.tabName === 'PL');
      expect(pl.mapping.carriedFrom).toEqual({ subject: 'PL', headersMatch: false });
    });

    it('rejects a sync with no preview, or a preview that is not confirmed', async () => {
      const source = (await change().expect(201)).body;
      await reviewTabs(source.id);
      const none = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: source.id })
        .expect(422);
      expect(none.body.error.code).toBe('PREVIEW_REQUIRED');

      await admin.post(`${V1}/sources/${source.id}/preview`).expect(201);
      const unconfirmed = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: source.id })
        .expect(422);
      expect(unconfirmed.body.error.code).toBe('PREVIEW_REQUIRED');
    });

    it('never accepts a preview of one sheet for another', async () => {
      await readyToSync();
      const sheetC = (await change(SHEET_C, 'Sheet C').expect(201)).body;
      await reviewTabs(sheetC.id);
      const res = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sheetC.id })
        .expect(422);
      expect(res.body.error.code).toBe('PREVIEW_REQUIRED');
      expect(
        (await admin.post(`${V1}/sources/${sourceA}/preview`).expect(409)).body.error.code,
      ).toBe('NOT_PENDING');
    });

    it('discards a preview when a tab is reviewed again or the old sheet syncs', async () => {
      const pending = await readyToSync();
      const tabs = (await admin.get(`${V1}/sources/${pending}/mappings`).expect(200)).body as Tab[];
      await admin.post(`${V1}/sources/${pending}/mappings/${tabs[0]!.id}/reopen`).expect(200);
      expect(
        (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: pending }).expect(422)).body
          .error.code,
      ).toBe('PREVIEW_REQUIRED');

      await reviewTabs(pending);
      await previewAndConfirm(pending);
      await sync(sourceA);
      expect(
        (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: pending }).expect(422)).body
          .error.code,
      ).toBe('PREVIEW_REQUIRED');
    });

    it('shows the impact: counts, tab problems and missing students', async () => {
      const edited = sheetB();
      edited.tabs['ALL']!.splice(5, 1); // PNC2027-003 leaves the roster
      edited.tabs['Logic']!.splice(3, 1);
      edited.tabs['PL']!.splice(3, 1);
      edited.tabs['Extra'] = [['STUDENT ID', 'Project 100%']];
      delete edited.tabs['MsOffice'];
      reader.set(SHEET_B, edited);
      const source = (await change().expect(201)).body;
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      const tabs = (await admin.get(`${V1}/sources/${source.id}/mappings`).expect(200))
        .body as Tab[];
      const logic = tabs.find((t) => t.tabName === 'Logic')!;
      await admin
        .post(`${V1}/sources/${source.id}/mappings/${logic.id}/confirm`, {
          subjectName: 'Logic',
          columns: logic.columns.map((c) => ({
            columnIndex: c.columnIndex,
            role: c.role,
            ...(c.role === 'CRITERION' ? { name: c.proposedName, weight: c.proposedWeight } : {}),
          })),
        })
        .expect(200);

      const { summary } = (await admin.post(`${V1}/sources/${source.id}/preview`).expect(201)).body;
      expect(summary.canConfirm).toBe(true);
      expect(summary.students).toEqual({ new: 0, changed: 0, unchanged: 2, invalid: 0 });
      expect(summary.scores).toMatchObject({ new: 0, changed: 1, unchanged: 11, invalid: 0 });
      expect(summary.tabs).toEqual([
        expect.objectContaining({
          tabName: 'Logic',
          status: 'OK',
          scores: { new: 0, changed: 1, unchanged: 11, invalid: 0 },
        }),
      ]);
      expect(summary.unmappedTabs).toEqual(expect.arrayContaining(['ENG', 'Extra']));
      expect(summary.subjectsNotInSheet).toEqual(expect.arrayContaining(['MsOffice', 'PL']));
      expect(summary.missingStudents).toEqual({
        total: 1,
        sample: [{ studentCode: 'PNC2027-003', fullName: 'RITHY KEO' }],
      });
      expect(await quiz1()).toMatchObject({ status: 'RECORDED' });
      expect((await quiz1()).mark.toString()).toBe('90');
    });

    it('will not confirm a preview that shows errors', async () => {
      const edited = sheetB();
      edited.tabs['Logic']![1]![5] = 120;
      reader.set(SHEET_B, edited);
      const source = (await change().expect(201)).body;
      await reviewTabs(source.id);
      const preview = (await admin.post(`${V1}/sources/${source.id}/preview`).expect(201)).body;
      expect(preview.summary.canConfirm).toBe(false);
      expect(preview.summary.scores.invalid).toBe(1);
      expect(preview.summary.tabs).toContainEqual(
        expect.objectContaining({ tabName: 'Logic', status: 'INVALID' }),
      );
      const res = await admin
        .post(`${V1}/sources/${source.id}/preview/${preview.id}/confirm`)
        .expect(422);
      expect(res.body.error.code).toBe('PREVIEW_HAS_ERRORS');
    });
  });

  describe('syncing the new sheet', () => {
    it('promotes it on completion, with score history for every change', async () => {
      const pending = await readyToSync();
      const job = await sync(pending);
      expect(job).toMatchObject({ status: 'SUCCEEDED', errorCount: 0 });
      expect(job.counts.scores).toMatchObject({ updated: 1, created: 0, unchanged: MARKS - 1 });

      expect(await statusOf(SHEET_B)).toBe('ACTIVE');
      expect(await statusOf(SHEET_A)).toBe('DISABLED');
      const score = await quiz1();
      expect(score.mark.toString()).toBe('55');
      const history = await ctx.prisma.assessmentScoreRevision.findMany({
        where: { scoreId: score.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => [h.oldMark?.toString() ?? null, h.newMark.toString()])).toEqual([
        [null, '90'],
        ['90', '55'],
      ]);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.promoted' },
      });
      expect(audit.metadata).toMatchObject({
        oldSpreadsheetId: SHEET_A,
        newSpreadsheetId: SHEET_B,
      });

      const shown = (await student.get('/api/v1/student/me/results?term=1').expect(200)).body;
      const logic = shown.terms[0].courses.find((c: { title: string }) => c.title === 'Logic');
      expect(logic.finalScore).toBe('75.40');
    });

    it('leaves everything unchanged when the sync fails partway', async () => {
      const before = await results();
      const pending = await readyToSync();
      const job = await sync(pending, {
        hooks: {
          beforeCourseCommit: (courseKey: string) => {
            if (courseKey === 'T1-ENG') throw new Error('simulated failure');
          },
        },
      });
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_CHANGE_REJECTED' });
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await statusOf(SHEET_B)).toBe('PENDING');
      expect((await quiz1()).mark.toString()).toBe('90');
      expect(await results()).toEqual(before);
      expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(MARKS);
    });

    it('leaves everything unchanged when the job was cancelled', async () => {
      const before = await results();
      const pending = await readyToSync();
      const { jobId } = (
        await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: pending }).expect(202)
      ).body;
      await ctx.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      await runJob(jobId);
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await statusOf(SHEET_B)).toBe('PENDING');
      expect(await results()).toEqual(before);
    });

    it('refuses a sheet edited after its preview was confirmed', async () => {
      const pending = await readyToSync();
      const edited = sheetB();
      edited.tabs['Logic']![1]![5] = 60;
      reader.set(SHEET_B, edited);
      const job = await sync(pending);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'PREVIEW_STALE' });
      expect(await statusOf(SHEET_B)).toBe('PENDING');
      expect((await quiz1()).mark.toString()).toBe('90');
    });

    it('rolls back on a rejection the preview could not foresee', async () => {
      const pending = await readyToSync();
      // Between the preview and the sync, a student comes to belong to another generation.
      const other = await ctx.prisma.generation.create({
        data: { code: 'GEN2030', name: 'Other', startDate: new Date('2030-01-07') },
      });
      await ctx.prisma.student.update({
        where: { studentCode: 'PNC2027-002' },
        data: { generationId: other.id },
      });
      const job = await sync(pending);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_CHANGE_REJECTED' });
      expect((await quiz1()).mark.toString()).toBe('90');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
    });

    it('keeps a missing student scores and removes nothing', async () => {
      const edited = sheetB();
      edited.tabs['ALL']!.splice(5, 1); // PNC2027-003
      edited.tabs['Logic']!.splice(3, 1);
      edited.tabs['PL']!.splice(3, 1);
      reader.set(SHEET_B, edited);
      const pending = await readyToSync();
      const job = await sync(pending);
      expect(job.status).toBe('SUCCEEDED');
      const scores = await ctx.prisma.assessmentScore.count({
        where: { enrollment: { student: { studentCode: 'PNC2027-003' } } },
      });
      expect(scores).toBeGreaterThan(0);
      expect(await ctx.prisma.assessmentScore.count()).toBe(MARKS);
    });

    it('goes back to the old sheet through the same flow, without duplicating it', async () => {
      await sync(await readyToSync());
      const source = (await change(SHEET_A, 'Sheet A again').expect(201)).body;
      expect(source.id).toBe(sourceA);
      expect(await statusOf(SHEET_A)).toBe('PENDING');
      const tabs = (await admin.get(`${V1}/sources/${sourceA}/mappings`).expect(200)).body as Tab[];
      expect(tabs.every((t) => t.status === 'DRAFT')).toBe(true);
      expect(
        (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: sourceA }).expect(422)).body
          .error.code,
      ).toBe('NO_CONFIRMED_TABS');

      await reviewTabs(sourceA);
      await previewAndConfirm(sourceA);
      await sync(sourceA);
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await statusOf(SHEET_B)).toBe('DISABLED');
      expect((await quiz1()).mark.toString()).toBe('90');
      expect(await ctx.prisma.googleSheetSource.count()).toBe(2);
    });

    it('leaves pending sheets out of generation and full syncs', async () => {
      await readyToSync();
      const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'ALL' }).expect(202)).body;
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      expect(job.children.map((c: { source: { id: string } }) => c.source.id)).toEqual([sourceA]);
    });
  });

  it('is for admins only', async () => {
    const terms = `${V1}/terms/${termId}/sources`;
    await student.post(`${terms}/check`, { url: urlFor(SHEET_B) }).expect(403);
    await student.post(`${terms}/change`, { url: urlFor(SHEET_B), label: 'x' }).expect(403);
    await student.get(`${V1}/term-workbooks`).expect(403);
    await student.post(`${V1}/sources/${sourceA}/preview`).expect(403);
    await student.post(`${V1}/sources/${sourceA}/discard`).expect(403);
  });
});
