/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { termWorkbookFixture, type FakeSpreadsheet } from '@ssrs/sheets/testing';
import { vi } from 'vitest';
import type { TestContext } from '../support/test-app.js';
import {
  ADMIN_V1,
  confirmBody,
  createHarness,
  editedFixture,
  SHEET_A,
  sheetUrl,
  V1,
  type Api,
  type Harness,
  type Tab,
} from './support.js';

/** QA suite: area D (sync behavior) and the sheet-driven parts of area C. */

const CODE_1 = 'PNC2027-001';
const CODE_2 = 'PNC2027-002';
const CODE_3 = 'PNC2027-003';

interface Course {
  title: string;
  status: string;
  finalScore: string | null;
  criteria: { key: string; weight: string; score: { status: string; mark: string } | null }[];
}
interface Issue {
  id: string;
  severity: string;
  code: string;
  sheetTab: string | null;
  rowNumber: number | null;
  studentCode: string | null;
  criterionKey: string | null;
  rawValue: string | null;
}

describe('QA D: Google Sheets sync', () => {
  let h: Harness;
  let ctx: TestContext;
  let source: string;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reset();
    source = await h.importSheet();
  });

  const setSheet = (edit: (s: FakeSpreadsheet) => void) => {
    h.reader.set(SHEET_A, editedFixture(edit));
  };
  const issues = async (jobId: string) =>
    (await h.admin.get(`${ADMIN_V1}/sync/${jobId}/errors?pageSize=100`).expect(200)).body
      .data as Issue[];
  const course = async (s: Api, title: string) => {
    const body = (await s.get(`${V1}/student/me/results`).expect(200)).body;
    return (body.terms as { courses: Course[] }[])
      .flatMap((t) => t.courses)
      .find((c) => c.title === title)!;
  };
  const scoreCount = (code: string, title: string) =>
    ctx.prisma.assessmentScore.count({
      where: { enrollment: { student: { studentCode: code }, offering: { title } } },
    });

  describe('C: results against the workbook', () => {
    it('C-09 Logic, MsOffice and PL match the sheet totals and hand-worked values', async () => {
      const one = await h.activate(CODE_1);
      const two = await h.activate(CODE_2);
      const three = await h.activate(CODE_3);
      expect((await course(one, 'Logic')).finalScore).toBe('78.90');
      expect((await course(two, 'Logic')).finalScore).toBe('64.50');
      expect((await course(three, 'Logic')).finalScore).toBe('70.00');
      expect((await course(one, 'MsOffice')).finalScore).toBe('93.00');
      expect((await course(two, 'MsOffice')).finalScore).toBe('87.50');
      expect((await course(one, 'PL')).finalScore).toBe('76.80');
      expect((await course(two, 'PL')).finalScore).toBe('72.50');
      expect((await course(three, 'PL')).finalScore).toBe('79.90');
    });

    it('C-10 ENG: 16 columns total 100 and a mixed row matches a hand calculation', async () => {
      const one = await h.activate(CODE_1);
      const two = await h.activate(CODE_2);
      const eng = await course(two, 'ENG');
      expect(eng.criteria).toHaveLength(16);
      const total = eng.criteria.reduce((s, c) => s + Number(c.weight) * 1000, 0);
      expect(total).toBe(100_000);
      expect(eng.finalScore).toBe('63.05');
      expect((await course(one, 'ENG')).finalScore).toBe('80.00');
    });

    it('C-12 / C-05 / C-06 BCU partial rows: INCOMPLETE, no total, no row for blank cells', async () => {
      const one = await h.activate(CODE_1);
      const two = await h.activate(CODE_2);
      const a = await course(one, 'BCU');
      const b = await course(two, 'BCU');
      expect(a).toMatchObject({ status: 'INCOMPLETE', finalScore: null });
      expect(b).toMatchObject({ status: 'INCOMPLETE', finalScore: null });
      expect(await scoreCount(CODE_1, 'BCU')).toBe(1);
      expect(await scoreCount(CODE_2, 'BCU')).toBe(3);
      const blank = a.criteria.filter((c) => c.score === null);
      expect(blank).toHaveLength(5);
      const zeros = await ctx.prisma.assessmentScore.count({
        where: { mark: 0, status: 'RECORDED' },
      });
      expect(zeros).toBe(0);
    });

    it('C-11 a 5% group over three columns confirms, totals 100 and scores correctly', async () => {
      const gen = await ctx.prisma.term.findUniqueOrThrow({ where: { id: h.terms[2]! } });
      const sheetId = '1QaThreeColumnGroup000000000000000000000';
      const profile = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
      const base = termWorkbookFixture();
      h.reader.set(sheetId, {
        title: 'Term 2',
        tabs: {
          ALL: base.tabs['Logic']!.map((r) => r.slice(0, 5)),
          Three: [
            [null, null, null, null, null, 'Quizzes (5%)', null, null, 'Exam (95%)'],
            [...profile, 'Q1', 'Q2', 'Q3', 'Paper'],
            [CODE_1, 'DARA', 'SOK', 'M', 'A', 90, 90, 90, 90],
            [CODE_2, 'BOPHA', 'CHAN', 'F', 'A', 100, 50, 0, 80],
          ],
        },
      });
      const src = (
        await h.admin
          .post(`${ADMIN_V1}/terms/${gen.id}/sources`, { url: sheetUrl(sheetId), label: 'T2' })
          .expect(201)
      ).body;
      const tabs = await h.review(src.id);
      const three = tabs.find((t) => t.tabName === 'Three')!;
      const weights = three.columns
        .filter((c) => c.role === 'CRITERION')
        .map((c) => c.proposedWeight);
      expect(weights.map(Number).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
      await h.sync(src.id);
      await h.admin.post(`${ADMIN_V1}/terms/${gen.id}/release`, { visible: true }).expect(200);
      const one = await h.activate(CODE_1);
      const two = await h.activate(CODE_2);
      expect((await course(one, 'Three')).finalScore).toBe('90.00');
      // 100×1.666 + 50×1.667 + 0×1.667 + 80×95 all /100 = 1.666 + .8335 + 76 = 78.4995
      expect((await course(two, 'Three')).finalScore).toBe('78.50');
    });

    it('C-13 confirm is refused for weights that do not total 100, and for bad weights', async () => {
      const sheetId = '1QaWeightsSheet0000000000000000000000000';
      h.reader.set(sheetId, {
        title: 'Weights',
        tabs: {
          ALL: termWorkbookFixture().tabs['Logic']!.map((r) => r.slice(0, 5)),
          Bad: [
            ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'A 50%', 'B 49%'],
            [CODE_1, 'DARA', 'SOK', 80, 80],
          ],
        },
      });
      const src = (
        await h.admin
          .post(`${ADMIN_V1}/terms/${h.terms[3]}/sources`, { url: sheetUrl(sheetId), label: 'W' })
          .expect(201)
      ).body;
      await h.admin.post(`${ADMIN_V1}/sources/${src.id}/detect`).expect(200);
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${src.id}/mappings`).expect(200))
        .body as Tab[];
      const tab = tabs.find((t) => t.tabName === 'Bad')!;
      const confirm = (w: Record<string, string>) =>
        h.admin.post(
          `${ADMIN_V1}/sources/${src.id}/mappings/${tab.id}/confirm`,
          confirmBody(tab, 'Bad', w),
        );
      const asIs = await confirm({});
      expect(asIs.status).toBe(422);
      expect(asIs.body.error.code).toBe('WEIGHTS_NOT_100');
      const bad: Record<string, string>[] = [
        { 'B 49%': '50.001' },
        { 'B 49%': '49.999' },
        { 'B 49%': '0' },
        { 'B 49%': '-50' },
        { 'A 50%': '50.0001', 'B 49%': '49.9999' },
        { 'A 50%': 'abc' },
      ];
      for (const w of bad) {
        const res = await confirm(w);
        expect(res.status, JSON.stringify(w)).toBeGreaterThanOrEqual(400);
        expect(res.status, JSON.stringify(w)).toBeLessThan(500);
      }
      expect((await confirm({ 'B 49%': '50' })).status).toBe(200);
    });

    it('C-14 changed weights publish a new version, recalculate, and keep the old one', async () => {
      const one = await h.activate(CODE_1);
      expect((await course(one, 'Logic')).finalScore).toBe('78.90');
      const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${source}/mappings`).expect(200))
        .body as Tab[];
      const logic = tabs.find((t) => t.tabName === 'Logic')!;
      await h.admin.post(`${ADMIN_V1}/sources/${source}/mappings/${logic.id}/reopen`).expect(200);
      await h.admin.post(`${ADMIN_V1}/sources/${source}/detect`).expect(200);
      const fresh = (
        (await h.admin.get(`${ADMIN_V1}/sources/${source}/mappings`).expect(200)).body as Tab[]
      ).find((t) => t.tabName === 'Logic')!;
      await h.admin
        .post(
          `${ADMIN_V1}/sources/${source}/mappings/${fresh.id}/confirm`,
          confirmBody(fresh, 'Logic', { 'MIDTERM 25%': '35', 'FINAL 35%': '25' }),
        )
        .expect(200);
      // Unchanged until the sync publishes the new weights (D17).
      expect((await course(one, 'Logic')).finalScore).toBe('78.90');
      const job = await h.sync(source);
      expect(job.status).toBe('SUCCEEDED');
      // 9 + 8.9 + 9 + 9.7 = 36.6, + 60 × .35 + 78 × .25 = 36.6 + 21 + 19.5 = 77.1
      expect((await course(one, 'Logic')).finalScore).toBe('77.10');
      const schemes = await ctx.prisma.gradingScheme.findMany({
        where: { offering: { title: 'Logic' } },
        orderBy: { version: 'asc' },
      });
      expect(schemes.map((s) => [s.version, s.status])).toEqual([
        [1, 'ARCHIVED'],
        [2, 'PUBLISHED'],
      ]);
      expect(
        await ctx.prisma.assessmentScoreRevision.count({ where: { oldMark: { not: null } } }),
      ).toBe(0);
    });
  });

  it('D-02 re-importing the same data changes nothing', async () => {
    const studentRows = () =>
      ctx.prisma.student.findMany({
        orderBy: { id: 'asc' },
        omit: { lastSeenSyncJobId: true, updatedAt: true },
      });
    const studentsBefore = await studentRows();
    const before = await h.digest();
    const revisions = await ctx.prisma.assessmentScoreRevision.count();
    const job = await h.sync(source);
    const after = await h.digest();
    expect(job.status).toBe('SUCCEEDED');
    expect(job.counts.scores).toMatchObject({ created: 0, updated: 0, rejected: 0 });
    expect(after['assessment_scores']).toBe(before['assessment_scores']);
    expect(after['assessment_score_revisions']).toBe(before['assessment_score_revisions']);
    expect(await studentRows()).toEqual(studentsBefore);
    expect(after['grading_schemes']).toBe(before['grading_schemes']);
    expect(after['course_offerings']).toBe(before['course_offerings']);
    expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(revisions);
  });

  it('D-03 one changed mark updates one score and writes one history row', async () => {
    setSheet((s) => (s.tabs['Logic']![1]![5] = 55));
    const before = await ctx.prisma.assessmentScoreRevision.count();
    const job = await h.sync(source);
    expect(job.counts.scores).toMatchObject({ created: 0, updated: 1 });
    const revisions = await ctx.prisma.assessmentScoreRevision.findMany({
      where: { syncJobId: job.id },
    });
    expect(revisions).toHaveLength(1);
    expect(await ctx.prisma.assessmentScoreRevision.count()).toBe(before + 1);
    expect(Number(revisions[0]!.oldMark)).toBe(90);
    expect(Number(revisions[0]!.newMark)).toBe(55);
    expect(revisions[0]!.sourceTab).toBe('Logic');
    expect(revisions[0]!.sourceRow).toBe(2);
  });

  it('D-04 a row missing from a later sync keeps its scores and raises a warning', async () => {
    const scores = await scoreCount(CODE_3, 'Logic');
    expect(scores).toBeGreaterThan(0);
    setSheet((s) => s.tabs['Logic']!.pop());
    const job = await h.sync(source);
    expect(job.status).toBe('SUCCEEDED');
    expect(await scoreCount(CODE_3, 'Logic')).toBe(scores);
    const found = await issues(job.id);
    expect(found.find((i) => i.code === 'ENROLLMENT_MISSING_IN_SOURCE')).toMatchObject({
      sheetTab: 'Logic',
      studentCode: CODE_3,
    });
    const three = await h.activate(CODE_3);
    expect((await course(three, 'Logic')).finalScore).toBe('70.00');
  });

  it('D-04b a student removed from ALL keeps account, scores and login', async () => {
    const before = await ctx.prisma.student.count();
    const three = await h.activate(CODE_3);
    setSheet((s) => {
      for (const tab of ['ALL', 'Logic', 'PL']) {
        s.tabs[tab] = s.tabs[tab]!.filter((r) => r[0] !== CODE_3);
      }
    });
    const job = await h.sync(source);
    expect(job.status).not.toBe('FAILED');
    expect(await ctx.prisma.student.count()).toBe(before);
    expect((await course(three, 'Logic')).finalScore).toBe('70.00');
  });

  it('D-05 recorded: an erased mark stays, with a warning, and the total stays visible', async () => {
    const one = await h.activate(CODE_1);
    setSheet((s) => (s.tabs['Logic']![1]![5] = null));
    const job = await h.sync(source);
    const warned = (await issues(job.id)).find((i) => i.code === 'MARK_CLEARED_IN_SOURCE');
    expect(warned).toMatchObject({ severity: 'WARNING', sheetTab: 'Logic', rowNumber: 2 });
    const logic = await course(one, 'Logic');
    // Q7 default: documented behavior. Blank in the sheet, COMPLETE with the old mark on screen.
    expect(logic).toMatchObject({ status: 'COMPLETE', finalScore: '78.90' });
  });

  describe('D-06 rejected rows name tab and row', () => {
    it('unknown student, duplicate, text, above 100, below 0', async () => {
      setSheet((s) => {
        const logic = s.tabs['Logic']!;
        logic[1]![5] = 'abc';
        logic[2]![6] = 120;
        logic[3]![7] = -5;
        logic.push(['PNC2027-999', 'NO', 'BODY', 'M', 'A', 50, 50, 50, 50, 50, 50, 50]);
        const pl = s.tabs['PL']!;
        pl.push([CODE_3, 'RITHY', 'KEO', 'M', 'B', 1, 2, 3, 4]);
      });
      const job = await h.sync(source);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      const found = await issues(job.id);
      const of = (code: string, tab: string) =>
        found.filter((i) => i.code === code && i.sheetTab === tab);
      expect(of('INVALID_MARK', 'Logic').map((i) => [i.rowNumber, i.rawValue])).toEqual(
        expect.arrayContaining([
          [2, 'abc'],
          [3, '120'],
          [4, '-5'],
        ]),
      );
      expect(of('UNKNOWN_STUDENT', 'Logic')[0]).toMatchObject({
        rowNumber: 5,
        studentCode: 'PNC2027-999',
      });
      expect(
        of('DUPLICATE_ROW', 'PL')
          .map((i) => i.rowNumber)
          .toSorted(),
      ).toEqual([4, 5]);
    });

    it('rows of ENG are numbered from the real sheet row', async () => {
      setSheet((s) => (s.tabs['ENG']![3]![5] = 'bad'));
      const job = await h.sync(source);
      const found = (await issues(job.id)).find((i) => i.sheetTab === 'ENG');
      expect(found).toMatchObject({ code: 'INVALID_MARK', rowNumber: 4 });
    });

    it('a rejected cell keeps the old mark; other cells of the row still apply', async () => {
      setSheet((s) => {
        s.tabs['Logic']![1]![5] = 'abc';
        s.tabs['Logic']![1]![6] = 11;
      });
      const job = await h.sync(source);
      expect(job.counts.scores).toMatchObject({ updated: 1, rejected: 1 });
      const one = await h.activate(CODE_1);
      const marks = (await course(one, 'Logic')).criteria.map((c) => c.score?.mark);
      expect(marks.slice(0, 2)).toEqual(['90.000', '11.000']);
    });
  });

  it('D-09 a duplicate row keeps the old marks and rejects both copies, also across case', async () => {
    const one = await h.activate(CODE_1);
    setSheet((s) => {
      s.tabs['Logic']!.push(['pnc2027-001 ', 'DARA', 'SOK', 'M', 'A', 1, 1, 1, 1, 1, 1, 1]);
    });
    const job = await h.sync(source);
    const found = await issues(job.id);
    expect(found.filter((i) => i.code === 'DUPLICATE_ROW')).toHaveLength(2);
    expect((await course(one, 'Logic')).finalScore).toBe('78.90');
    // A duplicate is not a student who left the tab.
    expect(found.filter((i) => i.code === 'ENROLLMENT_MISSING_IN_SOURCE')).toEqual([]);
  });

  it('D-10 header row 3, a header named f, trailing spaces', async () => {
    const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${source}/mappings`).expect(200))
      .body as (Tab & { headerRow: number })[];
    const byName = (n: string) => tabs.find((t) => t.tabName === n)!;
    expect(byName('ENG').headerRow).toBe(3);
    expect(byName('Logic').headerRow).toBe(1);
    const bcu = byName('BCU').columns.find((c) => c.headerLabel === 'f');
    // Pinned by the project's read.spec.ts: names come from ALL, so `f` is ignored, not a mark.
    expect(bcu?.role).toBe('IGNORE');
    const gym = byName('ENG').columns.find((c) => c.headerLabel.trim() === 'Gymglish');
    expect(gym?.role).toBe('CRITERION');
    expect(gym?.proposedName).toBe('Gymglish');
  });

  it('D-11 _meta and ALL are not read as subjects; unmapped tabs are reported', async () => {
    const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${source}/mappings`).expect(200))
      .body as Tab[];
    const names = tabs.map((t) => t.tabName);
    expect(names).not.toContain('_meta');
    expect(names).not.toContain('ALL');
    setSheet((s) => {
      s.tabs['Science'] = [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
        [CODE_1, 'DARA', 'SOK', 88],
      ];
      s.tabs['_notes'] = [['hello']];
    });
    const job = await h.sync(source);
    const found = await issues(job.id);
    expect(found.filter((i) => i.code === 'UNMAPPED_TAB').map((i) => i.sheetTab)).toEqual([
      'Science',
    ]);
    expect(await ctx.prisma.courseOffering.count({ where: { title: 'Science' } })).toBe(0);
  });

  describe('D-12 changed sheet structure', () => {
    const logicScores = async () =>
      (
        await ctx.prisma.assessmentScore.findMany({
          where: { enrollment: { offering: { title: 'Logic' } } },
          orderBy: { id: 'asc' },
          select: { id: true, mark: true, status: true },
        })
      ).map((s) => `${s.id}:${s.mark.toString()}:${s.status}`);

    it.each<[string, (s: FakeSpreadsheet) => void]>([
      [
        'renamed header',
        (s) => {
          s.tabs['Logic']![0]![5] = 'Quiz One 10%';
        },
      ],
      [
        'two columns swapped',
        (s) => {
          for (const row of s.tabs['Logic']!) [row[5], row[6]] = [row[6]!, row[5]!];
        },
      ],
      [
        'column inserted in the middle',
        (s) => {
          for (const row of s.tabs['Logic']!) row.splice(6, 0, null);
          s.tabs['Logic']![0]![6] = 'Attendance';
        },
      ],
      [
        'column deleted',
        (s) => {
          for (const row of s.tabs['Logic']!) row.splice(5, 1);
        },
      ],
    ])('%s: NEEDS_REMAP, tab skipped, marks untouched, others applied', async (_n, edit) => {
      const before = await logicScores();
      setSheet((s) => {
        edit(s);
        s.tabs['PL']![1]![5] = 1;
      });
      const job = await h.sync(source);
      expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
      expect(
        (await issues(job.id)).some((i) => i.code === 'NEEDS_REMAP' && i.sheetTab === 'Logic'),
      ).toBe(true);
      expect(await logicScores()).toEqual(before);
      expect(job.counts.scores['updated']).toBe(1);
    });

    it('tabs reordered: nothing changes', async () => {
      // Google keeps a tab's sheetId when it moves; the fake numbers tabs by position.
      const sheet = termWorkbookFixture();
      const ids = new Map(Object.keys(sheet.tabs).map((t, i) => [t, i]));
      const reversed = Object.fromEntries(Object.entries(sheet.tabs).toReversed());
      h.reader.set(SHEET_A, { ...sheet, tabs: reversed });
      const real = h.reader.getMetadata.bind(h.reader);
      const spy = vi.spyOn(h.reader, 'getMetadata').mockImplementation(async (id) => {
        const meta = await real(id);
        return { ...meta, tabs: meta.tabs.map((t) => ({ ...t, sheetId: ids.get(t.title)! })) };
      });
      const job = await h.sync(source);
      spy.mockRestore();
      expect(job.errorCount).toBe(0);
      expect(job.counts.scores).toMatchObject({ created: 0, updated: 0 });
    });

    it('a roster gone from the workbook fails the job and changes nothing', async () => {
      const before = await h.digest();
      setSheet((s) => delete s.tabs['ALL']);
      const job = await h.sync(source);
      expect(job.status).toBe('FAILED');
      expect((await h.digest())['assessment_scores']).toBe(before['assessment_scores']);
    });
  });

  it('D-13 hostile strings in names are stored as text and do not break the sync', async () => {
    const script = '<script>alert(1)</script>';
    const sql = "Robert'); DROP TABLE students;--";
    const formula = '=HYPERLINK("http://evil.example","x")';
    setSheet((s) => {
      const all = s.tabs['ALL']!;
      all[3]![1] = script;
      all[3]![2] = sql;
      all[4]![1] = formula;
      s.tabs['Logic']![1]![12] = script;
    });
    const job = await h.sync(source);
    expect(job.status).not.toBe('FAILED');
    const row = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: CODE_1 } });
    expect(row.fullName).toContain(script);
    expect(row.fullName).toContain(sql);
    const bulk = await h.admin
      .post(`${ADMIN_V1}/students/issue-credentials`, { generationId: h.generationId })
      .expect(200);
    const text = String(bulk.text);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  describe('D-15 one sync at a time', () => {
    it('second request while one is queued: 409 on SOURCE and TERM, and through retry', async () => {
      h.reader.fail(SHEET_A, 'SHEET_NOT_SHARED');
      const failed = await h.sync(source);
      expect(failed.status).toBe('FAILED');
      h.reader.set(SHEET_A, termWorkbookFixture());

      const first = await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: source });
      expect(first.status).toBe(202);
      const again = await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: source });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: 'SYNC_IN_PROGRESS', jobId: first.body.jobId });
      const term = await h.admin.post(`${ADMIN_V1}/sync`, {
        scope: 'TERM',
        generationId: h.generationId,
        termId: h.termId,
      });
      expect(term.status).toBe(409);
      const retry = await h.admin.post(`${ADMIN_V1}/sync/${failed.id}/retry`);
      expect(retry.status).toBe(409);
      await h.runJob(first.body.jobId);
    });

    it('six requests at once create one job', async () => {
      const res = await Promise.all(
        Array.from({ length: 6 }, () =>
          h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: source }),
        ),
      );
      expect(res.filter((r) => r.status === 202)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(5);
      await h.runJob(res.find((r) => r.status === 202)!.body.jobId);
    });

    it('recorded: retries are not counted against the sync request limit', async () => {
      h.reader.fail(SHEET_A, 'SHEET_NOT_SHARED');
      const failed = await h.sync(source);
      const statuses: number[] = [];
      let jobId = failed.id;
      for (let i = 0; i < 12; i++) {
        const res = await h.admin.post(`${ADMIN_V1}/sync/${jobId}/retry`);
        statuses.push(res.status);
        if (res.status !== 202) break;
        await h.runJob(res.body.jobId);
        jobId = res.body.jobId;
      }
      // The spec limits POST /admin/sync only; a retry loop bypasses it.
      expect(statuses).not.toContain(429);
    });
  });

  describe('D-23 retry of a job that can no longer run', () => {
    it('disabled source and archived generation are refused', async () => {
      h.reader.fail(SHEET_A, 'SHEET_NOT_SHARED');
      const failed = await h.sync(source);
      await h.admin.patch(`${ADMIN_V1}/sources/${source}`, { status: 'DISABLED' }).expect(200);
      const off = await h.admin.post(`${ADMIN_V1}/sync/${failed.id}/retry`);
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('SOURCE_DISABLED');
      await h.admin.patch(`${ADMIN_V1}/sources/${source}`, { status: 'ACTIVE' });
      await h.admin.post(`${ADMIN_V1}/generations/${h.generationId}/archive`).expect(200);
      const arch = await h.admin.post(`${ADMIN_V1}/sync/${failed.id}/retry`);
      expect(arch.status).toBe(409);
    });
  });

  it('D-18b new subject after release: recorded whether students see it', async () => {
    setSheet((s) => {
      s.tabs['Science'] = [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
        [CODE_1, 'DARA', 'SOK', 88],
      ];
    });
    await h.admin.post(`${ADMIN_V1}/sources/${source}/detect`).expect(200);
    const tabs = (await h.admin.get(`${ADMIN_V1}/sources/${source}/mappings`).expect(200))
      .body as Tab[];
    const sci = tabs.find((t) => t.tabName === 'Science')!;
    await h.admin
      .post(`${ADMIN_V1}/sources/${source}/mappings/${sci.id}/confirm`, confirmBody(sci, 'Science'))
      .expect(200);
    await h.sync(source);
    const one = await h.activate(CODE_1);
    // Decision D7/D16: hidden until released. A released term gets a hidden subject silently.
    expect(await course(one, 'Science')).toBeUndefined();
    const offering = await ctx.prisma.courseOffering.findFirstOrThrow({
      where: { title: 'Science' },
    });
    expect(offering.visibility).toBe('HIDDEN');
  });
});
