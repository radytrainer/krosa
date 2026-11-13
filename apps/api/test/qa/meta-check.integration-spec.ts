import type { CellValue, Grid } from '@ssrs/sheets';
import {
  InMemorySheetsReader,
  PROGRAM_T1_SPREADSHEET_ID,
  PROGRAM_T2_SPREADSHEET_ID,
  programTerm1Workbook,
  programTerm2Workbook,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
  type FakeSpreadsheet,
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
} from '../support/test-app.js';

/**
 * QA (independent of workbook-meta.integration-spec.ts): `_meta` must name the generation and
 * term the admin selected, on connect, check/change, preview and sync; blocked attempts audited
 * once; earlier terms untouched. Fixture data only (synthetic IDs), ssrs_test only.
 */
const ADMIN = { username: 'qa-meta-admin', password: 'Qa-Meta-Admin-Pass-2026' };
const STUDENT = { username: 'qa-meta-stu-01', password: 'Qa-Meta-Student-Pass-2026' };
const V1 = '/api/v1/admin';
const MAIN = TERM_FIXTURE_SPREADSHEET_ID;
const ALT = '1QaMetaAltWorkbook0000000000000000000000';
const ALT2 = '1QaMetaAltWorkbookTwo000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

function withMeta(sheet: FakeSpreadsheet, generation: CellValue, term: CellValue) {
  const copy = structuredClone(sheet);
  copy.tabs['_meta'] = [
    ['key', 'value'],
    ['template_version', 1],
    ['generation_code', generation],
    ['education_term', term],
  ];
  return copy;
}
const fixture = (generation: CellValue, term: CellValue) =>
  withMeta(termWorkbookFixture(), generation, term);
function metaRows(rows: Grid | null) {
  const s = termWorkbookFixture();
  if (rows) s.tabs['_meta'] = rows;
  else delete s.tabs['_meta'];
  return s;
}

const AC_MESSAGE =
  'This workbook is for GEN2026, Term 2. You selected GEN2027, Term 1. Choose the matching term or check the workbook.';

interface Job {
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
}

describe('QA: _meta must name the selected generation and term', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;
  let termIds: Record<number, string>;

  const connect = (term: number, id = ALT) =>
    admin.post(`${V1}/terms/${termIds[term]}/sources`, { url: urlFor(id), label: `QA T${term}` });
  const check = (term: number, id = ALT) =>
    admin.post(`${V1}/terms/${termIds[term]}/sources/check`, { url: urlFor(id) });
  const change = (term: number, id = ALT) =>
    admin.post(`${V1}/terms/${termIds[term]}/sources/change`, { url: urlFor(id), label: 'QA new' });

  const blockedRows = () =>
    ctx.prisma.auditLog.findMany({
      where: { action: 'source.connect.blocked' },
      orderBy: { createdAt: 'asc' },
    });

  const sources = () =>
    ctx.prisma.googleSheetSource.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        spreadsheetId: true,
        status: true,
        termId: true,
        label: true,
        rosterTab: true,
        spreadsheetTitle: true,
        updatedAt: true,
      },
    });

  /** Everything a sync could write for students: scores, enrollments, term enrollments. */
  const studentData = async (termId?: string) => {
    const offering = termId ? { offering: { termId } } : {};
    return {
      scores: await ctx.prisma.assessmentScore.findMany({
        where: termId ? { enrollment: offering } : {},
        select: { id: true, mark: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
      revisions: await ctx.prisma.assessmentScoreRevision.count(
        termId ? { where: { score: { enrollment: offering } } } : undefined,
      ),
      enrollments: await ctx.prisma.enrollment.findMany({
        where: offering,
        select: { id: true, status: true, teacherComment: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
      studentTerms: await ctx.prisma.studentTerm.findMany({
        where: termId ? { termId } : {},
        select: { id: true, programId: true, classId: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    };
  };

  const sync = async (sourceId: string): Promise<Job> => {
    const { jobId } = (
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202)
    ).body as { jobId: string };
    await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body as Job;
  };

  const connectAndSync = async (term: number, id: string) => {
    const sourceId = (await connect(term, id).expect(201)).body.id as string;
    await confirmAllTabs(ctx.prisma, reader, sourceId);
    const job = await sync(sourceId);
    expect(`${job.status} ${JSON.stringify(job)}`).toMatch(/^SUCCEEDED/);
    return sourceId;
  };

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(MAIN, termWorkbookFixture()).set(ALT, termWorkbookFixture()).clearCalls();
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
    ).body.id as string;
    const terms = (await admin.get(`${V1}/generations/${generationId}/terms`).expect(200))
      .body as { id: string; number: number }[];
    termIds = Object.fromEntries(terms.map((t) => [t.number, t.id]));
  });

  describe('connect', () => {
    it('QA-M01 connects a GEN2027 Term 1 workbook to Generation 2027 Term 1', async () => {
      const res = await connect(1, MAIN).expect(201);
      expect(res.body).toMatchObject({ status: 'ACTIVE' });
      const rows = await sources();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ spreadsheetId: MAIN, termId: termIds[1], status: 'ACTIVE' });
      expect(await blockedRows()).toEqual([]);
    });

    it.each([
      [' gen2027 ', 'Term 1'],
      ['GEN2027', 'T1'],
      ['GEN2027', 1],
      ['gen2027', 't1'],
      ['GEN2027', '1'],
      ['GEN2027', ' term 1 '],
      ['GEN2027', 'Term 01'],
    ] as [CellValue, CellValue][])(
      'QA-M02 accepts generation %j with term %j for GEN2027 Term 1',
      async (generation, term) => {
        reader.set(ALT, fixture(generation, term));
        await connect(1).expect(201);
        expect(await blockedRows()).toEqual([]);
      },
    );

    it('QA-M03 another generation: 422 WORKBOOK_MISMATCH with both values, nothing saved', async () => {
      reader.set(ALT, fixture('GEN2026', 2));
      const res = await connect(1).expect(422);
      expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(res.body.error.message).toBe(AC_MESSAGE);
      expect(await sources()).toEqual([]);
      expect(await ctx.prisma.sheetTabMapping.count()).toBe(0);
    });

    it('QA-M04 same generation, another term: blocked', async () => {
      reader.set(ALT, fixture('GEN2027', 'Term 3'));
      const res = await connect(1).expect(422);
      expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(res.body.error.message).toContain('This workbook is for GEN2027, Term 3.');
      expect(res.body.error.message).toContain('You selected GEN2027, Term 1.');
      expect(await sources()).toEqual([]);
    });

    it.each(['GEN 2027', 'GEN-2027', 'GEN2027X', 'GEN2028', '2027'])(
      'QA-M05 generation %j does not match GEN2027',
      async (generation) => {
        reader.set(ALT, fixture(generation, 1));
        const res = await connect(1).expect(422);
        expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
        expect(await sources()).toEqual([]);
      },
    );

    it.each([
      ['no _meta tab', null, /no _meta tab/],
      [
        'blank generation_code',
        [
          ['generation_code', ''],
          ['education_term', 1],
        ],
        /generation_code/,
      ],
      ['generation_code row missing', [['education_term', 1]], /generation_code/],
      [
        'blank education_term',
        [
          ['generation_code', 'GEN2027'],
          ['education_term', null],
        ],
        /education_term/,
      ],
      [
        'unreadable education_term "first"',
        [
          ['generation_code', 'GEN2027'],
          ['education_term', 'first'],
        ],
        /cannot be read/,
      ],
      [
        'education_term 0',
        [
          ['generation_code', 'GEN2027'],
          ['education_term', 0],
        ],
        /education_term/,
      ],
      [
        'education_term 1.5',
        [
          ['generation_code', 'GEN2027'],
          ['education_term', 1.5],
        ],
        /education_term/,
      ],
      [
        'empty _meta tab',
        [],
        /generation_code/,
      ],
    ] as [string, Grid | null, RegExp][])(
      'QA-M06 %s: 422 META_MISSING naming what is missing, nothing saved',
      async (_, rows, pattern) => {
        reader.set(ALT, metaRows(rows));
        const res = await connect(1).expect(422);
        expect(res.body.error.code).toBe('META_MISSING');
        expect(res.body.error.message).toMatch(pattern);
        expect(await sources()).toEqual([]);
      },
    );

    it('QA-M07 both values blank: both are named in the details', async () => {
      reader.set(ALT, metaRows([['generation_code', ' '], ['education_term', '']]));
      const res = await connect(1).expect(422);
      expect(res.body.error.code).toBe('META_MISSING');
      const details = (res.body.error.details as { message: string }[]).map((d) => d.message);
      expect(details.some((m) => m.includes('generation_code'))).toBe(true);
      expect(details.some((m) => m.includes('education_term'))).toBe(true);
    });

    it('QA-M08 student token on connect/check/change: 403, nothing saved, nothing audited', async () => {
      await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      const student = api(await login(ctx, STUDENT.username, STUDENT.password));
      reader.set(ALT, fixture('GEN2026', 2));
      for (const path of ['sources', 'sources/check', 'sources/change']) {
        const res = await student.post(`${V1}/terms/${termIds[1]}/${path}`, { url: urlFor(ALT) });
        expect(`${path} ${res.status}`).toBe(`${path} 403`);
      }
      expect((await student.get(`${V1}/audit-logs`)).status).toBe(403);
      expect(await sources()).toEqual([]);
      expect(await blockedRows()).toEqual([]);
    });

    it('QA-M09 unknown term id: 404, invalid id: 400, never audited', async () => {
      reader.set(ALT, fixture('GEN2026', 2));
      await admin
        .post(`${V1}/terms/00000000-0000-4000-8000-000000000000/sources`, { url: urlFor(ALT), label: 'QA' })
        .expect(404);
      await admin.post(`${V1}/terms/not-a-uuid/sources/check`, { url: urlFor(ALT) }).expect(400);
      expect(await blockedRows()).toEqual([]);
    });
  });

  describe('audit of blocked connections', () => {
    it('QA-M10 entry has admin, selected term, found values, spreadsheetId and no secrets; shown by the audit API', async () => {
      reader.set(ALT, fixture('GEN2026', 2));
      await connect(1).expect(422);
      const rows = await blockedRows();
      expect(rows).toHaveLength(1);
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { username: ADMIN.username },
      });
      expect(rows[0]).toMatchObject({
        actorUserId: user.id,
        entityType: 'term',
        entityId: termIds[1],
        metadata: expect.objectContaining({
          generationCode: 'GEN2027',
          termNumber: 1,
          found: { generationCode: 'GEN2026', term: '2' },
          code: 'WORKBOOK_MISMATCH',
          spreadsheetId: ALT,
        }),
      });
      const text = JSON.stringify(rows[0]);
      expect(text).not.toMatch(/docs\.google|https?:|password|secret|token|private_key/i);
      expect(text).not.toMatch(/PNC2027-|DARA|BOPHA|RITHY/);

      for (const action of ['source.connect.blocked', 'source.']) {
        const list = (await admin.get(`${V1}/audit-logs?action=${action}`).expect(200)).body as {
          data: { action: string; actor: { username: string } | null; metadata: unknown }[];
        };
        const entry = list.data.find((e) => e.action === 'source.connect.blocked');
        expect(entry).toBeDefined();
        expect(entry!.actor?.username).toBe(ADMIN.username);
        expect(entry!.metadata).toMatchObject({ spreadsheetId: ALT, code: 'WORKBOOK_MISMATCH' });
      }
    });

    it('QA-M11 /check then /change of the same blocked sheet: exactly one entry', async () => {
      await connectAndSync(1, MAIN);
      reader.set(ALT, fixture('GEN2026', 2));
      expect((await check(1).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      expect((await change(1).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(await blockedRows()).toHaveLength(1);
    });

    it('QA-M12 /check A, /check B, /change A: two entries (A not duplicated)', async () => {
      await connectAndSync(1, MAIN);
      reader.set(ALT, fixture('GEN2026', 2)).set(ALT2, fixture('GEN2027', 4));
      await check(1, ALT).expect(422);
      await check(1, ALT2).expect(422);
      await change(1, ALT).expect(422);
      const rows = await blockedRows();
      expect(rows.map((r) => (r.metadata as { spreadsheetId: string }).spreadsheetId)).toEqual([
        ALT,
        ALT2,
      ]);
    });

    it('QA-M13 a very long _meta value is capped at 100 characters + "…" in the 422 and the audit', async () => {
      const long = `GEN${'9'.repeat(4000)}`;
      const capped = `${long.slice(0, 100)}…`;
      reader.set(ALT, fixture(long, 1));
      const res = await connect(1).expect(422);
      expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
      const message = String(res.body.error.message);
      expect(message.length).toBeLessThan(300);
      expect(message).toContain(`This workbook is for ${capped}, Term 1.`);
      expect(message).not.toContain(long.slice(0, 101));
      for (const d of res.body.error.details as { message: string }[]) {
        expect(d.message.length).toBeLessThan(300);
      }
      const [row] = await blockedRows();
      const found = (row!.metadata as { found: { generationCode: string } }).found;
      expect(found.generationCode).toBe(capped);
    });

    it('QA-M13b a long unreadable term is capped in the 422, the preview issue and the sync failure', async () => {
      const longTerm = `Term ${'x'.repeat(3000)}`;
      const cappedTerm = `${longTerm.slice(0, 100)}…`;
      reader.set(ALT, fixture('GEN2027', longTerm));
      const res = await connect(1).expect(422);
      expect(res.body.error.code).toBe('META_MISSING');
      expect(String(res.body.error.message)).toContain(`"${cappedTerm}"`);
      expect(String(res.body.error.message).length).toBeLessThan(300);

      // Connected first, then edited to a long generation code.
      const sourceId = await connectAndSync(1, MAIN);
      const long = `GEN${'8'.repeat(3000)}`;
      const capped = `${long.slice(0, 100)}…`;
      reader.set(MAIN, fixture(long, 1));
      const preview = (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201))
        .body as { id: string; summary: { canConfirm: boolean } };
      expect(preview.summary.canConfirm).toBe(false);
      const issues = (
        await admin
          .get(`${V1}/sources/${sourceId}/preview/${preview.id}/issues?pageSize=100`)
          .expect(200)
      ).body.data as { code: string; message: string }[];
      const issue = issues.find((i) => i.code === 'WORKBOOK_MISMATCH');
      expect(issue?.message).toContain(capped);
      expect(issue!.message.length).toBeLessThan(300);
      const job = await sync(sourceId);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'WORKBOOK_MISMATCH' });
      expect(job.failureMessage).toContain(capped);
      expect(job.failureMessage!.length).toBeLessThan(300);
    });

    it.each([
      ['check, check', ['check', 'check'], 2],
      ['check, change', ['check', 'change'], 1],
      ['check, check, change', ['check', 'check', 'change'], 2],
      ['change, change', ['change', 'change'], 2],
      ['change, check, change', ['change', 'check', 'change'], 2],
    ] as [string, ('check' | 'change')[], number][])(
      'QA-M19 de-dup on a connected term: %s gives %i entries',
      async (_, routes, expected) => {
        await connectAndSync(1, MAIN);
        reader.set(ALT, fixture('GEN2026', 1));
        for (const r of routes) await (r === 'check' ? check(1) : change(1)).expect(422);
        expect(await blockedRows()).toHaveLength(expected);
      },
    );

    it('QA-M19b connect, connect gives 2; check then connect gives 1', async () => {
      reader.set(ALT, fixture('GEN2026', 2));
      await connect(1).expect(422);
      await connect(1).expect(422);
      expect(await blockedRows()).toHaveLength(2);
      await check(2).expect(422);
      await connect(2).expect(422);
      const rows = await blockedRows();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => (r.metadata as { route: string }).route)).toEqual([
        'connect',
        'connect',
        'check',
      ]);
    });

    it('QA-M19c check then change: another admin, changed values, or after 10 minutes record again', async () => {
      await connectAndSync(1, MAIN);
      reader.set(ALT, fixture('GEN2026', 1));
      await check(1).expect(422);
      // Another admin's change is not the same attempt.
      await seedUser(ctx, { username: 'qa-meta-admin2', password: 'Qa-Meta-Admin2-Pass-2026' });
      const other = api(await login(ctx, 'qa-meta-admin2', 'Qa-Meta-Admin2-Pass-2026'));
      await other
        .post(`${V1}/terms/${termIds[1]}/sources/change`, { url: urlFor(ALT), label: 'QA' })
        .expect(422);
      expect(await blockedRows()).toHaveLength(2);
      // Same admin, values changed between check and change.
      reader.set(ALT, fixture('GEN2026', 3));
      await change(1).expect(422);
      expect(await blockedRows()).toHaveLength(3);
      // Same values as the first check, but more than 10 minutes later.
      reader.set(ALT, fixture('GEN2026', 1));
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
      try {
        await change(1).expect(422);
      } finally {
        vi.restoreAllMocks();
      }
      expect(await blockedRows()).toHaveLength(4);
    });
  });

  describe('_meta wins over other file errors', () => {
    it.each([
      ['a mismatched _meta', fixture('GEN2026', 2), 'WORKBOOK_MISMATCH', true],
      ['no _meta', metaRows(null), 'META_MISSING', true],
      ['a matching _meta', fixture('GEN2027', 1), 'ROSTER_TAB_MISSING', false],
    ] as [string, FakeSpreadsheet, string, boolean][])(
      'QA-M18 no ALL tab and %s: 422 code %s on connect, check and change',
      async (_, sheet, code, audited) => {
        const noRoster = structuredClone(sheet);
        delete noRoster.tabs['ALL'];
        reader.set(ALT, noRoster);
        const responses = [await connect(1).expect(422)];
        expect(await sources()).toEqual([]);
        await connectAndSync(1, MAIN);
        responses.push(await check(1).expect(422), await change(1).expect(422));
        for (const res of responses) {
          expect(res.body.error.code).toBe(code);
          if (code === 'WORKBOOK_MISMATCH') {
            expect(res.body.error.message).toMatch(/^This workbook is for GEN2026, Term 2\./);
          }
        }
        expect((await blockedRows()).length > 0).toBe(audited);
      },
    );
  });

  describe('a failed sync never renames the source', () => {
    it('QA-M20 spreadsheetTitle unchanged after a _meta failure; a good sync still updates it', async () => {
      const sourceId = await connectAndSync(1, MAIN);
      const title = async () =>
        (
          await ctx.prisma.googleSheetSource.findUniqueOrThrow({
            where: { id: sourceId },
            select: { spreadsheetTitle: true },
          })
        ).spreadsheetTitle;
      const original = await title();
      expect(original).toBeTruthy();

      for (const bad of [fixture('GEN2027', 3), metaRows(null)]) {
        bad.title = 'QA renamed wrong workbook';
        reader.set(MAIN, bad);
        expect((await sync(sourceId)).status).toBe('FAILED');
        expect(await title()).toBe(original);
        const view = (await admin.get(`${V1}/sources/${sourceId}`).expect(200)).body as {
          spreadsheetTitle: string | null;
        };
        expect(view.spreadsheetTitle).toBe(original);
      }

      const good = termWorkbookFixture();
      good.title = 'QA renamed good workbook';
      reader.set(MAIN, good);
      expect((await sync(sourceId)).status).toMatch(/^SUCCEEDED/);
      expect(await title()).toBe('QA renamed good workbook');
    });
  });

  describe('replacing a term sheet', () => {
    it('QA-M14 a mismatched replacement is blocked; ACTIVE stays ACTIVE, PENDING untouched', async () => {
      await connectAndSync(1, MAIN);
      reader.set(ALT2, fixture('GEN2027', 1));
      expect((await change(1, ALT2).expect(201)).body).toMatchObject({ status: 'PENDING' });
      const before = await sources();
      const data = await studentData();

      for (const [generation, term] of [
        ['GEN2026', 1],
        ['GEN2027', 2],
      ] as const) {
        reader.set(ALT, fixture(generation, term));
        expect((await check(1).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
        expect((await change(1).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      }
      reader.set(ALT, metaRows(null));
      expect((await change(1).expect(422)).body.error.code).toBe('META_MISSING');

      expect(await sources()).toEqual(before);
      expect(before.find((s) => s.spreadsheetId === MAIN)?.status).toBe('ACTIVE');
      expect(before.find((s) => s.spreadsheetId === ALT2)?.status).toBe('PENDING');
      expect(await studentData()).toEqual(data);
    });
  });

  describe('edited after connecting', () => {
    it.each([
      ['another generation', fixture('GEN2026', 1), 'WORKBOOK_MISMATCH'],
      ['another term', fixture('GEN2027', 'T2'), 'WORKBOOK_MISMATCH'],
      ['the _meta tab deleted', metaRows(null), 'META_MISSING'],
      ['a blank generation', fixture(null, 1), 'META_MISSING'],
      ['an unreadable term', fixture('GEN2027', 'one'), 'META_MISSING'],
    ] as [string, FakeSpreadsheet, string][])(
      'QA-M15 with %s: preview cannot confirm, sync FAILED, nothing written',
      async (_, edited, code) => {
        const sourceId = await connectAndSync(1, MAIN);
        const before = await studentData();
        expect(before.scores.length).toBeGreaterThan(0);
        const sheet = structuredClone(edited);
        // Also change a mark and a comment, so a write would show.
        sheet.tabs['Logic']![1]![5] = 11;
        sheet.tabs['Logic']![2]![12] = 'QA changed comment';
        reader.set(MAIN, sheet);

        const preview = (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201))
          .body as { id: string; summary: { canConfirm: boolean } };
        expect(preview.summary.canConfirm).toBe(false);
        const issues = (
          await admin
            .get(`${V1}/sources/${sourceId}/preview/${preview.id}/issues?pageSize=100`)
            .expect(200)
        ).body.data as { code: string; severity: string }[];
        expect(issues).toContainEqual(expect.objectContaining({ code, severity: 'ERROR' }));

        const job = await sync(sourceId);
        expect(job.status).toBe('FAILED');
        expect(job.failureCode).toBe(code);
        expect(await studentData()).toEqual(before);
      },
    );
  });

  describe('old jobs', () => {
    it('QA-M16 a stored TERM_MISMATCH job still shows in the job, its errors, the list and source history', async () => {
      const sourceId = await connectAndSync(1, MAIN);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
      const job = await ctx.prisma.syncJob.create({
        data: {
          scope: 'SOURCE',
          sourceId,
          termId: termIds[1]!,
          generationId,
          requestedById: user.id,
          status: 'FAILED',
          failureCode: 'TEMPLATE_INVALID',
          failureMessage: 'The spreadsheet has file-level errors; nothing was imported.',
          finishedAt: new Date(),
          errors: {
            create: {
              severity: 'ERROR',
              code: 'TERM_MISMATCH',
              message: '_meta says term 3, but this source is for term 1.',
              sheetTab: '_meta',
            },
          },
        },
      });
      expect((await admin.get(`${V1}/sync/${job.id}`).expect(200)).body).toMatchObject({
        status: 'FAILED',
        failureCode: 'TEMPLATE_INVALID',
      });
      const errors = (await admin.get(`${V1}/sync/${job.id}/errors`).expect(200)).body.data;
      expect(errors).toContainEqual(expect.objectContaining({ code: 'TERM_MISMATCH' }));
      const list = (await admin.get(`${V1}/sync?pageSize=100`).expect(200)).body.data as {
        id: string;
      }[];
      expect(list.map((j) => j.id)).toContain(job.id);
      const history = await admin.get(`${V1}/sources/${sourceId}/sync-history`).expect(200);
      expect(JSON.stringify(history.body)).toContain(job.id);
    });
  });

  describe('later terms never touch earlier ones', () => {
    it('QA-M17 Term 2 connect (blocked and allowed), sync and a failed sync leave Term 1 unchanged', async () => {
      reader
        .set(PROGRAM_T1_SPREADSHEET_ID, programTerm1Workbook())
        .set(PROGRAM_T2_SPREADSHEET_ID, programTerm2Workbook());
      await connectAndSync(1, PROGRAM_T1_SPREADSHEET_ID);
      const term1 = await studentData(termIds[1]);
      expect(term1.scores.length).toBeGreaterThan(0);
      const t1Sources = await sources();

      // A Term 1 workbook offered to Term 2: blocked.
      reader.set(ALT, withMeta(programTerm1Workbook(), 'GEN2027', 1));
      expect((await connect(2).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(await sources()).toEqual(t1Sources);

      // The real Term 2 workbook: connected and synced.
      const t2 = await connectAndSync(2, PROGRAM_T2_SPREADSHEET_ID);
      expect(await studentData(termIds[1])).toEqual(term1);
      const term2 = await studentData(termIds[2]);
      expect(term2.scores.length).toBeGreaterThan(0);

      // Term 2 edited to say Term 1: its sync fails; neither term changes.
      reader.set(PROGRAM_T2_SPREADSHEET_ID, withMeta(programTerm2Workbook(), 'GEN2027', 1));
      const failed = await sync(t2);
      expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'WORKBOOK_MISMATCH' });
      expect(await studentData(termIds[1])).toEqual(term1);
      expect(await studentData(termIds[2])).toEqual(term2);
    });
  });
});
