import {
  InMemorySheetsReader,
  LOGIC_COMMENT,
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
import { testAdminPassword, testStudentPassword } from './support/credentials.js';

const ADMIN = { username: 'admin', password: testAdminPassword() };
const STUDENT_PASSWORD = testStudentPassword();
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

/** The PL tab's comment counts in a preview summary. */
const plTab = (summary: { tabs: { tabName: string; comments: unknown }[] }) =>
  summary.tabs.find((t) => t.tabName === 'PL')!.comments;

/** Sheet B: the same workbook, with one changed Logic mark for student 001. */
function sheetB() {
  const sheet = termWorkbookFixture();
  sheet.title = 'Sheet B';
  sheet.tabs['Logic']![1]![5] = 55;
  return sheet;
}

/** Sheet B with a subject no other sheet has. */
const withScience = () => {
  const sheet = sheetB();
  sheet.tabs['Science'] = [
    ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
    ['PNC2027-001', 'DARA', 'SOK', 88],
  ];
  return sheet;
};

/** A sheet without one student, in every tab. */
const dropFromSheet = (sheet: ReturnType<typeof sheetB>, code: string) => {
  for (const [tab, rows] of Object.entries(sheet.tabs)) {
    if (tab !== '_meta') sheet.tabs[tab] = rows.filter((r) => r[0] !== code);
  }
  return sheet;
};
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

  const offering = () => ctx.prisma.courseOffering.findFirst({ where: { title: 'Science' } });

  /** What the Sync Center's "Workbooks by term" shows for this term: the sheet waiting, if any. */
  const waiting = async () => {
    const rows = (await admin.get(`${V1}/term-workbooks`).expect(200)).body as {
      term: { id: string };
      pending: { id: string } | null;
      runningJobId: string | null;
    }[];
    const row = rows.find((r) => r.term.id === termId)!;
    return { pending: row.pending?.id ?? null, running: row.runningJobId };
  };

  const previewOf = async () =>
    (await admin.post(`${V1}/sources/${sourceA}/preview`).expect(201)).body.summary;

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
    const { replacement, rosterCheck } = preview.summary;
    await admin
      .post(`${V1}/sources/${sourceId}/preview/${preview.id}/confirm`, {
        // A sheet replacement is confirmed by typing the term label (decisions.md RP3).
        ...(replacement ? { confirmTermLabel: replacement.termLabel } : {}),
        ...(rosterCheck ? { rosterChecked: true } : {}),
      })
      .expect(200);
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

  describe('teacher comments', () => {
    const KHMER = 'ពូកែណាស់ សូមបន្ត 👏🏽';

    it('counts new, changed, cleared and too-long comments in the preview', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['PL']![1]![10] = 'Much improved.'; // S1: changed
      sheet.tabs['PL']![2]![10] = KHMER; // S2: new
      sheet.tabs['Logic']![1]![12] = 'x'.repeat(4001); // S1: too long
      reader.set(SHEET_A, sheet);
      const preview = (await admin.post(`${V1}/sources/${sourceA}/preview`).expect(201)).body;
      const summary = preview.summary;
      expect(summary.scores).toEqual({ new: 0, changed: 0, unchanged: MARKS, invalid: 0 });
      expect(plTab(summary)).toEqual({ new: 1, changed: 1, cleared: 0, unchanged: 0, tooLong: 0 });
      expect(summary.comments).toEqual({
        new: 1,
        changed: 1,
        cleared: 0,
        unchanged: 0,
        tooLong: 1,
      });
      const warnings = await admin
        .get(`${V1}/sources/${sourceA}/preview/${preview.id}/issues?severity=WARNING`)
        .expect(200);
      expect(warnings.body.data).toContainEqual(
        expect.objectContaining({ code: 'COMMENT_TOO_LONG', sheetTab: 'Logic', rowNumber: 2 }),
      );

      const blank = termWorkbookFixture();
      blank.tabs['PL']![1]![10] = null;
      reader.set(SHEET_A, blank);
      expect(plTab(await previewOf())).toMatchObject({ cleared: 1, unchanged: 0 });
    });

    it('shows the synced comment to the right student only, and a re-sync changes nothing', async () => {
      const sheet = termWorkbookFixture();
      sheet.tabs['ENG']![3]![23] = KHMER; // S1's ENG row
      reader.set(SHEET_A, sheet);
      const job = await sync(sourceA);
      expect(job.counts.enrollments.commentsUpdated).toBe(1);

      const res = (await student.get('/api/v1/student/me/results').expect(200)).body;
      const byTitle = Object.fromEntries(
        res.terms[0].courses.map((c: { title: string; teacherComment: string | null }) => [
          c.title,
          c.teacherComment,
        ]),
      );
      expect(byTitle).toMatchObject({
        ENG: KHMER,
        PL: 'Works well in a team.',
        Logic: LOGIC_COMMENT,
        BCU: null,
      });

      const other = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-002' },
      });
      const issued = await admin.post(`${V1}/students/${other.id}/reset-password`).expect(200);
      const s2 = api(await login(ctx, 'PNC2027-002', issued.body.temporaryPassword));
      await s2
        .post('/api/v1/auth/change-password', {
          currentPassword: issued.body.temporaryPassword,
          newPassword: STUDENT_PASSWORD,
        })
        .expect(204);
      const s2Body = JSON.stringify((await s2.get('/api/v1/student/me/results').expect(200)).body);
      expect(s2Body).not.toContain(KHMER);
      expect(s2Body).not.toContain('Works well in a team.');

      const again = await sync(sourceA);
      expect(again.counts.enrollments.commentsUpdated).toBe(0);
      expect(plTab(await previewOf())).toEqual({
        new: 0,
        changed: 0,
        cleared: 0,
        unchanged: 1,
        tooLong: 0,
      });
    });
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

    it('refuses the sheet that is already active', async () => {
      const res = await admin
        .post(`${V1}/terms/${termId}/sources/check`, { url: urlFor(SHEET_A) })
        .expect(409);
      expect(res.body.error.code).toBe('SAME_SHEET');
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

    it('keeps _meta for another term a hard error, and the active sheet stays active', async () => {
      const wrong = sheetB();
      wrong.tabs['_meta']![3]![1] = 2;
      reader.set(SHEET_B, wrong);
      expect((await change().expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await ctx.prisma.googleSheetSource.count()).toBe(1);
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
      // With a Term 2 _meta the sheet passes the term check and reaches the "already used" rule.
      const term2Meta = termWorkbookFixture();
      term2Meta.tabs['_meta']![3]![1] = 2;
      reader.set(SHEET_A, term2Meta);
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
      const term2Sheet = termWorkbookFixture();
      term2Sheet.tabs['_meta']![3]![1] = 2;
      reader.set(SHEET_C, term2Sheet);
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
      expect(summary.canConfirm).toBe(false);
      expect(summary.students).toEqual({ new: 0, changed: 0, unchanged: 2, invalid: 0 });
      // Another spreadsheet replaces the term's data, so every mark it holds is new.
      expect(summary.scores).toMatchObject({ new: 12, changed: 0, unchanged: 0, invalid: 0 });
      expect(summary.tabs).toEqual([
        expect.objectContaining({
          tabName: 'Logic',
          status: 'OK',
          scores: { new: 12, changed: 0, unchanged: 0, invalid: 0 },
        }),
      ]);
      expect(summary.unmappedTabs).toEqual(expect.arrayContaining(['ENG', 'Extra']));
      expect(summary.comparison.blockers).toEqual(
        expect.arrayContaining([
          'Tab "ENG" has no confirmed subject. Confirm or ignore it first.',
          'Tab "Extra" has no confirmed subject. Confirm or ignore it first.',
        ]),
      );
      expect(summary.comparison.removed.map((r: { subject: string }) => r.subject)).toEqual([
        'MsOffice',
      ]);
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

  describe('a subject that only the new sheet has', () => {
    it('does not exist until the sync, and Discard leaves nothing behind', async () => {
      reader.set(SHEET_B, withScience());
      const source = (await change().expect(201)).body as { id: string };
      await reviewTabs(source.id);
      const preview = await previewAndConfirm(source.id);
      expect(
        preview.summary.tabs.find((t: { tabName: string }) => t.tabName === 'Science').scores.new,
      ).toBe(1);
      expect(await offering()).toBeNull();
      await admin.post(`${V1}/sources/${source.id}/discard`).expect(200);
      expect(await offering()).toBeNull();
    });

    it('is created by the sync, and later syncs of the sheet keep working', async () => {
      reader.set(SHEET_B, withScience());
      const id = await readyToSync();
      expect((await sync(id)).status).toBe('SUCCEEDED');
      const created = await offering();
      expect(created).toMatchObject({ sourceId: id, visibility: 'VISIBLE', sheetTab: 'Science' });
      const science = await ctx.prisma.sheetTabMapping.findFirstOrThrow({
        where: { sourceId: id, tabName: 'Science' },
        include: { columns: true },
      });
      expect(science).toMatchObject({ offeringId: created?.id, proposedTitle: null });
      const marks = science.columns.filter((c) => c.role === 'CRITERION');
      expect(marks.every((c) => c.criterionId && c.proposedKey === null)).toBe(true);
      const again = await sync(id);
      expect(again.status).toBe('SUCCEEDED');
      expect(again.counts.scores).toMatchObject({ created: 0, updated: 0 });
    });
  });

  describe('syncing the new sheet', () => {
    it('promotes it on completion; the term is replaced, so history starts from the new sheet', async () => {
      const pending = await readyToSync();
      const job = await sync(pending);
      expect(job).toMatchObject({ status: 'SUCCEEDED', errorCount: 0 });
      // Another spreadsheet replaces the term's data: every mark is created again.
      expect(job.counts.scores).toMatchObject({ updated: 0, created: MARKS, unchanged: 0 });
      expect(job.counts.replacement).toMatchObject({ scoreRows: MARKS, accounts: 0 });

      expect(await statusOf(SHEET_B)).toBe('ACTIVE');
      expect(await statusOf(SHEET_A)).toBe('DISABLED');
      // Finished: nothing is waiting to be synced any more, and no sync is running.
      expect(await waiting()).toEqual({ pending: null, running: null });
      const score = await quiz1();
      expect(score.mark.toString()).toBe('55');
      const history = await ctx.prisma.assessmentScoreRevision.findMany({
        where: { scoreId: score.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => [h.oldMark?.toString() ?? null, h.newMark.toString()])).toEqual([
        [null, '55'],
      ]);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.promoted' },
      });
      expect(audit).toMatchObject({ actorType: 'USER' });
      expect(audit.actorUserId).not.toBeNull();
      expect(audit.metadata).toMatchObject({
        oldSourceId: sourceA,
        newSourceId: pending,
        oldSpreadsheetId: SHEET_A,
        newSpreadsheetId: SHEET_B,
        deleted: { subjects: 0, scoreRows: MARKS, accounts: 0 },
      });
      // Counts only: no student IDs or names in the entry.
      expect(JSON.stringify(audit.metadata)).not.toMatch(/PNC2027-/);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'subject.archived' } })).toBe(0);

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
      // A failed sync leaves the sheet waiting: the "not synced yet" notice stays.
      expect(await waiting()).toEqual({ pending, running: null });
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
      expect(await waiting()).toEqual({ pending, running: null });
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
      expect(await waiting()).toEqual({ pending, running: null });
      expect((await quiz1()).mark.toString()).toBe('90');
    });

    it('refuses a sync whose skipped students changed since the preview', async () => {
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
      // The student no longer belongs to this generation, so the students losing this term's data
      // are not the ones the admin confirmed: nothing is deleted or imported (decisions.md RP3).
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'REPLACEMENT_CHANGED' });
      expect((await quiz1()).mark.toString()).toBe('90');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(MARKS);
    });

    it('deletes a missing student data, and the account when it has no other term', async () => {
      const edited = sheetB();
      edited.tabs['ALL']!.splice(5, 1); // PNC2027-003
      edited.tabs['Logic']!.splice(3, 1);
      edited.tabs['PL']!.splice(3, 1);
      reader.set(SHEET_B, edited);
      const pending = await readyToSync();
      const missing = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-003' },
        include: { user: true },
      });
      const session = await ctx.prisma.authSession.create({
        data: { userId: missing.userId, expiresAt: new Date(Date.now() + 3_600_000) },
      });
      const job = await sync(pending);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.counts.replacement).toMatchObject({ accounts: 1 });
      expect(
        await ctx.prisma.assessmentScore.count({
          where: { enrollment: { studentId: missing.id } },
        }),
      ).toBe(0);
      expect(await ctx.prisma.student.count({ where: { id: missing.id } })).toBe(0);
      expect(await ctx.prisma.user.count({ where: { id: missing.userId } })).toBe(0);
      // Sessions and refresh tokens go with the account (cascade).
      expect(await ctx.prisma.authSession.findUnique({ where: { id: session.id } })).toBeNull();
      expect(await ctx.prisma.assessmentScore.count()).toBeLessThan(MARKS);
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

  describe('a replacement (decisions.md RP1–RP4)', () => {
    const S2 = 'PNC2027-002';

    it('deletes nothing when the data to delete changed after the preview', async () => {
      const pending = await readyToSync();
      const enrollment = await ctx.prisma.enrollment.findFirstOrThrow({
        where: { teacherComment: null },
      });
      await ctx.prisma.enrollment.update({
        where: { id: enrollment.id },
        data: { teacherComment: 'Added after the preview' },
      });
      const job = await sync(pending);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'REPLACEMENT_CHANGED' });
      expect(await statusOf(SHEET_B)).toBe('PENDING');
      expect(await statusOf(SHEET_A)).toBe('ACTIVE');
      expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(MARKS);
      expect((await quiz1()).mark.toString()).toBe('90');
    });

    it('recreates a student listed under another name, revoking the old sessions', async () => {
      const edited = sheetB();
      edited.tabs['ALL']![4]![2] = 'RENAMED';
      reader.set(SHEET_B, edited);
      const old = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: S2 } });
      const session = await ctx.prisma.authSession.create({
        data: { userId: old.userId, expiresAt: new Date(Date.now() + 3_600_000) },
      });
      await ctx.prisma.auditLog.create({
        data: { actorType: 'USER', actorUserId: old.userId, action: 'test.deleted_actor' },
      });
      const source = (await change(SHEET_B).expect(201)).body as { id: string };
      await reviewTabs(source.id);
      const preview = await previewAndConfirm(source.id);
      expect(preview.summary.nameMismatches).toEqual([]);
      expect(preview.summary.replacement.students.accountsDeleted).toEqual([
        { studentCode: S2, fullName: expect.any(String) },
      ]);
      expect(preview.summary.replacement.students.added).toBe(1);

      const { jobId } = (
        await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: source.id }).expect(202)
      ).body;
      const outcome = await runJob(jobId);
      expect(outcome).toMatchObject({ kind: 'finished', status: 'SUCCEEDED' });
      expect(outcome).toHaveProperty('revokedSessionIds', [session.id]);

      const fresh = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: S2 },
        include: { user: true },
      });
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.lastName).toBe('RENAMED');
      expect(fresh.provisionedSourceId).toBe(source.id);
      expect(fresh.user).toMatchObject({ status: 'PENDING', mustChangePassword: true });
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      expect(job.counts.newStudents.ids).toEqual([fresh.id]);
      expect(job.counts.replacement).toMatchObject({ accounts: 1 });

      // The audit entry outlives the account; the list says who only while the account exists.
      const logs = (await admin.get(`${V1}/audit-logs?action=test.deleted_actor`).expect(200)).body
        .data;
      expect(logs).toEqual([expect.objectContaining({ actorUserId: old.userId, actor: null })]);
    });

    it('lists a name in another order as a warning and keeps the stored name', async () => {
      await sync(await readyToSync());
      const edited = termWorkbookFixture();
      edited.title = 'Sheet C';
      const row = edited.tabs['ALL']![4]!;
      [row[1], row[2]] = [row[2]!, row[1]!];
      reader.set(SHEET_C, edited);
      const source = (await change(SHEET_C).expect(201)).body as { id: string };
      await reviewTabs(source.id);
      const preview = await previewAndConfirm(source.id);
      expect(preview.summary.nameOrderWarnings).toEqual([
        expect.objectContaining({ studentCode: S2, sheetTab: 'ALL' }),
      ]);
      expect(preview.summary.replacement.students.accountsDeleted).toEqual([]);
      expect(preview.summary.canConfirm).toBe(true);
    });
  });

  async function replace(sheet: ReturnType<typeof sheetB>) {
    reader.set(SHEET_B, sheet);
    const source = (await change(SHEET_B).expect(201)).body as { id: string };
    await reviewTabs(source.id);
    const preview = await previewAndConfirm(source.id);
    return { preview: preview.summary, job: await sync(source.id) };
  }
  async function editName(code: string) {
    const s = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: code } });
    await admin.patch(`${V1}/students/${s.id}/name`, { lastName: 'EDITED' }).expect(200);
    const edited = await ctx.prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(edited.nameEditedAt).not.toBeNull();
    return edited;
  }

  const scoresOf = (studentId: string) =>
    ctx.prisma.assessmentScore.count({ where: { enrollment: { studentId } } });

  describe('protected accounts (decisions.md RP10)', () => {
    const S1 = 'PNC2027-001'; // signed in (beforeEach)
    const S3 = 'PNC2027-003';
    it('keeps a signed-in student missing from the new sheet; only the term data goes', async () => {
      const before = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: S1 } });
      const { preview, job } = await replace(dropFromSheet(sheetB(), S1));
      expect(preview.replacement.students.accountsProtected).toEqual([
        { studentCode: S1, fullName: before.fullName, reason: 'LOGGED_IN' },
      ]);
      expect(preview.replacement.students.accountsDeleted).toEqual([]);
      expect(preview.replacement.counts).toMatchObject({ accounts: 0, accountsProtected: 1 });
      expect(job.status).toBe('SUCCEEDED');
      expect(await ctx.prisma.student.count({ where: { id: before.id } })).toBe(1);
      expect(await scoresOf(before.id)).toBe(0);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.promoted' },
      });
      expect(audit.metadata).toMatchObject({ deleted: { accounts: 0, accountsProtected: 1 } });
    });

    it('skips a signed-in student under another name, keeping the account and its id', async () => {
      const before = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: S1 } });
      const sheet = sheetB();
      sheet.tabs['ALL']![3]![2] = 'OTHERNAME';
      const { preview, job } = await replace(sheet);
      expect(preview.replacement.students.accountsProtected).toEqual([
        expect.objectContaining({ studentCode: S1, reason: 'LOGGED_IN' }),
      ]);
      expect(preview.nameMismatches).toEqual([expect.objectContaining({ studentCode: S1 })]);
      expect(preview.canConfirm).toBe(true);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      const errors = (await admin.get(`${V1}/sync/${job.id}/errors?pageSize=100`).expect(200)).body
        .data as { code: string; studentCode: string | null }[];
      expect(errors.filter((e) => e.studentCode === S1).map((e) => e.code)).toEqual([
        'STUDENT_NAME_MISMATCH',
      ]);
      const after = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: S1 },
        select: { id: true, fullName: true },
      });
      expect(after.id).toBe(before.id);
      // Compared as a boolean so a failure never prints the name.
      expect(after.fullName === before.fullName).toBe(true);
      expect(await scoresOf(before.id)).toBe(0);
    });

    it('keeps a student whose name was edited when missing from the new sheet', async () => {
      const edited = await editName(S3);
      const { preview, job } = await replace(dropFromSheet(sheetB(), S3));
      expect(preview.replacement.students.accountsProtected).toEqual([
        { studentCode: S3, fullName: edited.fullName, reason: 'NAME_EDITED' },
      ]);
      expect(preview.replacement.counts.accountsProtected).toBe(1);
      expect(job.status).toBe('SUCCEEDED');
      expect(await ctx.prisma.student.count({ where: { id: edited.id } })).toBe(1);
      expect(await scoresOf(edited.id)).toBe(0);
    });

    it('skips a student whose name was edited when the sheet still has the old name', async () => {
      const edited = await editName(S3);
      const { preview, job } = await replace(sheetB());
      expect(preview.replacement.students.accountsProtected).toEqual([
        expect.objectContaining({ studentCode: S3, reason: 'NAME_EDITED' }),
      ]);
      expect(preview.nameMismatches).toEqual([expect.objectContaining({ studentCode: S3 })]);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      const after = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: S3 },
        select: { id: true, lastName: true },
      });
      expect(after).toEqual({ id: edited.id, lastName: 'EDITED' });
      expect(await scoresOf(edited.id)).toBe(0);
    });
  });

  describe('the roster check on confirm (decisions.md RP5)', () => {
    it('needs rosterChecked when students are missing or new: 422 ROSTER_CHECK_REQUIRED', async () => {
      const source = (await change(SHEET_B).expect(201)).body as { id: string };
      await reviewTabs(source.id);
      const preview = (await admin.post(`${V1}/sources/${source.id}/preview`).expect(201)).body;
      // Term 1 has no roster check; give the stored preview one, as a Term 2 preview would have.
      await ctx.prisma.sheetPreview.update({
        where: { id: preview.id },
        data: {
          summary: {
            ...preview.summary,
            rosterCheck: {
              earlierTerms: [1],
              missing: [{ studentCode: 'PNC2027-099', fullName: 'X', lastTerm: 1 }],
              new: [],
            },
          },
        },
      });
      const url = `${V1}/sources/${source.id}/preview/${preview.id}/confirm`;
      const label = { confirmTermLabel: preview.summary.replacement.termLabel };
      for (const body of [label, { ...label, rosterChecked: false }]) {
        const res = await admin.post(url, body).expect(422);
        expect(res.body.error.code).toBe('ROSTER_CHECK_REQUIRED');
      }
      await admin.post(url, { ...label, rosterChecked: true }).expect(200);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.preview.confirmed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.metadata).toMatchObject({ rosterCheck: { missing: 1, new: 0 } });
    });
  });

  describe('editing a stored name (decisions.md RP8)', () => {
    it('changes the name, audits old and new, and bumps the cache version', async () => {
      const s = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-002' },
      });
      const before = (
        await ctx.prisma.generation.findUniqueOrThrow({ where: { id: generationId } })
      ).cacheVersion;
      const url = `${V1}/students/${s.id}/name`;
      await admin.patch(url, {}).expect(422);
      await admin.patch(url, { firstName: '' }).expect(400);
      await admin.patch(url, { lastName: 'X'.repeat(201) }).expect(400);
      for (const lastName of ['TAB\tNAME', 'ZERO\u200BWIDTH']) {
        const res = await admin.patch(url, { lastName }).expect(422);
        expect(res.body.error.code).toBe('INVALID_NAME');
      }
      await student.patch(url, { lastName: 'NEW' }).expect(403);

      const view = (await admin.patch(url, { firstName: ' FIRST ', lastName: 'LAST' }).expect(200))
        .body;
      expect(view).toMatchObject({ firstName: 'FIRST', lastName: 'LAST', fullName: 'FIRST LAST' });
      expect((await admin.get(`${V1}/students/${s.id}`).expect(200)).body).toMatchObject({
        firstName: 'FIRST',
        lastName: 'LAST',
      });
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'student.name.changed', entityId: s.id },
      });
      expect(audit.metadata).toEqual({
        old: { firstName: s.firstName, lastName: s.lastName, fullName: s.fullName },
        new: { firstName: 'FIRST', lastName: 'LAST', fullName: 'FIRST LAST' },
      });
      expect(
        (await ctx.prisma.generation.findUniqueOrThrow({ where: { id: generationId } }))
          .cacheVersion,
      ).toBe(before + 1);
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
