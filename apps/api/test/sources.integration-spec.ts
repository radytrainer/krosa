import {
  cloneSpreadsheet,
  FIXTURE_SPREADSHEET_ID,
  InMemorySheetsReader,
  workbookFixture,
} from '@ssrs/sheets/testing';
import { NotConfiguredSheetsReader } from '@ssrs/sheets';
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
const SA_EMAIL = 'ssrs-sync@example-project.iam.gserviceaccount.com';
const ID = FIXTURE_SPREADSHEET_ID;
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

describe('Spreadsheet sources (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;

  beforeAll(async () => {
    reader = new InMemorySheetsReader(new Map(), SA_EMAIL);
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(ID, workbookFixture('GEN2026')).clearCalls();
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    const gen = await admin
      .post(`${V1}/generations`, {
        code: 'GEN2026',
        name: 'Generation 2026',
        startDate: '2026-01-05',
      })
      .expect(201);
    generationId = gen.body.id;
  });

  const register = (url = urlFor(ID), genId = generationId) =>
    admin.post(`${V1}/generations/${genId}/sources`, { url, label: 'Main scores' });

  it('tells admins which service account to share with', async () => {
    const res = await admin.get(`${V1}/sources/service-account`).expect(200);
    expect(res.body).toEqual({ configured: true, email: SA_EMAIL });
  });

  it('registers a readable spreadsheet that matches the generation', async () => {
    const res = await register().expect(201);
    expect(res.body).toMatchObject({
      spreadsheetId: ID,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      label: 'Main scores',
      spreadsheetTitle: 'Scores GEN2026 (fixture)',
      status: 'ACTIVE',
      generation: { code: 'GEN2026' },
      ownedOfferings: 0,
      lastSyncedAt: null,
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'source.created' } })).toBe(1);

    const list = await admin.get(`${V1}/generations/${generationId}/sources`).expect(200);
    expect(list.body).toHaveLength(1);
    // Registration only checks the template; no academic data is imported.
    expect(await ctx.prisma.student.count()).toBe(0);
    expect(await ctx.prisma.courseOffering.count()).toBe(0);
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
    const res = await register(url).expect(422);
    expect(res.body.error.code).toBe(code);
    expect(reader.calls).toHaveLength(0);
  });

  it('explains how to fix a spreadsheet that is not shared', async () => {
    reader.fail(ID, 'SHEET_NOT_SHARED');
    const res = await register().expect(422);
    expect(res.body.error.code).toBe('SHEET_NOT_SHARED');
    expect(await ctx.prisma.googleSheetSource.count()).toBe(0);
  });

  it('rejects missing spreadsheets and template problems', async () => {
    const missing = await register(urlFor('1DoesNotExist00000000000000000000000000')).expect(422);
    expect(missing.body.error.code).toBe('SHEET_NOT_FOUND');

    const broken = cloneSpreadsheet(workbookFixture('GEN2026'));
    delete broken.tabs['Criteria'];
    reader.set(ID, broken);
    const tab = await register().expect(422);
    expect(tab.body.error.code).toBe('TEMPLATE_TAB_MISSING');
  });

  it('refuses a spreadsheet that belongs to another generation', async () => {
    reader.set(ID, workbookFixture('GEN2027'));
    const res = await register().expect(422);
    expect(res.body.error.code).toBe('GENERATION_MISMATCH');
    expect(res.body.error.message).toContain('GEN2027');
  });

  it('connects a spreadsheet to only one generation', async () => {
    await register().expect(201);
    expect((await register().expect(409)).body.error.code).toBe('SOURCE_EXISTS');

    const other = await admin
      .post(`${V1}/generations`, {
        code: 'GEN2027',
        name: 'Generation 2027',
        startDate: '2027-01-04',
      })
      .expect(201);
    const res = await register(urlFor(ID), other.body.id).expect(409);
    expect(res.body.error.message).toContain('GEN2026');
  });

  it('reports temporary Google problems as 503 and blocks archived generations', async () => {
    reader.fail(ID, 'GOOGLE_UNAVAILABLE');
    expect((await register().expect(503)).body.error.code).toBe('GOOGLE_UNAVAILABLE');

    reader.set(ID, workbookFixture('GEN2026'));
    await admin.post(`${V1}/generations/${generationId}/archive`).expect(200);
    expect((await register().expect(409)).body.error.code).toBe('GENERATION_ARCHIVED');
  });

  it('updates label and status', async () => {
    const source = (await register().expect(201)).body;
    const res = await admin
      .patch(`${V1}/sources/${source.id}`, { label: 'Renamed', status: 'DISABLED' })
      .expect(200);
    expect(res.body).toMatchObject({ label: 'Renamed', status: 'DISABLED' });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'source.disabled' } })).toBe(1);
    await admin.patch(`${V1}/sources/${source.id}`, { spreadsheetId: 'x' }).expect(400);
  });

  it('previews a full validation report without importing anything', async () => {
    const source = (await register().expect(201)).body;
    const ok = await admin.post(`${V1}/sources/${source.id}/preview`).expect(200);
    expect(ok.body).toMatchObject({
      fatal: false,
      issues: [],
      issuesTruncated: false,
      stats: { students: 3, courses: 2, markRows: 6, marks: 29, blankMarks: 1, errors: 0 },
    });
    expect(ok.body.courses.map((c: { courseKey: string }) => c.courseKey)).toEqual([
      'T1-MATH101',
      'T2-ENG101',
    ]);

    const broken = cloneSpreadsheet(workbookFixture('GEN2026'));
    broken.tabs['T1 Math']![2]![2] = 11; // Q1 above max 10
    broken.tabs['Criteria']![7]![5] = 31; // English weights total 101
    reader.set(ID, broken);
    const report = await admin.post(`${V1}/sources/${source.id}/preview`).expect(200);
    expect(report.body.fatal).toBe(false);
    expect(report.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_MARK',
          sheetTab: 'T1 Math',
          rowNumber: 3,
          criterionKey: 'Q1',
          rawValue: '11',
        }),
        expect.objectContaining({ code: 'WEIGHTS_NOT_100', courseKey: 'T2-ENG101' }),
      ]),
    );
    expect(
      report.body.courses.find((c: { courseKey: string }) => c.courseKey === 'T2-ENG101')
        .schemeValid,
    ).toBe(false);

    expect(await ctx.prisma.student.count()).toBe(0);
    expect(await ctx.prisma.assessmentScore.count()).toBe(0);
  });

  it('is admin-only', async () => {
    await seedUser(ctx, {
      username: 'GEN26-0001',
      password: 'Student-Initial-Pass-2026',
      role: 'STUDENT',
    });
    const student = api(await login(ctx, 'GEN26-0001', 'Student-Initial-Pass-2026'));
    await student.get(`${V1}/sources/service-account`).expect(403);
    await student
      .post(`${V1}/generations/${generationId}/sources`, { url: urlFor(ID), label: 'x' })
      .expect(403);
  });
});

describe('Spreadsheet sources without Google credentials (integration)', () => {
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
        code: 'GEN2026',
        name: 'Generation 2026',
        startDate: '2026-01-05',
      })
      .expect(201);
    const res = await admin
      .post(`${V1}/generations/${gen.body.id}/sources`, { url: urlFor(ID), label: 'Main' })
      .expect(503);
    expect(res.body.error.code).toBe('GOOGLE_NOT_CONFIGURED');
  });
});
