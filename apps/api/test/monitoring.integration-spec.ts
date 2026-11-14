/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import {
  InMemorySheetsReader,
  PROGRAM_SNAC_STUDENTS,
  PROGRAM_T1_SPREADSHEET_ID as T1,
  PROGRAM_T2_SPREADSHEET_ID as T2,
  PROGRAM_WEP_STUDENTS,
  programStudentCode as code,
  programTerm1Workbook,
  programTerm2Class,
  programTerm2Workbook,
  type FakeSpreadsheet,
} from '@ssrs/sheets/testing';
import type {
  MonitoringGenerationsView,
  MonitoringLevel,
  MonitoringStudentRow,
  MonitoringStudentsPage,
  MonitoringSubjectRow,
  MonitoringSubjectSummaryView,
  MonitoringTermSubjectsView,
} from '@ssrs/shared';
import { runSourceSync } from '@ssrs/sync';
import request from 'supertest';
import {
  api,
  clearRateLimits,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';
import { testAdminPassword, testStudentPassword } from './support/credentials.js';

/**
 * Admin subject monitoring (docs/decisions.md "Subject monitoring" M1–M8), through the API, with
 * made-up students (IDs PNC2027-001…101; names FNxxx/LNxxx). Term 1 (General): ENG, PL, Logic,
 * BCU, MATH. Term 2: ENG and PL shared, Algorithm and Web Design WEP only, CCNA1 SNAC only, with an
 * approved and a pending program switch, an unknown class, a withdrawn row, a row missing from
 * its tab, a NEEDS_REVIEW mark, a CLEARED mark, a blank component and an archived subject.
 */

const ADMIN = { username: 'admin', password: testAdminPassword() };
const STUDENT_PASSWORD = testStudentPassword();
const V1 = '/api/v1';
const A = `${V1}/admin`;
const M = `${A}/monitoring`;
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

const pad = (i: number) => String(i).padStart(3, '0');
const profile = (i: number, cls: string) => [code(i), `FN${pad(i)}`, `LN${pad(i)}`, i % 2 ? 'M' : 'F', cls];
const T1_CLASS = (i: number) => (i <= 26 ? 'A' : i <= 50 ? 'B' : i <= 75 ? 'C' : 'D');
const T1_STUDENTS = Array.from({ length: 101 }, (_, k) => k + 1);
const HEAD = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS', 'Quiz 50%', 'Final 50%', 'COMMENTS'];

/** Teacher comment of PNC2027-001 in Logic: markup and a line break, kept as plain text. */
const COMMENT = '<b>Not bold</b> & <i>x</i>\nSecond line <script>alert(1)</script>';
/** Logic marks chosen for exact levels (official scale: A≥85, B+≥80, B≥70, C+≥65, C≥60, D≥50, E). */
const LOGIC_FIXED: Record<number, [number | null, number | null]> = {
  2: [80, null], // blank component → INCOMPLETE
  5: [100, 100], // 100 A VERY_GOOD
  6: [40, 40], // 40 E FAIL
  7: [75, 65], // 70 B GOOD
  8: [60, 60], // 60 C FAIR
  9: [50, 49], // 49.5 E FAIL
  11: [85, 85], // 85 A
  12: [50, 50], // 50 D FAIR
};
const BLANK = 2;
const CLEARED = 3;

function term1Workbook(opts: { clearLogicQuizOf?: number } = {}): FakeSpreadsheet {
  const sheet = programTerm1Workbook();
  const tab = (marks: (i: number) => [number | null, number | null], comment?: (i: number) => string | null) => [
    HEAD,
    ...T1_STUDENTS.map((i) => {
      const [q, f] = marks(i);
      return [...profile(i, T1_CLASS(i)), q, f, comment?.(i) ?? null];
    }),
  ];
  sheet.tabs['Logic'] = tab(
    (i) => {
      if (i === opts.clearLogicQuizOf) return [null, 70];
      return LOGIC_FIXED[i] ?? [55 + (i % 40), 60 + (i % 35)];
    },
    (i) => (i === 1 ? COMMENT : null),
  );
  // BCU: the subject with the most Fails.
  sheet.tabs['BCU'] = tab((i) => (i % 5 === 0 ? [90, 90] : [10 + (i % 30), 20 + (i % 25)]));
  sheet.tabs['MATH'] = tab((i) => [45 + ((i * 3) % 55), 50 + ((i * 7) % 50)]);
  return sheet;
}

/** The WEP student who switches to SNAC and is approved; and one whose switch stays pending. */
const SWITCHED = PROGRAM_WEP_STUDENTS.find((i) => i <= 26 && programTerm2Class(i) !== 'A')!;
const PENDING = PROGRAM_WEP_STUDENTS.find((i) => i > 30 && i !== SWITCHED)!;
/** A student whose Term 2 class is not in the class list: no Term 2 enrollment. */
const UNKNOWN = PROGRAM_WEP_STUDENTS.find((i) => i > 60 && i !== PENDING)!;
/** A SNAC student who disappears from the PL tab on the second Term 2 sync. */
const MISSING = PROGRAM_SNAC_STUDENTS[0]!;

function term2Workbook(stage: 1 | 2): FakeSpreadsheet {
  const sheet = programTerm2Workbook();
  // Web Design: every row keeps its own name, so the tab imports (the fixture shifts names).
  sheet.tabs['Web Design'] = sheet.tabs['Web Design']!.map((row, k) =>
    k < 3 ? row : [row[0] ?? null, row[1] ?? null, `FN${String(row[1]).slice(-3)}`, `LN${String(row[1]).slice(-3)}`, ...row.slice(4)],
  );
  const all = sheet.tabs['ALL']!;
  const unknown = all.find((r) => r[1] === code(UNKNOWN))!;
  unknown[9] = 'Z';
  unknown[10] = 'WEP Z';
  if (stage === 2) {
    for (const i of [SWITCHED, PENDING]) {
      const row = all.find((r) => r[1] === code(i))!;
      row[9] = 'D';
      row[10] = 'SNAC';
    }
    sheet.tabs['PL'] = sheet.tabs['PL']!.filter((r) => r[1] !== code(MISSING));
  }
  return sheet;
}

interface Tab {
  id: string;
  tabName: string;
  columns: { columnIndex: number; role: string; proposedName: string | null; proposedWeight: string | null }[];
}

interface AdminCourse {
  offeringId: string;
  title: string;
  status: string;
  finalScore: string | null;
  finalGrade: string | null;
  teacherComment: string | null;
  criteria: { criterionId: string; score: { status: string; mark: string } | null }[];
  admin?: { enrollmentStatus: string; endedReason: string | null; presentInSource: boolean };
}
interface AdminResults {
  terms: { number: number; courses: AdminCourse[] }[];
}

const OFFICIAL_LEVEL: Record<string, MonitoringLevel> = {
  A: 'VERY_GOOD',
  'B+': 'VERY_GOOD',
  B: 'GOOD',
  'C+': 'GOOD',
  C: 'FAIR',
  D: 'FAIR',
  E: 'FAIL',
};
const LEVELS: MonitoringLevel[] = ['VERY_GOOD', 'GOOD', 'FAIR', 'FAIL', 'INCOMPLETE'];

describe('Subject monitoring (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;
  let terms: { id: string; number: number }[];
  let sources: { t1: string; t2: string };
  /** courseId by Term 1 / Term 2 title. */
  const subject: Record<1 | 2, Record<string, string>> = { 1: {}, 2: {} };
  /** Every student's admin results (the student view, with admin metadata). */
  const adminViews = new Map<string, AdminResults>();
  let studentIdByCode: Map<string, string>;

  async function review(sourceId: string) {
    await admin.post(`${A}/sources/${sourceId}/detect`).expect(200);
    const tabs = (await admin.get(`${A}/sources/${sourceId}/mappings`).expect(200)).body as Tab[];
    for (const tab of tabs) {
      await admin
        .post(`${A}/sources/${sourceId}/mappings/${tab.id}/confirm`, {
          subjectName: tab.tabName,
          columns: tab.columns.map((c) => ({
            columnIndex: c.columnIndex,
            role: c.role,
            ...(c.role === 'CRITERION' ? { name: c.proposedName, weight: c.proposedWeight } : {}),
          })),
        })
        .expect(200);
    }
  }
  async function sync(sourceId: string) {
    const { jobId } = (await admin.post(`${A}/sync`, { scope: 'SOURCE', sourceId }).expect(202)).body;
    await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
    return (await admin.get(`${A}/sync/${jobId}`).expect(200)).body;
  }
  const q = (term: 1 | 2, title: string, extra = '') =>
    `generationId=${generationId}&termNumber=${term}&subjectId=${subject[term][title]}${extra}`;
  const page1 = async (term: 1 | 2, extra = '') =>
    (await admin.get(`${M}/terms/${generationId}/${term}/subjects${extra}`).expect(200))
      .body as MonitoringTermSubjectsView;
  const summary = async (term: 1 | 2, title: string, extra = '') =>
    (await admin.get(`${M}/subjects/summary?${q(term, title, extra)}`).expect(200))
      .body as MonitoringSubjectSummaryView;
  const students = async (term: 1 | 2, title: string, extra = '') =>
    (await admin.get(`${M}/subjects/students?${q(term, title, extra)}`).expect(200))
      .body as MonitoringStudentsPage;
  /** Every row of a subject selection, through all pages of 100. */
  async function allRows(term: 1 | 2, title: string, extra = '') {
    const out: MonitoringStudentRow[] = [];
    for (let page = 1; ; page++) {
      const body = await students(term, title, `${extra}&pageSize=100&page=${page}`);
      out.push(...body.data);
      if (out.length >= body.meta.total || body.data.length === 0) return { rows: out, total: body.meta.total };
    }
  }
  const adminCourse = (studentId: string, term: number, offeringId: string) =>
    adminViews
      .get(studentId)
      ?.terms.find((t) => t.number === term)
      ?.courses.find((c) => c.offeringId === offeringId);

  beforeAll(async () => {
    reader = new InMemorySheetsReader();
    ctx = await createTestApp({ sheetsReader: reader });
    await resetState(ctx);
    reader.set(T1, term1Workbook()).set(T2, term2Workbook(1));
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    generationId = (
      await admin
        .post(`${A}/generations`, { code: 'GEN2027', name: 'Generation 2027', startDate: '2026-11-02' })
        .expect(201)
    ).body.id;
    terms = (await admin.get(`${A}/generations/${generationId}/terms`).expect(200)).body;
    const connect = async (index: number, id: string, label: string) =>
      (await admin.post(`${A}/terms/${terms[index]!.id}/sources`, { url: urlFor(id), label }).expect(201))
        .body.id as string;
    sources = { t1: await connect(0, T1, 'Term 1'), t2: await connect(1, T2, 'Term 2') };

    // Term 1: import, then erase one Logic quiz (CLEARED).
    await review(sources.t1);
    const t1a = await sync(sources.t1);
    expect(t1a.status, JSON.stringify(t1a.counts)).toMatch(/SUCCEEDED/);
    reader.set(T1, term1Workbook({ clearLogicQuizOf: CLEARED }));
    await sync(sources.t1);

    // Term 2: import; then two switches, one approved, and a student missing from PL.
    await review(sources.t2);
    await sync(sources.t2);
    reader.set(T2, term2Workbook(2));
    await sync(sources.t2);
    const issues = (await admin.get(`${A}/terms/${terms[1]!.id}/student-issues`).expect(200)).body
      .data as { id: string; kind: string; studentCode: string }[];
    const sw = issues.find((i) => i.kind === 'PROGRAM_SWITCH' && i.studentCode === code(SWITCHED));
    expect(sw, JSON.stringify(issues.map((i) => [i.kind, i.studentCode]))).toBeDefined();
    await admin.post(`${A}/student-issues/${sw!.id}/approve`).expect(200);

    for (const t of [0, 1]) {
      await admin.post(`${A}/terms/${terms[t]!.id}/release`, { visible: true }).expect(200);
    }
    for (const n of [1, 2] as const) {
      const offerings = await ctx.prisma.courseOffering.findMany({ where: { termId: terms[n - 1]!.id } });
      for (const o of offerings) subject[n][o.title] = o.courseId;
    }

    // Data the sheet cannot produce: a mark above its maximum (NEEDS_REVIEW) and a withdrawn row.
    const pl2 = await ctx.prisma.courseOffering.findFirstOrThrow({ where: { termId: terms[1]!.id, title: 'PL' } });
    const review1 = await ctx.prisma.enrollment.findFirstOrThrow({
      where: { offeringId: pl2.id, student: { studentCode: code(PROGRAM_WEP_STUDENTS[2]!) } },
      include: { scores: { include: { criterion: true } } },
    });
    await ctx.prisma.assessmentScore.update({
      where: { id: review1.scores[0]!.id },
      data: { mark: '150' },
    });
    const eng2 = await ctx.prisma.courseOffering.findFirstOrThrow({ where: { termId: terms[1]!.id, title: 'ENG' } });
    await ctx.prisma.enrollment.updateMany({
      where: { offeringId: eng2.id, student: { studentCode: code(PROGRAM_WEP_STUDENTS[3]!) } },
      data: { status: 'WITHDRAWN' },
    });
    // Archive Web Design (as the removed-subjects flow would).
    await ctx.prisma.courseOffering.updateMany({
      where: { termId: terms[1]!.id, title: 'Web Design' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await ctx.prisma.generation.update({ where: { id: generationId }, data: { cacheVersion: { increment: 1 } } });

    const all = await ctx.prisma.student.findMany({ select: { id: true, studentCode: true } });
    studentIdByCode = new Map(all.map((s) => [s.studentCode, s.id]));
    for (const s of all) {
      adminViews.set(s.id, (await admin.get(`${A}/students/${s.id}/results`).expect(200)).body);
    }
  }, 300_000);

  afterAll(async () => ctx.close());

  describe('generations', () => {
    it('lists GEN2027 with its five terms and subject counts', async () => {
      const body = (await admin.get(`${M}/generations`).expect(200)).body as MonitoringGenerationsView;
      const gen = body.data.find((g) => g.id === generationId)!;
      expect(gen).toMatchObject({ code: 'GEN2027', status: 'ACTIVE' });
      expect(gen.terms.map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
      expect(gen.terms[0]!.subjects).toBe(5);
      // ENG, PL, Algorithm, CCNA1; Web Design is archived: active subjects only.
      expect(gen.terms[1]!.subjects).toBe(4);
      expect(gen.terms[0]!.releaseState).toBe('RELEASED');
      expect(gen.terms[2]!.releaseState).toBe('EMPTY');
      expect(gen.terms[0]!.lastSyncedAt).not.toBeNull();
    });
  });

  describe('AC1 / AC2 / AC7: page 1', () => {
    it('AC1 Term 1 lists all 5 subjects; level counts add up to each subject’s students', async () => {
      const body = await page1(1);
      expect(body.subjects.map((s) => s.title).toSorted()).toEqual(['BCU', 'ENG', 'Logic', 'MATH', 'PL']);
      expect(body.term.programs.map((p) => p.code)).toEqual(['GENERAL']);
      expect(body.gradeScale.usable).toBe(true);
      for (const s of body.subjects) {
        const sum = LEVELS.reduce((n, l) => n + s.levels[l], 0);
        expect(sum, s.title).toBe(s.students);
        expect(s.complete + s.levels.INCOMPLETE, s.title).toBe(s.students);
        const enrolled = await ctx.prisma.enrollment.count({
          where: { offeringId: s.offeringId, status: 'ENROLLED' },
        });
        expect(s.students, s.title).toBe(enrolled);
      }
      // ENG's row with a name nobody has is a warning only (not another student's name): 101.
      expect(body.subjects.find((s) => s.title === 'ENG')!.students).toBe(101);
      expect(body.subjects.find((s) => s.title === 'Logic')!.students).toBe(101);
      // Default sort: by name.
      expect(body.subjects.map((s) => s.title)).toEqual(['BCU', 'ENG', 'Logic', 'MATH', 'PL']);
    });

    it('AC2 sort=fail puts the subject with most Fails first, descending', async () => {
      const body = await page1(1, '?sort=fail');
      const fails = body.subjects.map((s) => s.levels.FAIL);
      expect(body.subjects[0]!.title).toBe('BCU');
      expect(fails).toEqual(fails.toSorted((a, b) => b - a));
      expect(fails[0]).toBeGreaterThan(fails[1]!);
    });

    it('AC7 page 1 and page 2 (All programs) agree for every subject of both terms, incl. archived', async () => {
      for (const term of [1, 2] as const) {
        const body = await page1(term, '?includeArchived=true');
        for (const s of body.subjects) {
          const sum = (
            await admin
              .get(`${M}/subjects/summary?generationId=${generationId}&termNumber=${term}&subjectId=${s.subjectId}`)
              .expect(200)
          ).body as MonitoringSubjectSummaryView;
          const label = `T${term} ${s.title}`;
          expect(sum.stats.students, label).toBe(s.students);
          expect(sum.stats.complete, label).toBe(s.complete);
          expect(sum.stats.needsReview, label).toBe(s.needsReview);
          expect(sum.stats.passRate, label).toBe(s.passRate);
          expect(Object.fromEntries(sum.stats.levels!.map((l) => [l.level, l.count])), label).toEqual(s.levels);
          const table = await admin
            .get(
              `${M}/subjects/students?generationId=${generationId}&termNumber=${term}&subjectId=${s.subjectId}&pageSize=100`,
            )
            .expect(200);
          const enrolledRows = (table.body.data as MonitoringStudentRow[]).filter((r) => !r.flags.withdrawn);
          if (table.body.meta.total <= 100) expect(enrolledRows.length, label).toBe(s.students);
        }
      }
    });

    it('AC12 an archived subject is hidden unless includeArchived=true; page 2 still returns it flagged', async () => {
      const plain = await page1(2);
      expect(plain.subjects.map((s) => s.title)).not.toContain('Web Design');
      const withArchived = await page1(2, '?includeArchived=true');
      const wd = withArchived.subjects.find((s) => s.title === 'Web Design')!;
      expect(wd).toMatchObject({ archived: true, audience: { kind: 'PROGRAM' } });
      expect(wd.archivedAt).not.toBeNull();
      expect(wd.students).toBeGreaterThan(0);
      for (const extra of ['', '&includeArchived=false', '&includeArchived=true']) {
        const s = await summary(2, 'Web Design', extra);
        expect(s.subject.archived, extra).toBe(true);
        expect(s.stats.students).toBe(wd.students);
        const rows = await students(2, 'Web Design', extra);
        expect(rows.meta.total).toBeGreaterThan(0);
      }
      // The term's release state reads active subjects only.
      expect(plain.term.releaseState).toBe('RELEASED');
    });
  });

  describe('AC3: page 2 equals the student view (parity)', () => {
    it('every enrolled student of English Term 1 is listed with marks, total, grade and level', async () => {
      const { rows, total } = await allRows(1, 'ENG');
      const eng = await ctx.prisma.courseOffering.findFirstOrThrow({ where: { termId: terms[0]!.id, title: 'ENG' } });
      const enrolled = await ctx.prisma.enrollment.findMany({
        where: { offeringId: eng.id },
        include: { student: true },
      });
      expect(total).toBe(enrolled.length);
      expect(rows.map((r) => r.studentCode).toSorted()).toEqual(enrolled.map((e) => e.student.studentCode).toSorted());
      expect(rows.map((r) => r.studentCode)).toEqual(rows.map((r) => r.studentCode).toSorted());
    });

    it('for every student of every subject of both terms: status, total, grade, marks match /admin/students/:id/results', async () => {
      let compared = 0;
      const mismatches: string[] = [];
      for (const term of [1, 2] as const) {
        const body = await page1(term, '?includeArchived=true');
        for (const s of body.subjects) {
          // Archived subjects are not in any results view (students or admin): nothing to compare.
          if (s.archived) continue;
          const { rows } = await allRows(term, s.title, '&includeArchived=true');
          for (const r of rows) {
            const view = adminCourse(r.studentId, term, s.offeringId);
            if (!view) {
              mismatches.push(`T${term} ${s.title} ${r.studentCode}: not in the admin view`);
              continue;
            }
            const got = [r.status, r.finalScore, r.finalGrade, r.teacherComment, r.flags.withdrawn];
            const want = [
              view.status,
              view.finalScore,
              view.finalGrade,
              view.teacherComment,
              view.admin!.enrollmentStatus !== 'ENROLLED',
            ];
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              mismatches.push(`T${term} ${s.title} ${r.studentCode}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
            }
            for (const c of view.criteria) {
              if (JSON.stringify(r.marks[c.criterionId] ?? null) !== JSON.stringify(c.score)) {
                mismatches.push(`T${term} ${s.title} ${r.studentCode} criterion ${c.criterionId}`);
              }
            }
            const level = r.status === 'COMPLETE' ? OFFICIAL_LEVEL[r.finalGrade ?? ''] ?? null : 'INCOMPLETE';
            if (r.level !== level) mismatches.push(`T${term} ${s.title} ${r.studentCode}: level ${r.level} vs ${level}`);
            compared++;
          }
        }
      }
      console.log(`[AC3] parity: ${compared} monitoring rows compared, ${mismatches.length} mismatches`);
      expect(mismatches).toEqual([]);
      expect(compared).toBeGreaterThan(780);
    });

    it('matches what real students see in /student/me/results (Term-1-only, WEP, SNAC, switched)', async () => {
      const codes = [code(76), code(PROGRAM_WEP_STUDENTS[0]!), code(PROGRAM_SNAC_STUDENTS[1]!), code(SWITCHED)];
      for (const c of codes) {
        await clearRateLimits(ctx);
        const id = studentIdByCode.get(c)!;
        const issued = await admin.post(`${A}/students/${id}/reset-password`).expect(200);
        const session = api(await login(ctx, c, issued.body.temporaryPassword));
        await session
          .post(`${V1}/auth/change-password`, {
            currentPassword: issued.body.temporaryPassword,
            newPassword: STUDENT_PASSWORD,
          })
          .expect(204);
        const mine = (await session.get(`${V1}/student/me/results`).expect(200)).body as AdminResults;
        let seen = 0;
        for (const t of mine.terms) {
          for (const course of t.courses) {
            const title = course.title;
            const rows = await students(t.number as 1 | 2, title, `&search=${encodeURIComponent(c)}&includeArchived=true`);
            const row = rows.data.find((r) => r.studentCode === c)!;
            expect(row, `${c} T${t.number} ${title}`).toBeDefined();
            expect([row.status, row.finalScore, row.finalGrade], `${c} T${t.number} ${title}`).toEqual([
              course.status,
              course.finalScore,
              course.finalGrade,
            ]);
            seen++;
          }
        }
        expect(seen, c).toBeGreaterThan(0);
        // A student never sees a withdrawn subject; monitoring lists it, flagged.
        if (c === code(SWITCHED)) {
          const titles = mine.terms.find((t) => t.number === 2)!.courses.map((x) => x.title);
          expect(titles).not.toContain('Algorithm');
          const alg = await students(2, 'Algorithm', `&search=${c}`);
          expect(alg.data[0]!.flags).toMatchObject({ withdrawn: true, withdrawnByProgramSwitch: true });
        }
      }
    });
  });

  describe('AC4 / AC5: programs and classes', () => {
    it('AC4 shared ENG Term 2, all programs: WEP and SNAC students with program and class', async () => {
      const s = await summary(2, 'ENG');
      expect(s.filters.programFilter).toBe(true);
      expect(s.filters.programs.map((p) => p.code)).toEqual(['SNAC', 'WEP']);
      expect(s.subject.audience.kind).toBe('SHARED');
      expect(s.filters.classes.map((c) => `${c.programCode} ${c.name}`)).toEqual(['SNAC D', 'WEP A', 'WEP B', 'WEP C']);
      const { rows } = await allRows(2, 'ENG');
      const programs = new Set(rows.map((r) => r.program?.code));
      expect(programs).toEqual(new Set(['WEP', 'SNAC']));
      for (const r of rows) {
        expect(r.className, r.studentCode).toMatch(/^[ABCD]$/);
        expect(r.program!.code === 'SNAC', r.studentCode).toBe(r.className === 'D');
      }
    });

    it('AC4 program=SNAC shows only class D, and its counts are a subset', async () => {
      const all = await summary(2, 'ENG');
      const snac = await summary(2, 'ENG', '&program=SNAC');
      const wep = await summary(2, 'ENG', '&program=WEP');
      expect(snac.filters.classes.map((c) => c.name)).toEqual(['D']);
      expect(snac.stats.students + wep.stats.students).toBe(all.stats.students);
      const { rows } = await allRows(2, 'ENG', '&program=SNAC');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect([r.program?.code, r.className]).toEqual(['SNAC', 'D']);
      // Lower case and className filters too.
      const lower = await students(2, 'ENG', '&program=snac&pageSize=100');
      expect(lower.meta.total).toBe(rows.length);
      const classD = await students(2, 'ENG', '&className=d&pageSize=100');
      expect(classD.meta.total).toBe(rows.length);
      const classA = await allRows(2, 'ENG', '&program=WEP&className=A');
      for (const r of classA.rows) expect(r.className).toBe('A');
    });

    it('AC5 a WEP-only subject never offers SNAC; program=SNAC → 422', async () => {
      const s = await summary(2, 'Algorithm');
      expect(s.subject.audience).toMatchObject({ kind: 'PROGRAM' });
      expect(s.filters.programs.map((p) => p.code)).toEqual(['WEP']);
      for (const path of ['summary', 'students']) {
        const res = await admin.get(`${M}/subjects/${path}?${q(2, 'Algorithm', '&program=SNAC')}`).expect(422);
        expect(res.body.error?.code ?? res.body.code).toBe('PROGRAM_NOT_OFFERED');
      }
      const ccna = await summary(2, 'CCNA1');
      expect(ccna.filters.programs.map((p) => p.code)).toEqual(['SNAC']);
      await admin.get(`${M}/subjects/students?${q(2, 'CCNA1', '&program=WEP')}`).expect(422);
      // A class of another program.
      const res = await admin.get(`${M}/subjects/summary?${q(2, 'ENG', '&program=WEP&className=D')}`).expect(422);
      expect(JSON.stringify(res.body)).toContain('CLASS_NOT_IN_PROGRAM');
      // Term 1 has one program: no Program filter.
      expect((await summary(1, 'ENG')).filters.programFilter).toBe(false);
    });
  });

  describe('AC6 and the counting rules', () => {
    it('AC6 one blank component → INCOMPLETE, no total/grade, not a Fail, not in the average', async () => {
      const row = (await students(1, 'Logic', `&search=${code(BLANK)}`)).data[0]!;
      expect(row).toMatchObject({ status: 'INCOMPLETE', finalScore: null, finalGrade: null, level: 'INCOMPLETE' });
      expect(Object.values(row.marks).filter((m) => m === null)).toHaveLength(1);
      const s = await summary(1, 'Logic');
      const { rows } = await allRows(1, 'Logic');
      const complete = rows.filter((r) => r.status === 'COMPLETE' && !r.flags.withdrawn);
      expect(s.stats.complete).toBe(complete.length);
      expect(s.stats.incomplete).toBe(rows.length - complete.length);
      const fails = rows.filter((r) => r.finalGrade === 'E').length;
      expect(s.stats.levels!.find((l) => l.level === 'FAIL')!.count).toBe(fails);
      // Average over COMPLETE only (2 dp, half up).
      const sum = complete.reduce((n, r) => n + Math.round(Number(r.finalScore) * 100), 0);
      expect(Number(s.stats.averageTotal)).toBeCloseTo(sum / 100 / complete.length, 2);
      const totals = complete.map((r) => Number(r.finalScore));
      expect(Number(s.stats.highestTotal)).toBe(Math.max(...totals));
      expect(Number(s.stats.lowestTotal)).toBe(Math.min(...totals));
      const passed = complete.filter((r) => r.finalGrade !== 'E').length;
      expect(s.stats.passRate).toBe(((passed / complete.length) * 100).toFixed(1));
    });

    it('exact levels on known Logic marks (A/E/B/C/E/A/D)', async () => {
      const want: Record<number, [string, string, MonitoringLevel]> = {
        5: ['100.00', 'A', 'VERY_GOOD'],
        6: ['40.00', 'E', 'FAIL'],
        7: ['70.00', 'B', 'GOOD'],
        8: ['60.00', 'C', 'FAIR'],
        9: ['49.50', 'E', 'FAIL'],
        11: ['85.00', 'A', 'VERY_GOOD'],
        12: ['50.00', 'D', 'FAIR'],
      };
      for (const [i, [total, grade, level]] of Object.entries(want)) {
        const row = (await students(1, 'Logic', `&search=${code(Number(i))}`)).data[0]!;
        expect([row.finalScore, row.finalGrade, row.level], code(Number(i))).toEqual([total, grade, level]);
      }
    });

    it('a CLEARED mark is not entered: "-" (null), INCOMPLETE, kept in history', async () => {
      const row = (await students(1, 'Logic', `&search=${code(CLEARED)}`)).data[0]!;
      expect(row.status).toBe('INCOMPLETE');
      expect(Object.values(row.marks).filter((m) => m === null)).toHaveLength(1);
      const cleared = await ctx.prisma.assessmentScore.count({
        where: { status: 'CLEARED', enrollment: { student: { studentCode: code(CLEARED) } } },
      });
      expect(cleared).toBe(1);
    });

    it('NEEDS_REVIEW counts as INCOMPLETE and in needsReview; flagged', async () => {
      const s = await summary(2, 'PL');
      expect(s.stats.needsReview).toBe(1);
      const row = (await students(2, 'PL', `&search=${code(PROGRAM_WEP_STUDENTS[2]!)}`)).data[0]!;
      expect(row).toMatchObject({ status: 'NEEDS_REVIEW', level: 'INCOMPLETE', finalScore: null });
      expect(row.flags.needsReview).toBe(true);
      const incomplete = await students(2, 'PL', '&level=INCOMPLETE&pageSize=100');
      expect(incomplete.data.map((r) => r.studentCode)).toContain(row.studentCode);
      expect(s.stats.incomplete).toBeGreaterThanOrEqual(s.stats.needsReview);
    });

    it('withdrawn rows are listed and flagged, excluded from counts and from the level filter', async () => {
      const s = await summary(2, 'ENG');
      expect(s.notes.withdrawn).toBe(1);
      expect(s.notes.withdrawnByProgramSwitch).toBe(0);
      const { rows } = await allRows(2, 'ENG');
      expect(rows.filter((r) => r.flags.withdrawn)).toHaveLength(1);
      expect(s.stats.students).toBe(rows.length - 1);
      const levelTotal = s.stats.levels!.reduce((n, l) => n + l.count, 0);
      expect(levelTotal).toBe(s.stats.students);
      for (const level of LEVELS) {
        const filtered = await students(2, 'ENG', `&level=${level}&pageSize=100`);
        expect(filtered.data.some((r) => r.flags.withdrawn), level).toBe(false);
        expect(filtered.meta.total, level).toBe(s.stats.levels!.find((l) => l.level === level)!.count);
      }
    });

    it('an approved program switch: Algorithm row withdrawn by PROGRAM_SWITCH, counted in notes only', async () => {
      const s = await summary(2, 'Algorithm');
      expect(s.notes.withdrawnByProgramSwitch).toBe(1);
      expect(s.notes.withdrawn).toBe(1);
      const row = (await students(2, 'Algorithm', `&search=${code(SWITCHED)}`)).data[0]!;
      expect(row.program?.code).toBe('SNAC');
      expect(row.className).toBe('D');
      expect(row.flags).toMatchObject({ withdrawn: true, withdrawnByProgramSwitch: true });
      expect(Object.values(row.marks).some((m) => m !== null)).toBe(true);
    });

    it('notes: pending switch, missing from sheet, term-level undetermined program', async () => {
      const pl = await summary(2, 'PL');
      expect(pl.notes.missingFromSheet).toBe(1);
      const missing = (await students(2, 'PL', `&search=${code(MISSING)}`)).data[0]!;
      expect(missing.flags.presentInSource).toBe(false);
      // Counted.
      const { rows } = await allRows(2, 'PL');
      expect(pl.stats.students).toBe(rows.filter((r) => !r.flags.withdrawn).length);

      const eng = await summary(2, 'ENG');
      expect(eng.notes.pendingProgramSwitch).toBe(1);
      const ccna = await summary(2, 'CCNA1');
      expect(ccna.notes.pendingProgramSwitch).toBe(0);
      // Term-level, the same for every subject; distinct students.
      const issues = await ctx.prisma.studentTermIssue.findMany({
        where: { termId: terms[1]!.id, resolvedAt: null, kind: { not: 'PROGRAM_SWITCH' } },
        select: { studentId: true, kind: true },
      });
      const distinct = new Set(issues.map((i) => i.studentId ?? `${i.kind}`)).size;
      expect(distinct).toBeGreaterThan(0);
      expect(eng.notes.termUndeterminedProgram).toBe(distinct);
      expect(ccna.notes.termUndeterminedProgram).toBe(distinct);
      // The student with an unknown class has no Term 2 enrollment at all.
      const unknownRows = await students(2, 'ENG', `&search=${code(UNKNOWN)}`);
      expect(unknownRows.meta.total).toBe(0);
    });
  });

  describe('AC8: the grade scale is read on every load', () => {
    it('changing a band’s level and threshold changes levels at once; unusable scale → totals only', async () => {
      const scale = await ctx.prisma.gradeScale.findUniqueOrThrow({
        where: { generationId },
        include: { bands: true },
      });
      const b = scale.bands.find((x) => x.letter === 'B')!;
      const before = await summary(1, 'Logic');
      const row7 = async () => (await students(1, 'Logic', `&search=${code(7)}`)).data[0]!;
      expect((await row7()).level).toBe('GOOD');
      try {
        await ctx.prisma.gradeBand.update({ where: { id: b.id }, data: { level: 'FAIR' } });
        expect((await row7()).level).toBe('FAIR');
        const after = await summary(1, 'Logic');
        const count = (s: MonitoringSubjectSummaryView, l: MonitoringLevel) => s.stats.levels!.find((x) => x.level === l)!.count;
        const bCount = (await allRows(1, 'Logic', '&level=FAIR')).rows.filter((r) => r.finalGrade === 'B').length;
        expect(bCount).toBeGreaterThan(0);
        expect(count(after, 'FAIR')).toBe(count(before, 'FAIR') + bCount);
        expect(count(after, 'GOOD')).toBe(count(before, 'GOOD') - bCount);
        const legend = after.gradeScale.levels.find((l) => l.level === 'FAIR')!.letters;
        expect(legend).toContain('B');

        // Threshold: A from 85 to 99 → student 11 (85.00) is now B+.
        const a = scale.bands.find((x) => x.letter === 'A')!;
        await ctx.prisma.gradeBand.update({ where: { id: a.id }, data: { minTotal: '99' } });
        const r11 = (await students(1, 'Logic', `&search=${code(11)}`)).data[0]!;
        expect([r11.finalGrade, r11.level]).toEqual(['B+', 'VERY_GOOD']);
        await ctx.prisma.gradeBand.update({ where: { id: a.id }, data: { minTotal: a.minTotal } });

        // Not confirmed → no usable scale: no grade, no graded level, totals stay.
        await ctx.prisma.gradeScale.update({ where: { id: scale.id }, data: { confirmed: false } });
        const p1 = await page1(1);
        expect(p1.gradeScale).toEqual({ usable: false, levels: [] });
        for (const s of p1.subjects) {
          expect([s.levels.VERY_GOOD, s.levels.GOOD, s.levels.FAIR, s.levels.FAIL], s.title).toEqual([0, 0, 0, 0]);
          expect(s.passRate, s.title).toBeNull();
          expect(s.levels.INCOMPLETE + s.complete, s.title).toBe(s.students);
        }
        const s2 = await summary(1, 'Logic');
        expect(s2.stats.levels).toBeNull();
        expect(s2.stats.passRate).toBeNull();
        expect(s2.stats.averageTotal).toBe(before.stats.averageTotal);
        const r5 = (await students(1, 'Logic', `&search=${code(5)}`)).data[0]!;
        expect([r5.finalScore, r5.finalGrade, r5.level]).toEqual(['100.00', null, null]);
        const r2 = (await students(1, 'Logic', `&search=${code(BLANK)}`)).data[0]!;
        expect(r2.level).toBe('INCOMPLETE');
        // A graded level filter finds nothing without a scale.
        expect((await students(1, 'Logic', '&level=VERY_GOOD')).meta.total).toBe(0);
      } finally {
        await ctx.prisma.gradeBand.update({ where: { id: b.id }, data: { level: 'GOOD' } });
        await ctx.prisma.gradeScale.update({ where: { id: scale.id }, data: { confirmed: true } });
      }
      expect((await row7()).level).toBe('GOOD');
    });
  });

  describe('AC9: access', () => {
    it('students get 403 and anonymous callers 401 on every monitoring endpoint', async () => {
      await clearRateLimits(ctx);
      const c = code(PROGRAM_WEP_STUDENTS[5]!);
      const id = studentIdByCode.get(c)!;
      const issued = await admin.post(`${A}/students/${id}/reset-password`).expect(200);
      const session = await login(ctx, c, issued.body.temporaryPassword);
      const urls = [
        `${M}/generations`,
        `${M}/terms/${generationId}/1/subjects`,
        `${M}/subjects/summary?${q(1, 'ENG')}`,
        `${M}/subjects/students?${q(1, 'ENG')}`,
      ];
      for (const url of urls) {
        const res = await session.agent.get(url);
        // A must-change-password student is refused too; it must never be 200.
        expect([403], url).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toMatch(/PNC2027|FN\d{3}/);
        expect((await request(ctx.app.getHttpServer()).get(url)).status, url).toBe(401);
        expect(
          (await request(ctx.app.getHttpServer()).get(url).set('Cookie', 'ssrs_at=garbage')).status,
          url,
        ).toBe(401);
      }
    });

    it('responses are not cacheable', async () => {
      const res = await admin.get(`${M}/subjects/summary?${q(1, 'ENG')}`).expect(200);
      expect(String(res.headers['cache-control'] ?? '')).toMatch(/no-store|private|no-cache/);
    });
  });

  describe('AC10: paging, sorting, search and filters together', () => {
    it('default page size 25; pageSize 100 accepted; 101 and 0 rejected', async () => {
      const first = await students(1, 'Logic');
      expect(first.meta).toEqual({ page: 1, pageSize: 25, total: 101 });
      expect(first.data).toHaveLength(25);
      expect((await students(1, 'Logic', '&pageSize=100')).data).toHaveLength(100);
      for (const bad of ['pageSize=101', 'pageSize=0', 'pageSize=abc', 'page=0', 'page=-1', 'pageSize=1e3']) {
        await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&${bad}`).expect(400);
      }
    });

    it('pages do not overlap and cover every row; past the end is empty', async () => {
      const seen: string[] = [];
      for (let p = 1; p <= 5; p++) {
        const body = await students(1, 'Logic', `&page=${p}`);
        seen.push(...body.data.map((r) => r.studentCode));
      }
      expect(seen).toHaveLength(101);
      expect(new Set(seen).size).toBe(101);
      const past = await students(1, 'Logic', '&page=6');
      expect(past.data).toEqual([]);
      expect(past.meta.total).toBe(101);
    });

    it('sorts by total (nulls last both ways), name, level, grade and criterion:<id>', async () => {
      const check = async (sort: string, order: 'asc' | 'desc', key: (r: MonitoringStudentRow) => number | string | null) => {
        const { rows } = await allRows(1, 'Logic', `&sort=${encodeURIComponent(sort)}&order=${order}`);
        const vals = rows.map(key);
        const firstNull = vals.indexOf(null);
        if (firstNull >= 0) expect(vals.slice(firstNull).every((v) => v === null), `${sort} ${order} nulls last`).toBe(true);
        const nonNull = vals.filter((v) => v !== null) as (number | string)[];
        const sorted = nonNull.toSorted((a, b) =>
          typeof a === 'number' ? (a as number) - (b as number) : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }),
        );
        expect(nonNull, `${sort} ${order}`).toEqual(order === 'asc' ? sorted : sorted.toReversed());
        return rows;
      };
      await check('total', 'asc', (r) => (r.finalScore === null ? null : Number(r.finalScore)));
      await check('total', 'desc', (r) => (r.finalScore === null ? null : Number(r.finalScore)));
      await check('name', 'asc', (r) => r.fullName);
      await check('studentCode', 'desc', (r) => r.studentCode);
      await check('level', 'asc', (r) => (r.level === null ? null : LEVELS.indexOf(r.level)));
      const criteria = (await summary(1, 'Logic')).criteria;
      expect(criteria.length).toBe(2);
      for (const c of criteria) {
        const rows = await check(`criterion:${c.criterionId}`, 'desc', (r) => {
          const m = r.marks[c.criterionId];
          return m ? (m.status === 'ABSENT' ? 0 : Number(m.mark)) : null;
        });
        expect(rows).toHaveLength(101);
      }
      // A criterion of another subject, or a bad key.
      const eng = (await summary(1, 'ENG')).criteria[0]!;
      const other = await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&sort=criterion:${eng.criterionId}`);
      expect(other.status).toBe(422);
      for (const bad of ['criterion:abc', 'fullName', 'total;drop', 'criterion:']) {
        await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&sort=${encodeURIComponent(bad)}`).expect(400);
      }
      await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&order=up`).expect(400);
      await admin.get(`${M}/terms/${generationId}/1/subjects?sort=pass`).expect(400);
    });

    it('search (ID or name, case-insensitive) + level + sort + paging combine', async () => {
      expect((await students(1, 'Logic', '&search=pnc2027-00')).meta.total).toBe(9);
      expect((await students(1, 'Logic', '&search=fn011')).data.map((r) => r.studentCode)).toEqual([code(11)]);
      expect((await students(1, 'Logic', '&search=%20%20LN012%20')).data.map((r) => r.studentCode)).toEqual([code(12)]);
      expect((await students(1, 'Logic', '&search=nobody-here')).meta.total).toBe(0);
      expect((await students(1, 'Logic', '&search=%25')).meta.total).toBe(0);
      expect((await students(1, 'Logic', '&search=_')).meta.total).toBe(0);
      await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&search=${'x'.repeat(101)}`).expect(400);
      await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&level=EXCELLENT`).expect(400);

      const fails = await allRows(1, 'Logic', '&level=FAIL');
      const combined = await students(1, 'Logic', '&level=FAIL&search=PNC2027-0&sort=total&order=desc&pageSize=2&page=1');
      const expected = fails.rows
        .filter((r) => r.studentCode.includes('PNC2027-0'))
        .toSorted((a, b) => Number(b.finalScore) - Number(a.finalScore) || a.studentCode.localeCompare(b.studentCode));
      expect(combined.meta.total).toBe(expected.length);
      expect(combined.data.map((r) => r.studentCode)).toEqual(expected.slice(0, 2).map((r) => r.studentCode));
      for (const r of combined.data) expect(r.level).toBe('FAIL');
    });

    it('search with a NUL byte is refused or harmless (never 500)', async () => {
      const res = await admin.get(`${M}/subjects/students?${q(1, 'Logic')}&search=a%00b`);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    });
  });

  describe('AC15: validation', () => {
    it('termNumber 0 / 6 / x → 400; bad UUID → 400; unknown term → 404', async () => {
      for (const t of ['0', '6', 'x', '1.5', '-1', '01a']) {
        await admin.get(`${M}/terms/${generationId}/${t}/subjects`).expect(400);
        await admin.get(`${M}/subjects/summary?generationId=${generationId}&termNumber=${t}&subjectId=${subject[1]['ENG']}`).expect(400);
        await admin.get(`${M}/subjects/students?generationId=${generationId}&termNumber=${t}&subjectId=${subject[1]['ENG']}`).expect(400);
      }
      await admin.get(`${M}/terms/not-a-uuid/1/subjects`).expect(400);
      await admin.get(`${M}/subjects/summary?generationId=nope&termNumber=1&subjectId=${subject[1]['ENG']}`).expect(400);
      await admin.get(`${M}/subjects/summary?generationId=${generationId}&termNumber=1&subjectId=nope`).expect(400);
      await admin.get(`${M}/subjects/summary?termNumber=1&subjectId=${subject[1]['ENG']}`).expect(400);
      await admin.get(`${M}/subjects/summary?generationId=${generationId}&subjectId=${subject[1]['ENG']}`).expect(400);
      const zero = '00000000-0000-7000-8000-000000000000';
      await admin.get(`${M}/terms/${zero}/1/subjects`).expect(404);
      await admin.get(`${M}/subjects/summary?generationId=${zero}&termNumber=1&subjectId=${subject[1]['ENG']}`).expect(404);
      // A term without a sheet: empty list, not an error.
      const t3 = await page1(3 as 1);
      expect(t3.subjects).toEqual([]);
      expect(t3.lastSync).toBeNull();
      expect(t3.term.releaseState).toBe('EMPTY');
    });

    it('subject not in term → 404 SUBJECT_NOT_IN_TERM; className not in term → 422', async () => {
      const res = await admin.get(
        `${M}/subjects/summary?generationId=${generationId}&termNumber=1&subjectId=${subject[2]['Algorithm']}`,
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain('SUBJECT_NOT_IN_TERM');
      const st = await admin.get(
        `${M}/subjects/students?generationId=${generationId}&termNumber=1&subjectId=${subject[2]['Algorithm']}`,
      );
      expect(st.status).toBe(404);
      for (const path of ['summary', 'students']) {
        const bad = await admin.get(`${M}/subjects/${path}?${q(1, 'ENG', '&className=Z')}`);
        expect(bad.status, path).toBe(422);
        expect(JSON.stringify(bad.body)).toContain('CLASS_NOT_IN_TERM');
      }
      await admin.get(`${M}/subjects/summary?${q(1, 'ENG', '&program=WEP')}`).expect(422);
      await admin.get(`${M}/subjects/summary?${q(1, 'ENG', '&unknown=1')}`).expect(400);
      await admin.get(`${M}/subjects/summary?${q(1, 'ENG', `&program=${'X'.repeat(17)}`)}`).expect(400);
    });

    it('parameter pollution never gives a 500', async () => {
      for (const extra of ['&termNumber=2', '&subjectId[]=x', '&program=WEP&program=SNAC', '&page=1&page=2', '&level[]=FAIL']) {
        const res = await admin.get(`${M}/subjects/students?${q(2, 'ENG')}${extra}`);
        expect(res.status, extra).toBeGreaterThanOrEqual(200);
        expect(res.status, extra).toBeLessThan(500);
      }
    });
  });

  describe('AC16: teacher comment', () => {
    it('is returned as plain text, unchanged (markup and line breaks kept)', async () => {
      const row = (await students(1, 'Logic', `&search=${code(1)}`)).data[0]!;
      expect(row.teacherComment).toBe(COMMENT);
      const res = await admin.get(`${M}/subjects/students?${q(1, 'Logic', `&search=${code(1)}`)}`);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('read-only', () => {
    it('viewing writes nothing (no audit, no score change)', async () => {
      const before = await Promise.all([
        ctx.prisma.auditLog.count(),
        ctx.prisma.assessmentScore.count(),
        ctx.prisma.enrollment.count(),
      ]);
      await page1(1);
      await summary(2, 'ENG');
      await students(2, 'ENG');
      await admin.get(`${M}/generations`).expect(200);
      const after = await Promise.all([
        ctx.prisma.auditLog.count(),
        ctx.prisma.assessmentScore.count(),
        ctx.prisma.enrollment.count(),
      ]);
      expect(after).toEqual(before);
    });
  });
});
