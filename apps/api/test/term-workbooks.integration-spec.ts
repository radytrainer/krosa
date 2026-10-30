import { NotConfiguredSheetsReader } from '@ssrs/sheets';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import request from 'supertest';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  WEB_ORIGIN,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const V1 = '/api/v1/admin';
const SA_EMAIL = 'ssrs-sync@example-project.iam.gserviceaccount.com';
const ID = TERM_FIXTURE_SPREADSHEET_ID;
const OTHER_ID = '1AnotherTermWorkbook0000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

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
  version: number;
  columns: Column[];
}

const confirmUrl = (sourceId: string, tab: Tab) =>
  `${V1}/sources/${sourceId}/mappings/${tab.id}/confirm`;

/** What the review screen sends: every column as detected, with `weights` filled in by key. */
function confirmBody(tab: Tab, subjectName: string, weights: Record<string, string> = {}) {
  return {
    subjectName,
    columns: tab.columns.map((c) => ({
      columnIndex: c.columnIndex,
      role: c.role,
      ...(c.role === 'CRITERION'
        ? {
            name: c.proposedName ?? c.headerLabel,
            weight: weights[c.headerLabel] ?? c.proposedWeight ?? undefined,
          }
        : {}),
    })),
  };
}

describe('Term workbooks (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;
  let termIds: Record<number, string>;

  beforeAll(async () => {
    reader = new InMemorySheetsReader(new Map(), SA_EMAIL);
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(ID, termWorkbookFixture()).set(OTHER_ID, termWorkbookFixture()).clearCalls();
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    const gen = await admin
      .post(`${V1}/generations`, {
        code: 'GEN2027',
        name: 'Generation 2027',
        startDate: '2026-11-02',
      })
      .expect(201);
    generationId = gen.body.id;
    const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
    termIds = Object.fromEntries(
      (terms.body as { id: string; number: number }[]).map((t) => [t.number, t.id]),
    );
  });

  const connect = (term = 1, id = ID, body: object = {}) =>
    admin.post(`${V1}/terms/${termIds[term]}/sources`, {
      url: urlFor(id),
      label: 'Term 1 scores',
      ...body,
    });

  async function connectAndDetect() {
    const source = (await connect().expect(201)).body as { id: string };
    await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
    const tabs = (await admin.get(`${V1}/sources/${source.id}/mappings`).expect(200)).body as Tab[];
    return { sourceId: source.id, tab: (name: string) => tabs.find((t) => t.tabName === name)! };
  }

  describe('connecting', () => {
    it('tells admins which service account to share with', async () => {
      const res = await admin.get(`${V1}/sources/service-account`).expect(200);
      expect(res.body).toEqual({ configured: true, email: SA_EMAIL });
    });

    it('connects after checking the roster tab and _meta', async () => {
      const res = await connect().expect(201);
      expect(res.body).toMatchObject({
        term: { id: termIds[1], number: 1 },
        rosterTab: 'ALL',
        generation: { code: 'GEN2027' },
        spreadsheetTitle: 'TERM1- GEN 2027 Scoring',
      });
      // Only metadata and _meta are read at connect time.
      expect(reader.calls.map((c) => c.tabs ?? [])).toEqual([[], ['_meta']]);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'source.created' },
      });
      expect(audit.metadata).toMatchObject({ termNumber: 1 });
    });

    it('accepts the school workbook that the old template rejected', async () => {
      // Regression: GEN2027 file with no Students, Courses or Criteria tabs.
      const sheet = termWorkbookFixture();
      for (const tab of ['Students', 'Courses', 'Criteria'])
        expect(sheet.tabs[tab]).toBeUndefined();
      await connect().expect(201);
    });

    it.each([
      ['not a url', 'INVALID_URL'],
      [`http://docs.google.com/spreadsheets/d/${ID}/edit`, 'UNSUPPORTED_HOST'],
      [`https://docs.google.com.attacker.example/spreadsheets/d/${ID}`, 'UNSUPPORTED_HOST'],
      [
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml',
        'NOT_A_SPREADSHEET_URL',
      ],
    ])('rejects the URL %j (%s)', async (url, code) => {
      const res = await connect(1, ID, { url }).expect(422);
      expect(res.body.error.code).toBe(code);
      expect(reader.calls).toHaveLength(0);
    });

    it('explains sharing problems and missing files', async () => {
      reader.fail(ID, 'SHEET_NOT_SHARED');
      expect((await connect().expect(422)).body.error.code).toBe('SHEET_NOT_SHARED');
      const missing = '1DoesNotExist00000000000000000000000000';
      expect((await connect(1, missing).expect(422)).body.error.code).toBe('SHEET_NOT_FOUND');
      expect(await ctx.prisma.googleSheetSource.count()).toBe(0);
    });

    it('refuses the wrong term or generation, and a workbook without a roster', async () => {
      expect((await connect(2).expect(422)).body.error.code).toBe('TERM_MISMATCH');

      const otherGeneration = termWorkbookFixture();
      otherGeneration.tabs['_meta']![2]![1] = 'GEN2026';
      reader.set(ID, otherGeneration);
      const wrong = await connect().expect(422);
      expect(wrong.body.error.code).toBe('GENERATION_MISMATCH');
      expect(wrong.body.error.message).toContain('GEN2026');

      const noRoster = termWorkbookFixture();
      delete noRoster.tabs['ALL'];
      reader.set(ID, noRoster);
      expect((await connect().expect(422)).body.error.code).toBe('ROSTER_TAB_MISSING');
    });

    it('allows one active workbook per term and one term per spreadsheet', async () => {
      await connect().expect(201);
      expect((await connect(1, OTHER_ID).expect(409)).body.error.code).toBe('TERM_SOURCE_EXISTS');
      expect((await connect(1, ID).expect(409)).body.error.code).toBe('SOURCE_EXISTS');
    });

    it('reports temporary Google problems as 503 and blocks archived generations', async () => {
      reader.fail(ID, 'GOOGLE_UNAVAILABLE');
      expect((await connect().expect(503)).body.error.code).toBe('GOOGLE_UNAVAILABLE');
      reader.set(ID, termWorkbookFixture());
      await admin.post(`${V1}/generations/${generationId}/archive`).expect(200);
      expect((await connect().expect(409)).body.error.code).toBe('GENERATION_ARCHIVED');
    });

    it('updates label and status, and keeps one active workbook when re-enabling', async () => {
      const first = (await connect().expect(201)).body;
      const res = await admin
        .patch(`${V1}/sources/${first.id}`, { label: 'Renamed', status: 'DISABLED' })
        .expect(200);
      expect(res.body).toMatchObject({ label: 'Renamed', status: 'DISABLED' });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'source.disabled' } })).toBe(1);

      await connect(1, OTHER_ID).expect(201);
      const clash = await admin
        .patch(`${V1}/sources/${first.id}`, { status: 'ACTIVE' })
        .expect(409);
      expect(clash.body.error.code).toBe('TERM_SOURCE_EXISTS');
      const disabled = await admin.post(`${V1}/sources/${first.id}/detect`).expect(409);
      expect(disabled.body.error.code).toBe('SOURCE_DISABLED');
    });
  });

  describe('detecting tabs', () => {
    it('stores a DRAFT mapping per subject tab and imports nothing', async () => {
      const source = (await connect().expect(201)).body;
      const res = await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      expect(res.body).toMatchObject({
        fatal: false,
        meta: { generationCode: 'GEN2027', termNumber: 1 },
        rosterTab: 'ALL',
        rosterStudents: 3,
      });
      expect(res.body.tabs.map((t: { tabName: string }) => t.tabName)).toEqual([
        'Logic',
        'ENG',
        'PL',
        'BCU',
        'MsOffice',
      ]);
      const eng = res.body.tabs[1];
      expect(eng.mapping).toMatchObject({ status: 'DRAFT', version: 0, headerRow: 3 });
      expect(eng.detected).toMatchObject({ totalWeight: '100', studentRows: 2 });
      const rolePlay = eng.mapping.columns.find(
        (c: { headerLabel: string }) => c.headerLabel === 'Role Play',
      );
      expect(rolePlay).toEqual({
        columnIndex: 10,
        headerLabel: 'Role Play',
        groupLabel: 'Projects (15%)',
        role: 'CRITERION',
        criterionId: null,
        proposedName: 'Role Play',
        proposedWeight: '7.5',
      });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'source.tabs.detected' } })).toBe(
        1,
      );
      expect(await ctx.prisma.student.count()).toBe(0);
      expect(await ctx.prisma.courseOffering.count()).toBe(0);
    });

    it('refreshes drafts, keeps confirmed and ignored tabs, drops stale drafts', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin.post(confirmUrl(sourceId, tab('Logic')), confirmBody(tab('Logic'), 'Logic'));
      await admin.post(`${V1}/sources/${sourceId}/mappings/${tab('PL').id}/ignore`).expect(200);

      const sheet = termWorkbookFixture();
      sheet.tabs['Logic']![0]![6] = 'Quiz 2 15%';
      sheet.tabs['ENG']![2]![10] = 'Role-play';
      delete sheet.tabs['MsOffice'];
      reader.set(ID, sheet);
      const second = await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      const byTab = Object.fromEntries(
        second.body.tabs.map((t: { tabName: string }) => [t.tabName, t]),
      );
      expect(byTab['Logic'].mapping).toMatchObject({ status: 'CONFIRMED', version: 1 });
      expect(byTab['Logic'].detected.headersChanged).toBe(true);
      expect(byTab['PL'].mapping).toMatchObject({ status: 'IGNORED' });
      expect(
        byTab['ENG'].mapping.columns.map((c: { headerLabel: string }) => c.headerLabel),
      ).toContain('Role-play');
      expect(await ctx.prisma.sheetTabMapping.count({ where: { sourceId } })).toBe(4);
    });
  });

  describe('confirming tabs', () => {
    it('creates the subject, its term offering and the mark columns', async () => {
      const { sourceId, tab } = await connectAndDetect();
      const res = await admin
        .post(confirmUrl(sourceId, tab('ENG')), confirmBody(tab('ENG'), 'English'))
        .expect(200);
      expect(res.body).toMatchObject({ status: 'CONFIRMED', version: 1 });

      const offering = await ctx.prisma.courseOffering.findFirstOrThrow({
        include: { course: { include: { aliases: true } }, criteria: true },
      });
      expect(offering).toMatchObject({
        externalKey: 'T1-ENGLISH',
        title: 'English',
        visibility: 'HIDDEN',
        sourceId,
      });
      expect(offering.course.aliases.map((a) => a.alias).toSorted()).toEqual(['ENG', 'English']);
      expect(offering.criteria).toHaveLength(16);
      const speaking = offering.criteria.find((c) => c.key === 'FINAL_SPEAKING');
      expect(speaking).toMatchObject({ name: 'FINAL – Speaking', category: 'EXAM' });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'mapping.confirmed' } })).toBe(1);
    });

    it('uses admin-entered weights for tabs that have none', async () => {
      const { sourceId, tab } = await connectAndDetect();
      const office = tab('MsOffice');
      const missing = await admin
        .post(confirmUrl(sourceId, office), confirmBody(office, 'MS Office'))
        .expect(422);
      expect(missing.body.error.code).toBe('MISSING_WEIGHT');

      const wrong = await admin
        .post(
          confirmUrl(sourceId, office),
          confirmBody(office, 'MS Office', {
            PARTICIPATIONS: '10',
            'MS WORD': '30',
            'MS POWERPOINT': '30',
            'MS EXCEL': '20',
          }),
        )
        .expect(422);
      expect(wrong.body.error.code).toBe('WEIGHTS_NOT_100');

      await admin
        .post(
          confirmUrl(sourceId, office),
          confirmBody(office, 'MS Office', {
            PARTICIPATIONS: '10',
            'MS WORD': '30',
            'MS POWERPOINT': '30',
            'MS EXCEL': '30',
          }),
        )
        .expect(200);
    });

    it('validates the student ID column and unknown columns', async () => {
      const { sourceId, tab } = await connectAndDetect();
      const logic = tab('Logic');
      const body = confirmBody(logic, 'Logic');
      const noId = {
        ...body,
        columns: body.columns.map((c) => (c.role === 'STUDENT_ID' ? { ...c, role: 'IGNORE' } : c)),
      };
      const res = await admin.post(confirmUrl(sourceId, logic), noId).expect(422);
      expect(res.body.error.code).toBe('STUDENT_ID_COLUMN_REQUIRED');

      const extra = { ...body, columns: [...body.columns, { columnIndex: 99, role: 'IGNORE' }] };
      const unknown = await admin.post(confirmUrl(sourceId, logic), extra).expect(422);
      expect(unknown.body.error.code).toBe('INVALID_COLUMN');
    });

    it('reuses a subject across terms and refuses two tabs for one subject', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin
        .post(confirmUrl(sourceId, tab('ENG')), confirmBody(tab('ENG'), 'English'))
        .expect(200);
      const clash = await admin
        .post(confirmUrl(sourceId, tab('PL')), confirmBody(tab('PL'), 'English'))
        .expect(409);
      expect(clash.body.error.code).toBe('SUBJECT_ALREADY_MAPPED');

      const term2 = termWorkbookFixture();
      term2.tabs['_meta']![3]![1] = 2;
      reader.set(OTHER_ID, term2);
      const second = (await connect(2, OTHER_ID).expect(201)).body;
      await admin.post(`${V1}/sources/${second.id}/detect`).expect(200);
      const tabs = (await admin.get(`${V1}/sources/${second.id}/mappings`).expect(200))
        .body as Tab[];
      const eng = tabs.find((t) => t.tabName === 'ENG')!;
      // Same tab name, so it resolves to the same subject without typing the name again.
      await admin.post(confirmUrl(second.id, eng), confirmBody(eng, 'ENG')).expect(200);
      expect(await ctx.prisma.course.count()).toBe(1);
      expect(await ctx.prisma.courseOffering.count()).toBe(2);
    });

    it('ignores a tab and reopens it for review, keeping confirmed names and weights', async () => {
      const { sourceId, tab } = await connectAndDetect();
      const pl = tab('PL');
      const ignored = await admin
        .post(`${V1}/sources/${sourceId}/mappings/${pl.id}/ignore`)
        .expect(200);
      expect(ignored.body.status).toBe('IGNORED');
      const reopened = await admin
        .post(`${V1}/sources/${sourceId}/mappings/${pl.id}/reopen`)
        .expect(200);
      expect(reopened.body.status).toBe('DRAFT');

      const body = confirmBody(pl, 'Professional Life');
      body.columns = body.columns.map((c) =>
        c.name === 'Quiz' ? { ...c, name: 'Class quiz' } : c,
      );
      await admin.post(confirmUrl(sourceId, pl), body).expect(200);
      await admin.post(`${V1}/sources/${sourceId}/mappings/${pl.id}/reopen`).expect(200);
      const after = await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      const refreshed = after.body.tabs.find((t: { tabName: string }) => t.tabName === 'PL');
      const quiz = refreshed.mapping.columns.find(
        (c: { headerLabel: string }) => c.headerLabel === 'Quiz 20%',
      );
      expect(quiz).toMatchObject({ proposedName: 'Class quiz', proposedWeight: '20' });
      expect(quiz.criterionId).not.toBeNull();
    });
  });

  describe('sync and release', () => {
    it('refuses to sync before a tab is confirmed', async () => {
      const source = (await connect().expect(201)).body;
      const res = await admin
        .post(`${V1}/sync`, { scope: 'SOURCE', sourceId: source.id })
        .expect(422);
      expect(res.body.error.code).toBe('NO_CONFIRMED_TABS');
      const all = await admin.post(`${V1}/sync`, { scope: 'GENERATION', generationId }).expect(422);
      expect(all.body.error.code).toBe('NO_SOURCES');
    });

    it('runs the whole flow: connect, confirm, sync, release, student sees scores', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin
        .post(confirmUrl(sourceId, tab('Logic')), confirmBody(tab('Logic'), 'Logic'))
        .expect(200);
      const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
        .body;
      const outcome = await runSourceSync({ prisma: ctx.prisma, reader }, jobId, {
        attempt: 1,
        maxAttempts: 1,
      });
      expect(outcome).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
      const job = (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      expect(job.warningCount).toBe(4); // the other four tabs are not confirmed yet

      const before = (await admin.get(`${V1}/generations/${generationId}`).expect(200)).body;
      expect(before.terms[0]).toMatchObject({ subjects: 1, visibleSubjects: 0 });

      const student = await ctx.prisma.student.findUniqueOrThrow({
        where: { studentCode: 'PNC2027-001' },
      });
      const issued = await admin.post(`${V1}/students/${student.id}/reset-password`).expect(200);
      const session = api(await login(ctx, 'pnc2027-001', issued.body.temporaryPassword));
      await session
        .post('/api/v1/auth/change-password', {
          currentPassword: issued.body.temporaryPassword,
          newPassword: 'River-Lantern-Morning-48',
        })
        .expect(204);

      const hidden = await session.get('/api/v1/student/me/results?term=1').expect(200);
      expect(hidden.body.terms[0].courses).toEqual([]);

      const released = await admin
        .post(`${V1}/terms/${termIds[1]}/release`, { visible: true })
        .expect(200);
      expect(released.body).toEqual({ termId: termIds[1], visible: true, subjects: 1 });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'term.released' } })).toBe(1);

      const shown = await session.get('/api/v1/student/me/results?term=1').expect(200);
      expect(shown.body.terms[0].courses[0]).toMatchObject({
        status: 'COMPLETE',
        finalScore: '78.90',
      });

      await admin.post(`${V1}/terms/${termIds[1]}/release`, { visible: false }).expect(200);
      const again = await session.get('/api/v1/student/me/results?term=1').expect(200);
      expect(again.body.terms[0].courses).toEqual([]);
    });

    it('refuses to release a term with nothing synced', async () => {
      const res = await admin
        .post(`${V1}/terms/${termIds[3]}/release`, { visible: true })
        .expect(422);
      expect(res.body.error.code).toBe('NOTHING_TO_RELEASE');
      await admin.post(`${V1}/terms/${termIds[3]}/release`, {}).expect(400);
    });
  });

  it('is for admins only', async () => {
    const source = (await connect().expect(201)).body;
    const detect = `${V1}/sources/${source.id}/detect`;
    const mappings = `${V1}/sources/${source.id}/mappings`;

    await request(ctx.app.getHttpServer()).get(mappings).expect(401);
    await request(ctx.app.getHttpServer()).post(detect).set('Origin', WEB_ORIGIN).expect(401);

    await seedUser(ctx, { username: 'PNC2027-001', password: ADMIN.password, role: 'STUDENT' });
    const student = api(await login(ctx, 'PNC2027-001', ADMIN.password));
    await student.get(`${V1}/sources/service-account`).expect(403);
    await student.get(mappings).expect(403);
    await student.post(detect).expect(403);
    await student
      .post(`${V1}/terms/${termIds[1]}/sources`, { url: urlFor(OTHER_ID), label: 'Nope' })
      .expect(403);
    await student.post(`${V1}/terms/${termIds[1]}/release`, { visible: true }).expect(403);
    expect(await ctx.prisma.sheetTabMapping.count()).toBe(0);
  });
});

describe('Term workbooks without Google credentials (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ sheetsReader: new NotConfiguredSheetsReader() });
    await resetState(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('reports GOOGLE_NOT_CONFIGURED instead of failing obscurely', async () => {
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    const admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    expect((await admin.get(`${V1}/sources/service-account`).expect(200)).body).toEqual({
      configured: false,
      email: null,
    });
    const gen = await admin
      .post(`${V1}/generations`, {
        code: 'GEN2027',
        name: 'Generation 2027',
        startDate: '2026-11-02',
      })
      .expect(201);
    const terms = await admin.get(`${V1}/generations/${gen.body.id}/terms`).expect(200);
    const res = await admin
      .post(`${V1}/terms/${terms.body[0].id}/sources`, { url: urlFor(ID), label: 'Term 1' })
      .expect(503);
    expect(res.body.error.code).toBe('GOOGLE_NOT_CONFIGURED');
  });
});
