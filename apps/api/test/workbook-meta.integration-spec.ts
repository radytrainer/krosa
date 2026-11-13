import type { Grid } from '@ssrs/sheets';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import {
  CONNECT_BLOCKED_ACTION,
  CONNECT_BLOCKED_DEDUP_MS,
} from '../src/sheets-sources/sheets-sources.service.js';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';
import { testPassword, testAdminPassword } from './support/credentials.js';

const ADMIN = { username: 'admin', password: testAdminPassword() };
const OTHER_ADMIN = { username: 'admin2', password: testPassword('other-admin') };
const V1 = '/api/v1/admin';
const ID = TERM_FIXTURE_SPREADSHEET_ID;
/** Starts with a GEN2027 Term 1 `_meta`; tests replace it. */
const OTHER_ID = '1MetaCheckOtherWorkbook00000000000000000';
const GOOD_ID = '1MetaCheckGoodWorkbook000000000000000000';
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** The fixture workbook whose `_meta` names `generation` and `term`. */
function workbookFor(generation: string | null, term: string | number | null) {
  const sheet = termWorkbookFixture();
  sheet.tabs['_meta']![2]![1] = generation;
  sheet.tabs['_meta']![3]![1] = term;
  return sheet;
}

/** The fixture workbook with `_meta` replaced by `rows`, or without `_meta` at all. */
function workbookWithMeta(rows: Grid | null) {
  const sheet = termWorkbookFixture();
  if (rows) sheet.tabs['_meta'] = rows;
  else delete sheet.tabs['_meta'];
  return sheet;
}

const mismatch = (found: string, selected: string) =>
  `This workbook is for ${found}. You selected ${selected}. Choose the matching term or check the workbook.`;

describe('_meta names the generation and term (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let termIds: Record<number, string>;
  let sourceId: string;

  const runJob = (jobId: string) =>
    runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });

  const sync = async (id: string) => {
    const { jobId } = (
      await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId: id }).expect(202)
    ).body as { jobId: string };
    await runJob(jobId);
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body as {
      status: string;
      failureCode: string | null;
      failureMessage: string | null;
    };
  };

  const scores = () =>
    ctx.prisma.assessmentScore.findMany({
      select: { id: true, mark: true, status: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

  /** Runs a preview of the term's sheet and lists its issues. */
  const previewIssues = async () => {
    const preview = (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201)).body as {
      id: string;
      summary: { canConfirm: boolean };
    };
    const page = (
      await admin
        .get(`${V1}/sources/${sourceId}/preview/${preview.id}/issues?pageSize=100`)
        .expect(200)
    ).body as { data: { code: string; severity: string; message: string }[] };
    return { canConfirm: preview.summary.canConfirm, list: page.data };
  };

  const connect = (term: number, id = OTHER_ID, as = admin) =>
    as.post(`${V1}/terms/${termIds[term]}/sources`, { url: urlFor(id), label: `Term ${term}` });
  const check = (term: number, id = OTHER_ID, as = admin) =>
    as.post(`${V1}/terms/${termIds[term]}/sources/check`, { url: urlFor(id) });
  const change = (term: number, id = OTHER_ID, as = admin) =>
    as.post(`${V1}/terms/${termIds[term]}/sources/change`, { url: urlFor(id), label: 'New' });

  const blocked = () =>
    ctx.prisma.auditLog.findMany({
      where: { action: CONNECT_BLOCKED_ACTION },
      orderBy: { createdAt: 'asc' },
    });

  const sourcesSnapshot = () =>
    ctx.prisma.googleSheetSource.findMany({
      select: { id: true, spreadsheetId: true, status: true, label: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader
      .set(ID, termWorkbookFixture())
      .set(OTHER_ID, termWorkbookFixture())
      .set(GOOD_ID, termWorkbookFixture())
      .clearCalls();
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    const generationId = (
      await admin
        .post(`${V1}/generations`, {
          code: 'GEN2027',
          name: 'Generation 2027',
          startDate: '2026-11-02',
        })
        .expect(201)
    ).body.id as string;
    const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
    termIds = Object.fromEntries(
      (terms.body as { id: string; number: number }[]).map((t) => [t.number, t.id]),
    );
    sourceId = (await connect(1, ID).expect(201)).body.id as string;
    await confirmAllTabs(ctx.prisma, reader, sourceId);
    const first = await sync(sourceId);
    if (first.status !== 'SUCCEEDED') throw new Error(`first sync: ${first.status}`);
  });

  describe('behaviour kept from before', () => {
    it('blocks connecting a workbook of another term, and saves nothing', async () => {
      const before = await sourcesSnapshot();
      const res = await connect(2).expect(422);
      expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
      expect(await sourcesSnapshot()).toEqual(before);
    });

    it('blocks the preview of a workbook edited to another term', async () => {
      reader.set(ID, workbookFor('GEN2027', 2));
      const issues = await previewIssues();
      expect(issues.canConfirm).toBe(false);
      expect(issues.list).toContainEqual(
        expect.objectContaining({ code: 'WORKBOOK_MISMATCH', severity: 'ERROR' }),
      );
    });

    it('fails the sync of a workbook edited to another term and leaves scores unchanged', async () => {
      const before = await scores();
      expect(before.length).toBeGreaterThan(0);
      const edited = workbookFor('GEN2027', 2);
      edited.tabs['Logic']![1]![5] = 12;
      reader.set(ID, edited);
      const job = await sync(sourceId);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'WORKBOOK_MISMATCH' });
      expect(await scores()).toEqual(before);
    });
  });

  describe('connecting', () => {
    it('connects a workbook whose _meta names GEN2027, Term 1', async () => {
      const terms = await ctx.prisma.term.findMany({ select: { id: true } });
      expect(terms.length).toBeGreaterThan(1);
      // The term already connected in beforeEach used the fixture's GEN2027 / 1 `_meta`.
      const source = await ctx.prisma.googleSheetSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(source).toMatchObject({ status: 'ACTIVE', termId: termIds[1] });
      expect(await blocked()).toEqual([]);
    });

    it.each([
      [' gen2027 ', 'Term 2'],
      ['GEN2027', 'T2'],
      ['Gen2027', ' term 2 '],
      ['GEN2027', '2'],
    ])('accepts generation %j and term %j for GEN2027, Term 2', async (generation, term) => {
      reader.set(OTHER_ID, workbookFor(generation, term));
      await connect(2).expect(201);
      expect(await blocked()).toEqual([]);
    });

    it('blocks another generation, shows both values, and saves nothing', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2026', 2));
      const before = await sourcesSnapshot();
      const res = await connect(2).expect(422);
      expect(res.body.error).toMatchObject({
        code: 'WORKBOOK_MISMATCH',
        message: mismatch('GEN2026, Term 2', 'GEN2027, Term 2'),
      });
      expect(res.body.error.details).toContainEqual({
        field: '_meta',
        message: mismatch('GEN2026, Term 2', 'GEN2027, Term 2'),
      });
      expect(await sourcesSnapshot()).toEqual(before);
    });

    it('blocks "GEN 2027" for GEN2027', async () => {
      reader.set(OTHER_ID, workbookFor('GEN 2027', 2));
      const res = await connect(2).expect(422);
      expect(res.body.error).toMatchObject({
        code: 'WORKBOOK_MISMATCH',
        message: mismatch('GEN 2027, Term 2', 'GEN2027, Term 2'),
      });
    });

    it('blocks another term; "T1" is shown as Term 1', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2027', 'T1'));
      const res = await connect(3).expect(422);
      expect(res.body.error.message).toBe(mismatch('GEN2027, Term 1', 'GEN2027, Term 3'));
      expect(await ctx.prisma.googleSheetSource.count({ where: { termId: termIds[3] } })).toBe(0);
    });

    it.each([
      [
        'no _meta tab',
        null,
        'The workbook has no _meta tab. Add one with generation_code and education_term.',
      ],
      [
        'a blank generation_code',
        [
          ['generation_code', '  '],
          ['education_term', 2],
        ],
        '_meta has no generation_code.',
      ],
      ['no education_term', [['generation_code', 'GEN2027']], '_meta has no education_term.'],
      [
        'an unreadable education_term',
        [
          ['generation_code', 'GEN2027'],
          ['education_term', 'abc'],
        ],
        '_meta education_term "abc" cannot be read as a term number.',
      ],
    ] as [string, Grid | null, string][])(
      'blocks %s with META_MISSING and saves nothing',
      async (_, rows, message) => {
        reader.set(OTHER_ID, workbookWithMeta(rows));
        const before = await sourcesSnapshot();
        const res = await connect(2).expect(422);
        expect(res.body.error).toMatchObject({ code: 'META_MISSING', message });
        expect(await sourcesSnapshot()).toEqual(before);
      },
    );

    it('answers with the _meta error first when the roster tab is missing too', async () => {
      const sheet = workbookFor('GEN2026', 2);
      delete sheet.tabs['ALL'];
      reader.set(OTHER_ID, sheet);
      for (const send of [() => connect(2), () => check(1), () => change(1)]) {
        const res = await send().expect(422);
        expect(res.body.error.code).toBe('WORKBOOK_MISMATCH');
        expect(res.body.error.message).toMatch(/^This workbook is for GEN2026, Term 2\./);
        // Every issue is still listed.
        expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual([
          'ALL',
          '_meta',
        ]);
      }
      expect(await ctx.prisma.googleSheetSource.count({ where: { spreadsheetId: OTHER_ID } })).toBe(
        0,
      );
    });

    it('shows at most 100 characters of a long _meta value', async () => {
      const long = `G${'X'.repeat(3999)}`;
      reader.set(OTHER_ID, workbookFor(long, 2));
      const res = await connect(2).expect(422);
      expect(res.body.error.message).toBe(
        mismatch(`${long.slice(0, 100)}…, Term 2`, 'GEN2027, Term 2'),
      );
      expect(JSON.stringify(res.body)).not.toContain(long.slice(0, 101));
      const [entry] = await blocked();
      expect((entry!.metadata as { found: { generationCode: string } }).found.generationCode).toBe(
        `${long.slice(0, 100)}…`,
      );

      reader.set(ID, workbookFor(long, 1));
      const job = await sync(sourceId);
      expect(job.failureCode).toBe('WORKBOOK_MISMATCH');
      expect(job.failureMessage).toBe(
        mismatch(`${long.slice(0, 100)}…, Term 1`, 'GEN2027, Term 1'),
      );
    });

    it('answers a conflict before reading the new workbook, and audits nothing', async () => {
      // Term 1 already has synced scores: 409 without reading the new sheet.
      reader.set(OTHER_ID, workbookFor('GEN2026', 1)).clearCalls();
      const res = await connect(1).expect(409);
      expect(res.body.error.code).toBe('USE_CHANGE_SHEET');
      expect(reader.calls).toHaveLength(0);
      expect(await blocked()).toEqual([]);
    });
  });

  describe('replacing a sheet', () => {
    it('blocks a mismatched replacement; the active sheet stays active, a pending one untouched', async () => {
      await change(1, GOOD_ID).expect(201);
      const before = await sourcesSnapshot();
      expect(before.map((s) => s.status).toSorted()).toEqual(['ACTIVE', 'PENDING']);

      reader.set(OTHER_ID, workbookFor('GEN2027', 2));
      expect((await check(1).expect(422)).body.error.code).toBe('WORKBOOK_MISMATCH');
      const res = await change(1).expect(422);
      expect(res.body.error).toMatchObject({
        code: 'WORKBOOK_MISMATCH',
        message: mismatch('GEN2027, Term 2', 'GEN2027, Term 1'),
      });
      expect(await sourcesSnapshot()).toEqual(before);
      expect(await ctx.prisma.googleSheetSource.count({ where: { spreadsheetId: OTHER_ID } })).toBe(
        0,
      );
    });

    it('blocks a replacement without _meta', async () => {
      reader.set(OTHER_ID, workbookWithMeta(null));
      const before = await sourcesSnapshot();
      expect((await change(1).expect(422)).body.error.code).toBe('META_MISSING');
      expect(await sourcesSnapshot()).toEqual(before);
    });

    it('accepts a matching replacement', async () => {
      reader.set(OTHER_ID, workbookFor('gen2027', 'Term 1'));
      await check(1).expect(200);
      expect((await change(1).expect(201)).body).toMatchObject({ status: 'PENDING' });
      expect(await blocked()).toEqual([]);
    });
  });

  describe('edited after connecting', () => {
    it.each([
      ['another generation', workbookFor('GEN2026', 1), 'WORKBOOK_MISMATCH'],
      ['no _meta', workbookWithMeta(null), 'META_MISSING'],
      ['a blank term', workbookFor('GEN2027', null), 'META_MISSING'],
    ] as const)(
      'with %s: the preview is blocked and the sync fails without writing',
      async (_, sheet, code) => {
        const before = await scores();
        const edited = structuredClone(sheet);
        edited.tabs['Logic']![1]![5] = 12;
        reader.set(ID, edited);

        const issues = await previewIssues();
        expect(issues.canConfirm).toBe(false);
        const issue = issues.list.find((i) => i.code === code);
        expect(issue).toMatchObject({ severity: 'ERROR' });

        const job = await sync(sourceId);
        expect(job).toMatchObject({
          status: 'FAILED',
          failureCode: code,
          failureMessage: issue!.message,
        });
        expect(await scores()).toEqual(before);
      },
    );

    it('a failed sync never renames the source from the wrong workbook', async () => {
      const before = await ctx.prisma.googleSheetSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      const wrong = workbookFor('GEN2027', 2);
      wrong.title = 'TERM2- GEN 2027 Scoring';
      reader.set(ID, wrong);
      expect(await sync(sourceId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'WORKBOOK_MISMATCH',
      });
      const after = await ctx.prisma.googleSheetSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(after.spreadsheetTitle).toBe(before.spreadsheetTitle);
      expect(after.spreadsheetTitle).toBe('TERM1- GEN 2027 Scoring');

      // A good workbook with a new title still renames it.
      const renamed = termWorkbookFixture();
      renamed.title = 'TERM1- GEN 2027 Scoring (v2)';
      reader.set(ID, renamed);
      expect((await sync(sourceId)).status).toMatch(/^SUCCEEDED/);
      expect(
        (await ctx.prisma.googleSheetSource.findUniqueOrThrow({ where: { id: sourceId } }))
          .spreadsheetTitle,
      ).toBe('TERM1- GEN 2027 Scoring (v2)');
    });

    it('keeps TEMPLATE_INVALID for other file-level errors', async () => {
      const noRoster = termWorkbookFixture();
      delete noRoster.tabs['ALL'];
      reader.set(ID, noRoster);
      const job = await sync(sourceId);
      expect(job).toMatchObject({ status: 'FAILED', failureCode: 'TEMPLATE_INVALID' });
    });

    it('still shows an old job stored with TERM_MISMATCH and TEMPLATE_INVALID', async () => {
      const user = await ctx.prisma.user.findFirstOrThrow({ where: { username: ADMIN.username } });
      const term = await ctx.prisma.term.findUniqueOrThrow({ where: { id: termIds[1]! } });
      const job = await ctx.prisma.syncJob.create({
        data: {
          scope: 'SOURCE',
          sourceId,
          termId: term.id,
          generationId: term.generationId,
          requestedById: user.id,
          status: 'FAILED',
          failureCode: 'TEMPLATE_INVALID',
          failureMessage: 'The spreadsheet has file-level errors; nothing was imported.',
          finishedAt: new Date(),
          errors: {
            create: {
              severity: 'ERROR',
              code: 'TERM_MISMATCH',
              message: '_meta says term 2, but this source is for term 1.',
              sheetTab: '_meta',
            },
          },
        },
      });
      const view = (await admin.get(`${V1}/sync/${job.id}`).expect(200)).body;
      expect(view).toMatchObject({ status: 'FAILED', failureCode: 'TEMPLATE_INVALID' });
      const errors = (await admin.get(`${V1}/sync/${job.id}/errors`).expect(200)).body;
      expect(errors.data).toContainEqual(
        expect.objectContaining({
          code: 'TERM_MISMATCH',
          message: '_meta says term 2, but this source is for term 1.',
        }),
      );
    });
  });

  describe('audit of blocked connections', () => {
    it('records a blocked connect with what was selected and what was found', async () => {
      reader.set(OTHER_ID, workbookFor(' GEN2026 ', 'T2'));
      await connect(2).expect(422);
      const [entry, ...more] = await blocked();
      expect(more).toEqual([]);
      const user = await ctx.prisma.user.findFirstOrThrow({ where: { username: ADMIN.username } });
      expect(entry).toMatchObject({
        actorUserId: user.id,
        actorType: 'USER',
        entityType: 'term',
        entityId: termIds[2],
        metadata: {
          route: 'connect',
          generationCode: 'GEN2027',
          termNumber: 2,
          found: { generationCode: 'GEN2026', term: 'T2' },
          code: 'WORKBOOK_MISMATCH',
          spreadsheetId: OTHER_ID,
        },
      });
      // Nothing but these keys: no URL, no names, no secrets.
      expect(Object.keys(entry!.metadata as object).toSorted()).toEqual([
        'code',
        'found',
        'generationCode',
        'route',
        'spreadsheetId',
        'termNumber',
      ]);
      expect(JSON.stringify(entry)).not.toMatch(/https?:|DARA|BOPHA|RITHY/);
    });

    it('records a blocked check and a blocked change (missing _meta: found values null)', async () => {
      reader.set(OTHER_ID, workbookWithMeta(null));
      await check(1).expect(422);
      reader.set(GOOD_ID, workbookFor('GEN2027', 3));
      await change(1, GOOD_ID).expect(422);
      const entries = await blocked();
      expect(entries.map((e) => e.metadata)).toEqual([
        {
          route: 'check',
          generationCode: 'GEN2027',
          termNumber: 1,
          found: { generationCode: null, term: null },
          code: 'META_MISSING',
          spreadsheetId: OTHER_ID,
        },
        {
          route: 'change',
          generationCode: 'GEN2027',
          termNumber: 1,
          found: { generationCode: 'GEN2027', term: '3' },
          code: 'WORKBOOK_MISMATCH',
          spreadsheetId: GOOD_ID,
        },
      ]);
    });

    it('records /check then /change of the same blocked sheet once', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2027', 2));
      await check(1).expect(422);
      await change(1).expect(422);
      const entries = await blocked();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata).toMatchObject({ route: 'check' });
    });

    it('records each repeated /check; check, check, change records two', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2027', 2));
      await check(1).expect(422);
      await check(1).expect(422);
      expect((await blocked()).map((e) => (e.metadata as { route: string }).route)).toEqual([
        'check',
        'check',
      ]);
      await change(1).expect(422);
      expect(await blocked()).toHaveLength(2);
      // The admin fixes one value but not the other: a different refusal, recorded.
      reader.set(OTHER_ID, workbookFor('GEN2027', 3));
      await change(1).expect(422);
      expect(await blocked()).toHaveLength(3);
    });

    it('records each repeated /change and each repeated connect', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2027', 2));
      await change(1).expect(422);
      await change(1).expect(422);
      await connect(3).expect(422);
      await connect(3).expect(422);
      expect((await blocked()).map((e) => (e.metadata as { route: string }).route)).toEqual([
        'change',
        'change',
        'connect',
        'connect',
      ]);
    });

    it("skips a connect that repeats the admin's /check of the same sheet", async () => {
      reader.set(OTHER_ID, workbookWithMeta(null));
      await check(2).expect(422);
      await connect(2).expect(422);
      expect(await blocked()).toHaveLength(1);
    });

    it('records another admin, another term and a later attempt separately', async () => {
      reader.set(OTHER_ID, workbookFor('GEN2027', 4));
      await check(1).expect(422);
      await check(2).expect(422);
      await seedUser(ctx, { ...OTHER_ADMIN, role: 'ADMIN' });
      const other = api(await login(ctx, OTHER_ADMIN.username, OTHER_ADMIN.password));
      await check(1, OTHER_ID, other).expect(422);
      expect(await blocked()).toHaveLength(3);

      // Each admin's /change after their own /check is the same attempt.
      await change(2).expect(422);
      await change(1, OTHER_ID, other).expect(422);
      expect(await blocked()).toHaveLength(3);

      // Another admin's /check does not cover this admin's /change.
      await check(3, OTHER_ID, other).expect(422);
      await change(3).expect(422);
      expect(await blocked()).toHaveLength(5);

      // Past the window, a /change after a /check is a new attempt.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + CONNECT_BLOCKED_DEDUP_MS + 60_000);
      await change(1).expect(422);
      expect(await blocked()).toHaveLength(6);
    });

    it('does not audit other check failures', async () => {
      const noRoster = termWorkbookFixture();
      delete noRoster.tabs['ALL'];
      reader.set(OTHER_ID, noRoster);
      expect((await check(1).expect(422)).body.error.code).toBe('ROSTER_TAB_MISSING');
      reader.fail(GOOD_ID, 'SHEET_NOT_SHARED');
      expect((await change(1, GOOD_ID).expect(422)).body.error.code).toBe('SHEET_NOT_SHARED');
      const badUrl = await admin
        .post(`${V1}/terms/${termIds[1]}/sources/check`, { url: 'not a url' })
        .expect(422);
      expect(badUrl.body.error.code).toBe('INVALID_URL');
      expect(await blocked()).toEqual([]);
    });
  });
});
