import {
  InMemorySheetsReader,
  PROGRAM_T1_SPREADSHEET_ID as T1,
  PROGRAM_T2_SPREADSHEET_ID as T2,
  PROGRAM_WEP_STUDENTS,
  programStudentCode as code,
  programTerm1Workbook,
  programTerm2Class,
  programTerm2Workbook,
} from '@ssrs/sheets/testing';
import { TERMS_PER_GENERATION } from '@ssrs/shared';
import { runSourceSync } from '@ssrs/sync';
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
const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

interface Column {
  columnIndex: number;
  role: string;
  proposedName: string | null;
  proposedWeight: string | null;
}
interface Tab {
  id: string;
  tabName: string;
  audience?: string | null;
  columns: Column[];
}

const confirmBody = (tab: Tab, extra: Record<string, unknown> = {}) => ({
  subjectName: tab.tabName,
  columns: tab.columns.map((c) => ({
    columnIndex: c.columnIndex,
    role: c.role,
    ...(c.role === 'CRITERION' ? { name: c.proposedName, weight: c.proposedWeight } : {}),
  })),
  ...extra,
});

/** A Term 2 class-list request body. */
const classesBody = (wep: string[], snac: string[]) => ({
  programs: [
    { program: 'WEP', classes: wep },
    { program: 'SNAC', classes: snac },
  ],
});

/**
 * Term enrollments through the admin API: class lists, tab audiences, student issues, program
 * switches and class history. Workbooks: made-up people shaped like the real GEN2027 files.
 */
describe('Term enrollments (integration)', () => {
  let ctx: TestContext;
  let reader: InMemorySheetsReader;
  let admin: ReturnType<typeof api>;
  let generationId: string;
  let terms: { id: string; number: number }[];
  let sources: { t1: string; t2: string };

  const list = async (query: string) =>
    (
      await admin
        .get(`${V1}/students?generationId=${generationId}&pageSize=100&${query}`)
        .expect(200)
    ).body as { data: { studentCode: string }[]; meta: { total: number } };

  /** Term 2 synced, then the sheet moves WEP_STUDENT to SNAC (class D) and adds a SNAC mark. */
  async function pendingSwitch() {
    await review(sources.t2);
    await sync(sources.t2);
    const sheet = programTerm2Workbook();
    const row = sheet.tabs['ALL']!.find((r) => r[1] === code(WEP_STUDENT))!;
    row[9] = 'D';
    row[10] = 'SNAC';
    reader.set(T2, sheet);
    await sync(sources.t2);
    const issues = (await admin.get(`${V1}/terms/${terms[1]!.id}/student-issues`).expect(200)).body;
    return issues.data as { id: string; kind: string; studentCode: string; detail: unknown }[];
  }

  /** Detects a workbook and confirms every tab as proposed. */
  async function review(sourceId: string) {
    await admin.post(`${V1}/sources/${sourceId}/detect`).expect(200);
    const tabs = (await admin.get(`${V1}/sources/${sourceId}/mappings`).expect(200)).body as Tab[];
    for (const tab of tabs) {
      await admin
        .post(`${V1}/sources/${sourceId}/mappings/${tab.id}/confirm`, confirmBody(tab))
        .expect(200);
    }
    return tabs;
  }

  async function sync(sourceId: string) {
    const { jobId } = (await admin.post(`${V1}/sync`, { scope: 'SOURCE', sourceId }).expect(202))
      .body;
    await runSourceSync({ prisma: ctx.prisma, reader }, jobId, { attempt: 1, maxAttempts: 1 });
    return (await admin.get(`${V1}/sync/${jobId}`).expect(200)).body;
  }

  async function studentApi(i: number) {
    const row = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: code(i) } });
    const issued = await admin.post(`${V1}/students/${row.id}/reset-password`).expect(200);
    const session = api(await login(ctx, code(i), issued.body.temporaryPassword));
    await session
      .post('/api/v1/auth/change-password', {
        currentPassword: issued.body.temporaryPassword,
        newPassword: STUDENT_PASSWORD,
      })
      .expect(204);
    return { session, id: row.id };
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
    reader.set(T1, programTerm1Workbook()).set(T2, programTerm2Workbook());
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
    terms = (await admin.get(`${V1}/generations/${generationId}/terms`).expect(200)).body;
    const connect = async (termIndex: number, id: string, label: string) =>
      (
        await admin
          .post(`${V1}/terms/${terms[termIndex]!.id}/sources`, { url: urlFor(id), label })
          .expect(201)
      ).body.id as string;
    sources = { t1: await connect(0, T1, 'Term 1'), t2: await connect(1, T2, 'Term 2') };
    await review(sources.t1);
    await sync(sources.t1);
  });

  const WEP_STUDENT = PROGRAM_WEP_STUDENTS.find((i) => i <= 26 && programTerm2Class(i) !== 'A')!;
  const tabsOf = async (sourceId: string) =>
    (await admin.get(`${V1}/sources/${sourceId}/mappings`).expect(200)).body as Tab[];
  const studentRow = (i: number) =>
    ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: code(i) } });

  describe('term numbers', () => {
    it('refuses term number 6 in a sync request, and the database refuses a sixth term', async () => {
      const res = await admin.post(`${V1}/sync`, { scope: 'ALL', termNumber: 6 }).expect(400);
      expect(JSON.stringify(res.body)).toContain('termNumber');
      await expect(
        ctx.prisma.term.create({ data: { generationId, number: 6, name: 'Term 6' } }),
      ).rejects.toThrow(/terms_number_check/);
      // The API limit and the database CHECK say the same number.
      const [check] = await ctx.prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'terms_number_check'`;
      expect(check!.def).toContain(`${TERMS_PER_GENERATION}`);
    });
  });

  describe('tab audience', () => {
    it('detection proposes it from who each tab lists', async () => {
      await admin.post(`${V1}/sources/${sources.t2}/detect`).expect(200);
      const tabs = await tabsOf(sources.t2);
      const audience = Object.fromEntries(tabs.map((t) => [t.tabName, t.audience]));
      expect(audience).toEqual({
        ENG: 'SHARED',
        PL: 'SHARED',
        Algorithm: 'WEP',
        'Web Design': 'WEP',
        CCNA1: 'SNAC',
      });
      expect(
        Object.values(
          Object.fromEntries((await tabsOf(sources.t1)).map((t) => [t.tabName, t.audience])),
        ),
      ).toEqual(['SHARED', 'SHARED']);
    });

    it('is confirmed with the tab, and only a program of the term is accepted', async () => {
      await admin.post(`${V1}/sources/${sources.t2}/detect`).expect(200);
      const tabs = await tabsOf(sources.t2);
      const eng = tabs.find((t) => t.tabName === 'ENG')!;
      const url = `${V1}/sources/${sources.t2}/mappings/${eng.id}/confirm`;
      const bad = await admin.post(url, confirmBody(eng, { audience: 'GENERAL' })).expect(422);
      expect(bad.body.error.code).toBe('UNKNOWN_AUDIENCE');
      const saved = (await admin.post(url, confirmBody(eng, { audience: 'snac' })).expect(200))
        .body;
      expect(saved.audience).toBe('SNAC');
      const shared = (await admin.post(url, confirmBody(eng, { audience: 'SHARED' })).expect(200))
        .body;
      expect(shared.audience).toBe('SHARED');
    });
  });

  describe('class lists', () => {
    it("lists a term's programs and classes with their students", async () => {
      await review(sources.t2);
      await sync(sources.t2);
      const t2 = (await admin.get(`${V1}/terms/${terms[1]!.id}/classes`).expect(200)).body;
      expect(
        t2.programs.map((p: { code: string; classes: { name: string; students: number }[] }) => [
          p.code,
          p.classes.map((c) => `${c.name}:${c.students}`),
        ]),
      ).toEqual([
        ['SNAC', ['D:25']],
        ['WEP', ['A:25', 'B:25', 'C:25']],
      ]);
      const t1 = (await admin.get(`${V1}/terms/${terms[0]!.id}/classes`).expect(200)).body;
      expect(t1.programs.map((p: { code: string }) => p.code)).toEqual(['GENERAL']);
    });

    it('edits a list, refuses a class under two programs and a class that has students', async () => {
      const url = `${V1}/terms/${terms[1]!.id}/classes`;
      const twice = await admin.put(url, classesBody(['A', 'B', 'C', 'd'], ['D'])).expect(422);
      expect(twice.body.error.code).toBe('CLASS_IN_TWO_PROGRAMS');
      const added = (await admin.put(url, classesBody(['A', 'B', 'C', 'E'], ['D'])).expect(200))
        .body;
      expect(added.programs.find((p: { code: string }) => p.code === 'WEP').classes).toHaveLength(
        4,
      );
      expect(await ctx.prisma.auditLog.count({ where: { action: 'term.classes_updated' } })).toBe(
        1,
      );

      await review(sources.t2);
      await sync(sources.t2);
      const inUse = await admin.put(url, classesBody(['A', 'B'], ['D'])).expect(409);
      expect(inUse.body.error.code).toBe('CLASS_IN_USE');
    });
  });

  describe('class history', () => {
    it('shows each term with its program and class, on the admin and student pages', async () => {
      await review(sources.t2);
      await sync(sources.t2);
      const { session, id } = await studentApi(WEP_STUDENT);
      const t2Class = programTerm2Class(WEP_STUDENT);
      const detail = (await admin.get(`${V1}/students/${id}`).expect(200)).body;
      expect(detail.program).toEqual({ code: 'WEP', name: 'Web Programming' });
      expect(detail.className).toBe(t2Class);
      expect(
        detail.terms.map(
          (t: { termNumber: number; program: { code: string }; className: string }) =>
            `T${t.termNumber} ${t.program.code} ${t.className}`,
        ),
      ).toEqual(['T1 GENERAL A', `T2 WEP ${t2Class}`]);
      const me = (await session.get('/api/v1/student/me').expect(200)).body;
      expect(
        me.terms.map(
          (t: { termNumber: number; className: string }) => `T${t.termNumber} ${t.className}`,
        ),
      ).toEqual(['T1 A', `T2 ${t2Class}`]);
    });

    it('filters by class within a term, and by program', async () => {
      await review(sources.t2);
      await sync(sources.t2);
      const t1A = await list(`termId=${terms[0]!.id}&className=A`);
      expect(t1A.meta.total).toBe(26);
      expect(t1A.data.map((s) => s.studentCode)).toContain(code(WEP_STUDENT));
      expect((await list(`termId=${terms[1]!.id}&program=SNAC`)).meta.total).toBe(25);
      expect((await list('program=WEP')).meta.total).toBe(75);
      // Alone, the class is the latest one.
      expect((await list('className=A')).data.map((s) => s.studentCode)).not.toContain(
        code(WEP_STUDENT),
      );
    });
  });

  describe('student issues', () => {
    it('lists a program switch, and approving it withdraws the old program’s subjects', async () => {
      const issues = await pendingSwitch();
      expect(issues.map((i) => [i.kind, i.studentCode])).toEqual([
        ['PROGRAM_SWITCH', code(WEP_STUDENT)],
      ]);
      const { session, id } = await studentApi(WEP_STUDENT);
      await admin.post(`${V1}/terms/${terms[1]!.id}/release`, { visible: true }).expect(200);
      const titlesFor = async () =>
        (await session.get('/api/v1/student/me/results?term=2').expect(200)).body.terms[0].courses
          .map((c: { title: string }) => c.title)
          .toSorted();
      expect(await titlesFor()).toEqual(['Algorithm', 'ENG', 'PL']);

      const approved = (
        await admin.post(`${V1}/student-issues/${issues[0]!.id}/approve`).expect(200)
      ).body;
      expect(approved).toMatchObject({ resolution: 'APPROVED', resolvedAt: expect.any(String) });
      const detail = (await admin.get(`${V1}/students/${id}`).expect(200)).body;
      expect(detail.terms[1]).toMatchObject({ program: { code: 'SNAC' }, className: 'D' });
      // Algorithm is WEP only: hidden from the student, kept and flagged for admins.
      expect(await titlesFor()).toEqual(['ENG', 'PL']);
      const adminView = (await admin.get(`${V1}/students/${id}/results`).expect(200)).body;
      const algorithm = adminView.terms[1].courses.find(
        (c: { title: string }) => c.title === 'Algorithm',
      );
      expect(algorithm.admin).toMatchObject({
        enrollmentStatus: 'WITHDRAWN',
        endedReason: 'PROGRAM_SWITCH',
      });
      expect(algorithm.criteria.some((c: { score: unknown }) => c.score !== null)).toBe(true);
    });

    it('reversing an approved switch restores the program, class and subjects', async () => {
      const issues = await pendingSwitch();
      const { id } = await studentApi(WEP_STUDENT);
      await admin.post(`${V1}/student-issues/${issues[0]!.id}/approve`).expect(200);
      const reversed = (
        await admin.post(`${V1}/student-issues/${issues[0]!.id}/reverse`).expect(200)
      ).body;
      expect(reversed.resolution).toBe('REVERSED');
      const detail = (await admin.get(`${V1}/students/${id}`).expect(200)).body;
      expect(detail.terms[1]).toMatchObject({
        program: { code: 'WEP' },
        className: programTerm2Class(WEP_STUDENT),
      });
      const algorithm = await ctx.prisma.enrollment.findFirstOrThrow({
        where: { studentId: id, offering: { title: 'Algorithm' } },
      });
      expect(algorithm).toMatchObject({ status: 'ENROLLED', endedReason: null });
      await admin.post(`${V1}/student-issues/${issues[0]!.id}/reverse`).expect(409);
    });

    it('an admin assignment settles an unknown class and is kept by the next sync', async () => {
      const sheet = programTerm2Workbook();
      sheet.tabs['ALL']!.find((r) => r[1] === code(WEP_STUDENT))![9] = 'Z';
      reader.set(T2, sheet);
      await review(sources.t2);
      await sync(sources.t2);
      const open = (await admin.get(`${V1}/terms/${terms[1]!.id}/student-issues`).expect(200)).body;
      expect(open.data.map((i: { kind: string }) => i.kind)).toEqual(['UNKNOWN_CLASS']);
      const { id } = await studentRow(WEP_STUDENT);
      await admin
        .put(`${V1}/students/${id}/terms/${terms[1]!.id}`, { program: 'WEP', className: 'Q' })
        .expect(422);
      await admin
        .put(`${V1}/students/${id}/terms/${terms[1]!.id}`, { program: 'WEP', className: 'B' })
        .expect(200);
      const resolved = (
        await admin.get(`${V1}/terms/${terms[1]!.id}/student-issues?status=RESOLVED`).expect(200)
      ).body;
      expect(resolved.data.map((i: { resolution: string }) => i.resolution)).toEqual([
        'ADMIN_ASSIGNED',
      ]);
      const detail = (await admin.get(`${V1}/students/${id}`).expect(200)).body;
      expect(detail.terms[1]).toMatchObject({ className: 'B', programSource: 'ADMIN' });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'student_term.assigned' } })).toBe(
        1,
      );
    });
  });
});
