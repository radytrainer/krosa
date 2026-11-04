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
const V1 = '/api/v1/admin';
const SHEET = TERM_FIXTURE_SPREADSHEET_ID;
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/**
 * A sheet with exactly `total` issues in a preview, or in a sync job: one warning for a name no
 * roster student has, and an error per unknown student. A sync also warns three times that
 * PNC2027-003 is missing from ENG, BCU and MsOffice (a preview does not check that).
 */
function sheetWithIssues(total: number, kind: 'preview' | 'job' = 'preview') {
  const sheet = termWorkbookFixture();
  sheet.tabs['BCU']![1]![2] = 'NOBODY'; // PNC2027-001's last name, in BCU
  const base = kind === 'job' ? 4 : 1;
  for (let i = 1; i <= total - base; i++) {
    const code = `PNC2027-${String(100 + i).padStart(3, '0')}`;
    sheet.tabs['Logic']!.push([code, 'NEW', 'STUDENT', 'F', 'A', 50]);
  }
  return sheet;
}

interface Issue {
  severity: string;
  code: string;
  sheetTab?: string;
  rowNumber?: number;
  studentCode?: string;
}
const keyOf = (i: Issue) => `${i.code}|${i.sheetTab}|${i.rowNumber}|${i.studentCode}`;

describe('Issue lists (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let sourceId: string;

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    reader.set(SHEET, termWorkbookFixture());
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
    ).body.id;
    const terms = await admin.get(`${V1}/generations/${generationId}/terms`).expect(200);
    sourceId = (
      await admin
        .post(`${V1}/terms/${terms.body[0].id}/sources`, { url: urlFor(SHEET), label: 'Sheet' })
        .expect(201)
    ).body.id;
    await confirmAllTabs(ctx.prisma, reader, sourceId);
  });

  const runPreview = async () =>
    (await admin.post(`${V1}/sources/${sourceId}/preview`).expect(201)).body;
  const issuesPage = async (previewId: string, query: string) =>
    (
      await admin
        .get(`${V1}/sources/${sourceId}/preview/${previewId}/issues?pageSize=5&${query}`)
        .expect(200)
    ).body;

  it('preview: counts only in the summary, issues served 5 per page with no duplicates', async () => {
    reader.set(SHEET, sheetWithIssues(23));
    const preview = await runPreview();
    expect(preview.summary.issues).toBeUndefined();
    expect(preview.summary.issueCounts).toEqual({ total: 23, errors: 22, warnings: 1 });
    expect(preview.summary.firstErrors).toHaveLength(5);
    expect(preview.summary.firstErrors[0]).toMatch(/is not in the roster tab/);
    // The newest preview reads the same.
    const latest = (await admin.get(`${V1}/sources/${sourceId}/preview`).expect(200)).body;
    expect(latest.summary.issueCounts).toEqual(preview.summary.issueCounts);

    const seen: Issue[] = [];
    for (let page = 1; page <= 5; page++) {
      const body = await issuesPage(preview.id, `page=${page}`);
      expect(body.meta).toEqual({ page, pageSize: 5, total: 23 });
      expect(body.data).toHaveLength(page < 5 ? 5 : 3);
      expect(body.notListed).toBe(0);
      seen.push(...body.data);
    }
    expect(new Set(seen.map(keyOf)).size).toBe(23);
    // Errors first, then warnings.
    expect(seen.map((i) => i.severity)).toEqual([...Array<string>(22).fill('ERROR'), 'WARNING']);
    expect((await issuesPage(preview.id, 'page=6')).data).toEqual([]);
  });

  it('preview: filters by severity and tab, and lists every tab with issues', async () => {
    reader.set(SHEET, sheetWithIssues(23));
    const { id } = await runPreview();
    const warnings = await issuesPage(id, 'severity=WARNING');
    expect(warnings.meta.total).toBe(1);
    expect(warnings.data[0]).toMatchObject({ code: 'PROFILE_MISMATCH', sheetTab: 'BCU' });
    const logic = await issuesPage(id, 'sheetTab=Logic&page=2');
    expect(logic.meta).toEqual({ page: 2, pageSize: 5, total: 22 });
    expect(logic.data.every((i: Issue) => i.sheetTab === 'Logic')).toBe(true);
    expect(logic.tabs).toEqual(['BCU', 'Logic']);
    await admin.get(`${V1}/sources/${sourceId}/preview/${id}/issues?severity=INFO`).expect(400);
    await admin.get(`${V1}/sources/${sourceId}/preview/${id}/issues?pageSize=101`).expect(400);
  });

  it('preview: 5 or fewer issues fit on one page', async () => {
    reader.set(SHEET, sheetWithIssues(1));
    const preview = await runPreview();
    expect(preview.summary.issueCounts.total).toBe(1);
    const body = await issuesPage(preview.id, 'page=1');
    expect(body.meta).toEqual({ page: 1, pageSize: 5, total: 1 });
    expect(body.data).toHaveLength(1);
  });

  it('preview: unknown previews and previews of another sheet are 404', async () => {
    const { id } = await runPreview();
    const other = '01890000-0000-7000-8000-000000000000';
    await admin.get(`${V1}/sources/${sourceId}/preview/${other}/issues`).expect(404);
    await admin.get(`${V1}/sources/${other}/preview/${id}/issues`).expect(404);
  });

  it('job issues: 23 come back as 5 pages of 5 with no duplicates', async () => {
    reader.set(SHEET, sheetWithIssues(23, 'job'));
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await admin.get(`${V1}/sync/${jobId}/errors?page=${page}&pageSize=5`).expect(200);
      expect(res.body.meta).toEqual({ page, pageSize: 5, total: 23 });
      expect(res.body.data).toHaveLength(page < 5 ? 5 : 3);
      seen.push(...res.body.data.map((i: Issue & { id: string }) => i.id));
    }
    expect(new Set(seen).size).toBe(23);
  });
});
