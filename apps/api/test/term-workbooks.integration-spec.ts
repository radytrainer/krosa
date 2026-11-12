import { NotConfiguredSheetsReader } from '@ssrs/sheets';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import request from 'supertest';
import {
  acquireDetectLock,
  DETECT_LOCK_LEASE_MS,
  detectLockKey,
  releaseDetectLock,
} from '../src/sheet-mappings/detect-lock.js';
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
  columnIndex: number | null;
  missingFromSheet?: boolean;
  criterionId?: string | null;
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
    // Columns missing from the sheet are never sent: confirming drops them.
    columns: tab.columns
      .filter((c) => !c.missingFromSheet)
      .map((c) => ({
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

/** Logic as an admin confirmed it: own weights, a renamed column, a column set aside. */
function adminLogic(logic: Tab) {
  const body = confirmBody(logic, 'Logic', {
    'Quiz 1 10%': '15',
    'Quiz 2 10%': '5',
    'FINAL 35%': '45',
  });
  body.columns = body.columns.map((c) => {
    const label = logic.columns.find((x) => x.columnIndex === c.columnIndex)!.headerLabel;
    if (label === 'Homework 10%') return { columnIndex: c.columnIndex, role: 'IGNORE' };
    if (label === 'Participation 10%') return { ...c, name: 'Class participation' };
    return c;
  });
  return body;
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

  /** Holds the reader's next workbook read until `release` is called. */
  function holdNextRead() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = reader.getMetadata.bind(reader);
    reader.getMetadata = async (id: string) => {
      reader.getMetadata = original;
      await gate;
      return original(id);
    };
    return release;
  }
  const detections = () => ctx.prisma.auditLog.count({ where: { action: 'source.tabs.detected' } });

  /** Logic confirmed by the admin, synced, reopened, and Quiz 2 then removed from the sheet. */
  async function logicWithQuiz2Missing() {
    const { sourceId, tab } = await connectAndDetect();
    await admin.post(confirmUrl(sourceId, tab('Logic')), adminLogic(tab('Logic'))).expect(200);
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
    await admin.post(`${V1}/sources/${sourceId}/mappings/${tab('Logic').id}/reopen`).expect(200);
    const before = tab('Logic').columns;
    const sheet = termWorkbookFixture();
    for (const row of sheet.tabs['Logic']!) {
      row.splice(6, 1);
      row.splice(10, 0, row === sheet.tabs['Logic']![0] ? 'Lab 5%' : 50);
    }
    reader.set(ID, sheet);
    await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
    const logic = () =>
      admin
        .get(`${V1}/sources/${sourceId}/mappings`)
        .expect(200)
        .then((r) => (r.body as Tab[]).find((t) => t.tabName === 'Logic')!);
    const quiz2Criterion = (
      await ctx.prisma.sheetColumnMapping.findFirstOrThrow({
        where: { tabMapping: { sourceId, tabName: 'Logic' }, headerLabel: 'Quiz 2 10%' },
      })
    ).criterionId;
    return { sourceId, logic, before, quiz2Criterion };
  }

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

    it('refuses the wrong term and a workbook without a roster; ignores _meta generation', async () => {
      expect((await connect(2).expect(422)).body.error.code).toBe('TERM_MISMATCH');

      // _meta's generation_code is ignored: only its term is checked.
      const otherGeneration = termWorkbookFixture();
      otherGeneration.tabs['_meta']![2]![1] = 'GEN2026';
      reader.set(ID, otherGeneration);
      const source = (await connect().expect(201)).body as { id: string };
      await ctx.prisma.googleSheetSource.delete({ where: { id: source.id } });

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
        missingFromSheet: false,
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

  describe('re-detecting a reopened tab (TD2)', () => {
    it('keeps what the admin set, proposes new columns, and lists the changes', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin.post(confirmUrl(sourceId, tab('Logic')), adminLogic(tab('Logic'))).expect(200);
      await admin.post(`${V1}/sources/${sourceId}/mappings/${tab('Logic').id}/reopen`).expect(200);

      // The teacher drops Quiz 2 and adds a Lab column before Total.
      const sheet = termWorkbookFixture();
      for (const row of sheet.tabs['Logic']!) {
        row.splice(6, 1);
        row.splice(10, 0, row === sheet.tabs['Logic']![0] ? 'Lab 5%' : 50);
      }
      reader.set(ID, sheet);
      const res = await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      const logic = res.body.tabs.find((t: { tabName: string }) => t.tabName === 'Logic');
      expect(logic.mapping).toMatchObject({ status: 'DRAFT', audience: 'SHARED' });
      expect(logic.audienceSuggestion).toBeNull();
      const col = (label: string) =>
        logic.mapping.columns.find((c: Column) => c.headerLabel === label) as Column;
      expect(col('Quiz 1 10%')).toMatchObject({ role: 'CRITERION', proposedWeight: '15' });
      expect(col('FINAL 35%')).toMatchObject({ role: 'CRITERION', proposedWeight: '45' });
      expect(col('Homework 10%')).toMatchObject({ role: 'IGNORE', proposedWeight: null });
      expect(col('Participation 10%')).toMatchObject({ proposedName: 'Class participation' });
      // The new column gets a proposal, and its new position.
      expect(col('Lab 5%')).toMatchObject({
        columnIndex: 10,
        role: 'CRITERION',
        proposedWeight: '5',
        criterionId: null,
      });
      expect(col('FINAL 35%').columnIndex).toBe(9);
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          { tabName: 'Logic', kind: 'COLUMN_ADDED', detail: 'Lab 5%' },
          { tabName: 'Logic', kind: 'COLUMN_MISSING', detail: 'Quiz 2 10%' },
        ]),
      );
      // Saved, not only returned.
      const saved = (await admin.get(`${V1}/sources/${sourceId}/mappings`).expect(200))
        .body as Tab[];
      const savedLogic = saved.find((t) => t.tabName === 'Logic')!;
      expect(savedLogic.columns.find((c) => c.headerLabel === 'Homework 10%')!.role).toBe('IGNORE');
      // The dropped column is kept as the admin set it, flagged, with no position.
      expect(savedLogic.columns.find((c) => c.headerLabel === 'Quiz 2 10%')).toMatchObject({
        columnIndex: null,
        missingFromSheet: true,
        role: 'CRITERION',
        proposedWeight: '5',
      });
    });

    it('re-links a missing column when its header comes back, as the admin left it', async () => {
      const { sourceId, logic, quiz2Criterion } = await logicWithQuiz2Missing();
      expect(quiz2Criterion).not.toBeNull();
      // Quiz 2 comes back, in another place (after Participation).
      const sheet = termWorkbookFixture();
      for (const row of sheet.tabs['Logic']!) {
        const header = row === sheet.tabs['Logic']![0];
        const [quiz2] = row.splice(6, 1);
        row.splice(8, 0, quiz2!);
        row.splice(11, 0, header ? 'Lab 5%' : 50);
      }
      reader.set(ID, sheet);
      const res = await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      expect(res.body.changes).toContainEqual({
        tabName: 'Logic',
        kind: 'COLUMN_RETURNED',
        detail: 'Quiz 2 10%',
      });
      const quiz2 = (await logic()).columns.find((c) => c.headerLabel === 'Quiz 2 10%')!;
      expect(quiz2).toMatchObject({
        columnIndex: 8,
        missingFromSheet: false,
        role: 'CRITERION',
        proposedWeight: '5',
        criterionId: quiz2Criterion,
      });
      expect(
        await ctx.prisma.sheetColumnMapping.count({
          where: { tabMapping: { sourceId }, missingFromSheet: true },
        }),
      ).toBe(0);
    });

    it('confirming drops only the missing columns mapping rows, audited; marks and criteria stay', async () => {
      const { sourceId, logic, quiz2Criterion } = await logicWithQuiz2Missing();
      const tab = await logic();
      const url = confirmUrl(sourceId, tab);
      const body = confirmBody(tab, 'Logic');
      const counts = async () => ({
        scores: await ctx.prisma.assessmentScore.findMany({
          select: { id: true, mark: true, status: true },
          orderBy: { id: 'asc' },
        }),
        revisions: await ctx.prisma.assessmentScoreRevision.count(),
      });
      const criteriaBefore = (await ctx.prisma.assessmentCriterion.findMany()).map((c) => c.id);
      const before = await counts();
      expect(before.scores.length).toBeGreaterThan(0);

      // Not without saying so: the refusal lists what would be dropped.
      const refused = await admin.post(url, body).expect(409);
      expect(refused.body.error).toMatchObject({
        code: 'MISSING_COLUMNS',
        columns: [{ header: 'Quiz 2 10%', role: 'CRITERION', name: 'Quiz 2', weight: '5' }],
      });
      // Weights that do not total 100 are refused by the existing rule, and nothing is dropped.
      const bad = {
        ...body,
        dropMissingColumns: true,
        columns: body.columns.map((c) => (c.weight === '45' ? { ...c, weight: '40' } : c)),
      };
      const invalid = await admin.post(url, bad).expect(422);
      expect(invalid.body.error.code).toBe('WEIGHTS_NOT_100');
      expect((await logic()).columns.some((c) => c.missingFromSheet)).toBe(true);

      await admin.post(url, { ...body, dropMissingColumns: true }).expect(200);
      const after = await logic();
      expect(after.status).toBe('CONFIRMED');
      expect(after.columns.some((c) => c.missingFromSheet)).toBe(false);
      expect(after.columns.map((c) => c.headerLabel)).not.toContain('Quiz 2 10%');
      // Marks untouched; no criterion removed (Quiz 2's stays; the new Lab column adds one).
      expect(await counts()).toEqual(before);
      const criteriaAfter = (await ctx.prisma.assessmentCriterion.findMany()).map((c) => c.id);
      expect(criteriaAfter).toEqual(expect.arrayContaining(criteriaBefore));
      expect(criteriaAfter).toContain(quiz2Criterion);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'mapping.columns_dropped' },
      });
      expect(audit.metadata).toMatchObject({
        tab: 'Logic',
        columns: [{ header: 'Quiz 2 10%', role: 'CRITERION', name: 'Quiz 2', weight: '5' }],
      });
    });

    it('a missing column lives on a draft tab only: "Not a subject" drops it, audited', async () => {
      const { sourceId, logic } = await logicWithQuiz2Missing();
      const tab = await logic();
      await admin.post(`${V1}/sources/${sourceId}/mappings/${tab.id}/ignore`).expect(200);
      expect(await ctx.prisma.sheetColumnMapping.count({ where: { missingFromSheet: true } })).toBe(
        0,
      );
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'mapping.columns_dropped' } }),
      ).toBe(1);
    });

    it('sync and preview never read a flagged row, even on a confirmed tab', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin
        .post(confirmUrl(sourceId, tab('Logic')), confirmBody(tab('Logic'), 'Logic'))
        .expect(200);
      const sync = async () => {
        const { jobId } = (
          await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202)
        ).body;
        await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
        return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
      };
      const first = await sync();
      expect(first.status).toBe('SUCCEEDED');
      const preview = async () =>
        (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201)).body.summary;
      const previewBefore = await preview();
      const scoresBefore = await ctx.prisma.assessmentScore.findMany({
        select: { id: true, mark: true },
        orderBy: { id: 'asc' },
      });
      // A flagged row put straight on the confirmed tab (the app never does this): a mark column
      // with half the weight. If anything read it, totals, criteria or issues would change.
      const mapping = await ctx.prisma.sheetTabMapping.findFirstOrThrow({
        where: { sourceId, tabName: 'Logic' },
      });
      await ctx.prisma.sheetColumnMapping.create({
        data: {
          tabMappingId: mapping.id,
          columnIndex: null,
          missingFromSheet: true,
          headerLabel: 'Ghost 50%',
          role: 'CRITERION',
          proposedName: 'Ghost',
          proposedWeight: '50',
          proposedKey: 'GHOST',
        },
      });
      expect(await preview()).toEqual(previewBefore);
      const second = await sync();
      expect(second.status).toBe('SUCCEEDED');
      expect(second.errorCount).toBe(first.errorCount);
      expect(
        await ctx.prisma.assessmentScore.findMany({
          select: { id: true, mark: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(scoresBefore);
      expect(await ctx.prisma.assessmentCriterion.count({ where: { key: 'GHOST' } })).toBe(0);
    });

    it('keeps a reopened tab whose sheet tab is gone, and says so', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin.post(confirmUrl(sourceId, tab('Logic')), adminLogic(tab('Logic'))).expect(200);
      await admin.post(`${V1}/sources/${sourceId}/mappings/${tab('Logic').id}/reopen`).expect(200);
      const sheet = termWorkbookFixture();
      delete sheet.tabs['Logic'];
      reader.set(ID, sheet);
      const res = await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      expect(res.body.changes).toContainEqual({ tabName: 'Logic', kind: 'TAB_GONE', detail: null });
      const row = await ctx.prisma.sheetTabMapping.findFirstOrThrow({
        where: { sourceId, tabName: 'Logic' },
        include: { columns: true },
      });
      expect(row.status).toBe('DRAFT');
      expect(row.columns.find((c) => c.headerLabel === 'Homework 10%')!.role).toBe('IGNORE');
    });

    it('lists new tabs on the first run, and nothing changed on a second identical run', async () => {
      const source = (await connect().expect(201)).body as { id: string };
      const first = await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      expect(first.body.changes.map((c: { kind: string }) => c.kind)).toEqual(
        Array(5).fill('TAB_NEW'),
      );
      const second = await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      expect(second.body.changes).toEqual([]);
    });
  });

  describe('one detection per sheet at a time (TD1)', () => {
    it('a second run while one is active gets "already running" and writes no audit entry', async () => {
      const source = (await connect().expect(201)).body as { id: string };
      const release = holdNextRead();
      const first = admin.post(`${V1}/sources/${source.id}/detect`).then((r) => r);
      // Wait until the first run holds the lock.
      await expect
        .poll(async () => ctx.redis.exists(detectLockKey(source.id)), { timeout: 5000 })
        .toBe(1);
      const second = await admin.post(`${V1}/sources/${source.id}/detect`).expect(409);
      expect(second.body.error.code).toBe('DETECT_IN_PROGRESS');
      release();
      expect((await first).status).toBe(200);
      expect(await detections()).toBe(1);
      // Released when the run ends: the next one runs.
      expect(await ctx.redis.exists(detectLockKey(source.id))).toBe(0);
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
      expect(await detections()).toBe(2);
    });

    it('is released when a run fails, so the retry runs', async () => {
      const source = (await connect().expect(201)).body as { id: string };
      reader.fail(ID, 'SHEET_NOT_SHARED');
      const failed = await admin.post(`${V1}/sources/${source.id}/detect`);
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(failed.status).not.toBe(409);
      expect(await ctx.redis.exists(detectLockKey(source.id))).toBe(0);
      expect(await detections()).toBe(0);
      // The connection itself is untouched by the failure.
      expect(
        (await ctx.prisma.googleSheetSource.findUniqueOrThrow({ where: { id: source.id } })).status,
      ).toBe('ACTIVE');
      reader.set(ID, termWorkbookFixture());
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
    });

    it('is a lease of about 2 minutes, and only its own run can release it', async () => {
      const id = '01900000-0000-7000-8000-00000000d1d1';
      const token = await acquireDetectLock(ctx.redis, id);
      expect(token).not.toBeNull();
      const ttl = await ctx.redis.pttl(detectLockKey(id));
      expect(DETECT_LOCK_LEASE_MS).toBe(120_000);
      expect(ttl).toBeGreaterThan(110_000);
      expect(ttl).toBeLessThanOrEqual(120_000);
      expect(await acquireDetectLock(ctx.redis, id)).toBeNull();
      await releaseDetectLock(ctx.redis, id, 'another-run');
      expect(await ctx.redis.exists(detectLockKey(id))).toBe(1);
      await releaseDetectLock(ctx.redis, id, token!);
      expect(await ctx.redis.exists(detectLockKey(id))).toBe(0);
    });

    it('an abandoned lock stops blocking once its lease ends', async () => {
      const source = (await connect().expect(201)).body as { id: string };
      // A crashed run: its lock is still there, with only a moment of lease left.
      await ctx.redis.set(detectLockKey(source.id), 'crashed-run', 'PX', 300);
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(409);
      await new Promise((r) => setTimeout(r, 400));
      await admin.post(`${V1}/sources/${source.id}/detect`).expect(200);
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
      // Every subject of the term: VISIBLE and marked as set by an admin; one audit entry.
      const offerings = await ctx.prisma.courseOffering.findMany({ where: { termId: termIds[1] } });
      expect(offerings.map((o) => [o.visibility, o.visibilityOverridden])).toEqual([
        ['VISIBLE', true],
      ]);
      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'term.released' },
      });
      expect(entry).toMatchObject({
        actorType: 'USER',
        entityType: 'term',
        entityId: termIds[1],
        metadata: expect.objectContaining({ termNumber: 1, subjects: 1 }),
      });

      const shown = await session.get('/api/v1/student/me/results?term=1').expect(200);
      expect(shown.body.terms[0].courses[0]).toMatchObject({
        status: 'COMPLETE',
        finalScore: '78.90',
      });

      await admin.post(`${V1}/terms/${termIds[1]}/release`, { visible: false }).expect(200);
      expect(
        await ctx.prisma.courseOffering.count({
          where: { termId: termIds[1], visibility: 'HIDDEN', visibilityOverridden: true },
        }),
      ).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'term.hidden' } })).toBe(1);
      const again = await session.get('/api/v1/student/me/results?term=1').expect(200);
      expect(again.body.terms[0].courses).toEqual([]);
    });

    it('detection never syncs and never changes scores, visibility or cached results (TD3)', async () => {
      const { sourceId, tab } = await connectAndDetect();
      await admin
        .post(confirmUrl(sourceId, tab('Logic')), confirmBody(tab('Logic'), 'Logic'))
        .expect(200);
      const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
        .body;
      await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
      await admin.post(`${V1}/terms/${termIds[1]}/release`, { visible: true }).expect(200);
      const snapshot = async () => ({
        scores: await ctx.prisma.assessmentScore.findMany({
          select: { id: true, mark: true, status: true },
          orderBy: { id: 'asc' },
        }),
        revisions: await ctx.prisma.assessmentScoreRevision.count(),
        offerings: await ctx.prisma.courseOffering.findMany({
          select: { id: true, visibility: true, status: true },
          orderBy: { id: 'asc' },
        }),
        jobs: await ctx.prisma.syncJob.count(),
        cacheVersion: (
          await ctx.prisma.generation.findUniqueOrThrow({ where: { id: generationId } })
        ).cacheVersion,
      });
      const before = await snapshot();
      // Even with the marks changed in the sheet, detection reads only the layout.
      const sheet = termWorkbookFixture();
      sheet.tabs['Logic']![1]![5] = 10;
      reader.set(ID, sheet);
      await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
      expect(await snapshot()).toEqual(before);
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
