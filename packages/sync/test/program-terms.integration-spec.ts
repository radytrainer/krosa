import { applyTermDefaults, createPrismaClient, type PrismaClient } from '@ssrs/database';
import { assertTestDatabaseUrl, truncateAllTables } from '@ssrs/database/testing';
import {
  InMemorySheetsReader,
  PROGRAM_SNAC_STUDENTS,
  PROGRAM_T1_ONLY,
  PROGRAM_WEP_STUDENTS,
  PROGRAM_T1_SPREADSHEET_ID as T1,
  PROGRAM_T2_SPREADSHEET_ID as T2,
  programStudentCode as code,
  programTerm1Workbook,
  programTerm2Class,
  programTerm2Workbook,
} from '@ssrs/sheets/testing';
import { runSourceSync } from '../src/engine.js';
import { previewSource } from '../src/preview.js';
import { confirmAllTabs } from '../src/testing.js';
import type { SyncCounts } from '../src/types.js';

/**
 * Term enrollments across terms, on the two program workbooks (made-up people shaped like the
 * real GEN2027 Term 1 and Term 2 files).
 */
let prisma: PrismaClient;
let reader: InMemorySheetsReader;
let adminId: string;
let termIds: string[];
let sources: { t1: string; t2: string };

async function sync(sourceId: string) {
  const job = await prisma.syncJob.create({
    data: { scope: 'SOURCE', sourceId, requestedById: adminId },
  });
  await runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 1 });
  const row = await prisma.syncJob.findUniqueOrThrow({
    where: { id: job.id },
    include: { errors: true },
  });
  return { job: row, counts: row.counts as unknown as SyncCounts };
}

const student = (i: number) =>
  prisma.student.findUniqueOrThrow({ where: { studentCode: code(i) } });

beforeAll(() => {
  prisma = createPrismaClient({
    connectionString: assertTestDatabaseUrl(process.env['TEST_DATABASE_URL']),
    poolMax: 4,
    log: [],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  reader = new InMemorySheetsReader()
    .set(T1, programTerm1Workbook())
    .set(T2, programTerm2Workbook());
  adminId = (
    await prisma.user.create({ data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' } })
  ).id;
  const generation = await prisma.generation.create({
    data: {
      code: 'GEN2027',
      name: 'Generation 2027',
      startDate: new Date('2026-11-02'),
      terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
    },
    include: { terms: { orderBy: { number: 'asc' } } },
  });
  await applyTermDefaults(prisma, generation.id);
  termIds = generation.terms.map((t) => t.id);
  const source = (termId: string, spreadsheetId: string, label: string) =>
    prisma.googleSheetSource.create({
      data: { generationId: generation.id, termId, spreadsheetId, label, createdById: adminId },
    });
  sources = {
    t1: (await source(termIds[0]!, T1, 'Term 1')).id,
    t2: (await source(termIds[1]!, T2, 'Term 2')).id,
  };
  await confirmAllTabs(prisma, reader, sources.t1);
  await confirmAllTabs(prisma, reader, sources.t2);
});

// ---------------------------------------------------------------------------------------------

const WEP_STUDENT = PROGRAM_WEP_STUDENTS[0]!;
const SNAC_STUDENT = PROGRAM_SNAC_STUDENTS[0]!;
const ALL_CLASS = 9;
const ALL_CLASS2 = 10;
type Tabs = ReturnType<typeof programTerm2Workbook>['tabs'];

/** The Term 2 workbook after `change` edits it, set as the sheet a sync reads. */
function term2(change: (tabs: Tabs) => void = () => undefined) {
  const sheet = programTerm2Workbook();
  change(sheet.tabs);
  reader.set(T2, sheet);
}
const rosterRow = (tabs: Tabs, i: number) => tabs['ALL']!.find((r) => r[1] === code(i))!;
const tabRow = (tabs: Tabs, tab: string, i: number) => tabs[tab]!.find((r) => r[1] === code(i))!;

/** Term number → "PROGRAM class" for one student. */
async function termsOf(i: number) {
  const rows = await prisma.studentTerm.findMany({
    where: { student: { studentCode: code(i) } },
    include: { term: true, program: true, class: true },
  });
  return Object.fromEntries(rows.map((r) => [r.term.number, `${r.program.code} ${r.class.name}`]));
}

async function countBy(termNumber: number) {
  const rows = await prisma.studentTerm.findMany({
    where: { term: { number: termNumber } },
    include: { program: true, class: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.program.code} ${r.class.name}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Term 1's enrollments and marks, to prove a later sync never touches them. */
const term1Snapshot = async () => ({
  terms: await prisma.studentTerm.findMany({
    where: { termId: termIds[0] },
    orderBy: { id: 'asc' },
    select: { id: true, programId: true, classId: true, updatedAt: true },
  }),
  scores: await prisma.assessmentScore.findMany({
    where: { enrollment: { offering: { termId: termIds[0] } } },
    orderBy: { id: 'asc' },
    select: { id: true, mark: true, status: true, updatedAt: true },
  }),
});

/** students.class_name and program_id equal the enrollment of the highest term, for everyone. */
async function expectLatestInStep() {
  const students = await prisma.student.findMany({
    include: { terms: { include: { term: true, class: true } } },
  });
  for (const s of students) {
    const latest = s.terms.toSorted((a, b) => b.term.number - a.term.number)[0];
    expect([s.studentCode, s.className, s.programId]).toEqual([
      s.studentCode,
      latest?.class.name ?? null,
      latest?.programId ?? null,
    ]);
  }
}

type Job = Awaited<ReturnType<typeof sync>>['job'];
const issuesOf = (job: Job, c: string) => job.errors.filter((e) => e.code === c);

const openIssues = () =>
  prisma.studentTermIssue.findMany({
    where: { resolvedAt: null },
    orderBy: { studentCode: 'asc' },
  });

const enrolled = (title: string, i?: number) =>
  prisma.enrollment.count({
    where: {
      offering: { title, termId: termIds[1] },
      ...(i ? { student: { studentCode: code(i) } } : {}),
    },
  });

/** Forgets the audience of three Term 2 tabs, as if nobody had chosen one. */
const forget = () =>
  prisma.sheetTabMapping.updateMany({
    where: { sourceId: sources.t2, tabName: { in: ['Algorithm', 'ENG', 'CCNA1'] } },
    data: { audience: null, audienceProgramId: null },
  });
const audienceOf = async (tabName: string) => {
  const tab = await prisma.sheetTabMapping.findFirstOrThrow({
    where: { sourceId: sources.t2, tabName },
    include: { audienceProgram: true },
  });
  return tab.audience === 'PROGRAM' ? tab.audienceProgram?.code : tab.audience;
};

describe('Term 1 (General)', () => {
  it('creates a General enrollment for all 101 students, classes A to D from ALL', async () => {
    const { job, counts } = await sync(sources.t1);
    expect(job.status).toBe('SUCCEEDED');
    expect(await countBy(1)).toEqual({
      'GENERAL A': 26,
      'GENERAL B': 24,
      'GENERAL C': 25,
      'GENERAL D': 26,
    });
    expect(counts.termEnrollments).toEqual({
      created: 101,
      classChanged: 0,
      unchanged: 0,
      blocked: 0,
    });
    // A subject-tab class that differs from ALL: a warning per tab, ALL's class is kept.
    const classWarnings = issuesOf(job, 'PROFILE_MISMATCH').filter((e) => e.columnKey === 'CLASS');
    expect(classWarnings.map((e) => e.studentCode).toSorted()).toEqual([
      'PNC2027-051',
      'PNC2027-051',
      'PNC2027-076',
      'PNC2027-076',
    ]);
    expect(await termsOf(51)).toEqual({ 1: 'GENERAL C' });
    expect(await termsOf(76)).toEqual({ 1: 'GENERAL D' });
    expect(await prisma.enrollment.count()).toBe(202);
    await expectLatestInStep();
  });
});

describe('Term 2 (WEP and SNAC)', () => {
  beforeEach(async () => {
    await sync(sources.t1);
  });

  it('creates 75 WEP and 25 SNAC enrollments from ALL and leaves Term 1 untouched', async () => {
    const before = await term1Snapshot();
    const { job, counts } = await sync(sources.t2);
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS'); // Web Design is blocked
    expect(await countBy(2)).toEqual({ 'WEP A': 25, 'WEP B': 25, 'WEP C': 25, 'SNAC D': 25 });
    expect(counts.termEnrollments).toEqual({
      created: 100,
      classChanged: 0,
      unchanged: 0,
      blocked: 0,
    });
    expect(await term1Snapshot()).toEqual(before);
    expect(await termsOf(1)).toEqual({ 1: 'GENERAL A', 2: `WEP ${programTerm2Class(1)}` });
    await expectLatestInStep();
  });

  it('the student who left after Term 1 keeps it, gets nothing for Term 2, and no error', async () => {
    const { job } = await sync(sources.t2);
    expect(await termsOf(PROGRAM_T1_ONLY)).toEqual({ 1: 'GENERAL D' });
    expect(job.errors.filter((e) => e.studentCode === code(PROGRAM_T1_ONLY))).toEqual([]);
    expect((await student(PROGRAM_T1_ONLY)).className).toBe('D');
  });

  it('imports each subject for its audience; nobody is warned about another program', async () => {
    const { job } = await sync(sources.t2);
    expect(await enrolled('ENG')).toBe(100);
    expect(await enrolled('Algorithm')).toBe(75);
    expect(await enrolled('CCNA1')).toBe(25);
    expect(issuesOf(job, 'STUDENT_MISSING_FROM_TAB')).toEqual([]);
    const programs = await prisma.offeringProgram.findMany({
      include: { offering: true, program: true },
    });
    // Web Design is blocked before it is applied, so its audience is not on the subject yet.
    expect(programs.map((p) => `${p.offering.title} ${p.program.code}`).toSorted()).toEqual([
      'Algorithm WEP',
      'CCNA1 SNAC',
    ]);
  });

  it("blocks Web Design with one error: 74 of 75 rows carry another student's name", async () => {
    const { job } = await sync(sources.t2);
    expect(issuesOf(job, 'IDENTITY_MISMATCH_TAB')).toHaveLength(1);
    expect(job.errorCount).toBe(1);
    expect(await enrolled('Web Design')).toBe(0);
  });

  it('rejects a SNAC student in a WEP-only tab; a WEP student gone from it is flagged', async () => {
    await sync(sources.t2);
    term2((tabs) => {
      const n = String(SNAC_STUDENT).padStart(3, '0');
      const algo = tabs['Algorithm']!;
      algo.push([99, code(SNAC_STUDENT), `FN${n}`, `LN${n}`, 'M', 'D', 'SNAC', 60, 60]);
      algo.splice(algo.indexOf(tabRow(tabs, 'Algorithm', WEP_STUDENT)), 1);
    });
    const { job } = await sync(sources.t2);
    expect(issuesOf(job, 'PROGRAM_NOT_IN_AUDIENCE').map((e) => e.studentCode)).toEqual([
      code(SNAC_STUDENT),
    ]);
    expect(await enrolled('Algorithm', SNAC_STUDENT)).toBe(0);
    // The WEP student's Algorithm enrollment and marks are kept, flagged as missing.
    expect(issuesOf(job, 'ENROLLMENT_MISSING_IN_SOURCE').map((e) => e.studentCode)).toEqual([
      code(WEP_STUDENT),
    ]);
  });

  it('re-syncing the same workbook changes nothing', async () => {
    await sync(sources.t2);
    const select = { id: true, classId: true, programId: true } as const;
    const terms = await prisma.studentTerm.findMany({ orderBy: { id: 'asc' }, select });
    const scores = await prisma.assessmentScore.count();
    // Every sync writes its own sync.completed entry; nothing else may be added.
    const changes = () => prisma.auditLog.count({ where: { action: { not: 'sync.completed' } } });
    const audits = await changes();
    const { counts } = await sync(sources.t2);
    expect(counts.termEnrollments).toEqual({
      created: 0,
      classChanged: 0,
      unchanged: 100,
      blocked: 0,
    });
    expect(counts.scores).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.studentTerm.findMany({ orderBy: { id: 'asc' }, select })).toEqual(terms);
    expect(await prisma.assessmentScore.count()).toBe(scores);
    expect(await changes()).toBe(audits);
  });

  it('a class change within the program changes only Term 2, with an audit entry', async () => {
    await sync(sources.t2);
    const before = await term1Snapshot();
    const from = programTerm2Class(WEP_STUDENT)!;
    const to = from === 'A' ? 'B' : 'A';
    term2((tabs) => {
      rosterRow(tabs, WEP_STUDENT)[ALL_CLASS] = to;
      rosterRow(tabs, WEP_STUDENT)[ALL_CLASS2] = `WEP ${to}`;
    });
    const { counts } = await sync(sources.t2);
    expect(counts.termEnrollments).toMatchObject({ classChanged: 1, created: 0 });
    expect((await termsOf(WEP_STUDENT))[2]).toBe(`WEP ${to}`);
    expect(await term1Snapshot()).toEqual(before);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student_term.class_changed' },
    });
    expect(audit.metadata).toMatchObject({
      studentCode: code(WEP_STUDENT),
      termNumber: 2,
      from,
      to,
    });
    expect((await student(WEP_STUDENT)).className).toBe(to);
    await expectLatestInStep();
  });

  it('a program change within the term waits for an admin; shared subjects still import', async () => {
    await sync(sources.t2);
    term2((tabs) => {
      rosterRow(tabs, WEP_STUDENT)[ALL_CLASS] = 'D';
      rosterRow(tabs, WEP_STUDENT)[ALL_CLASS2] = 'SNAC';
      tabRow(tabs, 'ENG', WEP_STUDENT)[7] = 99; // a new shared mark
      tabRow(tabs, 'Algorithm', WEP_STUDENT)[7] = 98; // a new WEP-only mark
    });
    const { job } = await sync(sources.t2);
    expect((await termsOf(WEP_STUDENT))[2]).toBe(`WEP ${programTerm2Class(WEP_STUDENT)}`);
    expect((await openIssues()).map((i) => [i.studentCode, i.kind, i.detail])).toEqual([
      [code(WEP_STUDENT), 'PROGRAM_SWITCH', expect.objectContaining({ from: 'WEP', to: 'SNAC' })],
    ]);
    const firstMark = async (title: string) =>
      (
        await prisma.assessmentScore.findFirstOrThrow({
          where: {
            enrollment: {
              student: { studentCode: code(WEP_STUDENT) },
              offering: { title, termId: termIds[1] },
            },
            criterion: { displayOrder: 1 },
          },
        })
      ).mark.toString();
    expect(await firstMark('ENG')).toBe('99');
    expect(await firstMark('Algorithm')).not.toBe('98');
    expect(issuesOf(job, 'PROGRAM_SWITCH_PENDING').length).toBeGreaterThan(0);
  });

  it('an unknown class, a disagreeing CLASS 2 and a duplicate in ALL block only that student', async () => {
    const [unknown, conflict, duplicate] = PROGRAM_WEP_STUDENTS.slice(1, 4) as [
      number,
      number,
      number,
    ];
    term2((tabs) => {
      rosterRow(tabs, unknown)[ALL_CLASS] = 'E';
      rosterRow(tabs, conflict)[ALL_CLASS2] = 'SNAC';
      const copy = [...rosterRow(tabs, duplicate)];
      copy[ALL_CLASS] = 'D';
      tabs['ALL']!.push(copy);
    });
    const { job, counts } = await sync(sources.t2);
    expect(counts.termEnrollments).toMatchObject({ created: 97, blocked: 3 });
    const open = await openIssues();
    const expected: [string, string][] = [
      [code(unknown), 'UNKNOWN_CLASS'],
      [code(conflict), 'PROGRAM_CONFLICT'],
      [code(duplicate), 'DUPLICATE_IN_ROSTER'],
    ];
    expect(open.map((i) => [i.studentCode, i.kind])).toEqual(
      expected.toSorted((a, b) => a[0].localeCompare(b[0])),
    );
    expect(open.find((i) => i.kind === 'DUPLICATE_IN_ROSTER')!.detail).toMatchObject({
      classes: [programTerm2Class(duplicate), 'D'],
    });
    for (const i of [unknown, conflict, duplicate]) {
      expect((await termsOf(i))[2]).toBeUndefined();
    }
    expect(issuesOf(job, 'NO_TERM_ENROLLMENT').map((e) => e.studentCode)).toContain(code(unknown));

    // Fixing the sheet closes the issues and creates the enrollments.
    term2();
    const fixed = await sync(sources.t2);
    expect(fixed.counts.termEnrollments).toMatchObject({ created: 3, blocked: 0 });
    expect(await openIssues()).toEqual([]);
    await expectLatestInStep();
  });

  it('MAJOR that differs from ALL warns and still imports', async () => {
    term2((tabs) => {
      tabRow(tabs, 'ENG', WEP_STUDENT)[6] = 'SNAC';
    });
    const { job } = await sync(sources.t2);
    const warning = issuesOf(job, 'PROFILE_MISMATCH').find(
      (e) => e.studentCode === code(WEP_STUDENT) && e.columnKey === 'MAJOR',
    );
    expect(warning).toBeDefined();
    expect(await enrolled('ENG', WEP_STUDENT)).toBe(1);
  });

  it('an admin-assigned program wins; a class of another program is a conflict', async () => {
    await sync(sources.t2);
    const snac = await prisma.program.findUniqueOrThrow({ where: { code: 'SNAC' } });
    const classD = await prisma.termClass.findFirstOrThrow({
      where: { termId: termIds[1], name: 'D' },
    });
    await prisma.studentTerm.updateMany({
      where: { student: { studentCode: code(WEP_STUDENT) }, termId: termIds[1] },
      data: { programId: snac.id, classId: classD.id, programSource: 'ADMIN' },
    });
    await sync(sources.t2);
    expect((await termsOf(WEP_STUDENT))[2]).toBe('SNAC D');
    expect((await openIssues()).map((i) => [i.studentCode, i.kind])).toEqual([
      [code(WEP_STUDENT), 'PROGRAM_CONFLICT'],
    ]);
  });

  describe('a tab nobody gave an audience', () => {
    it('gets one guessed from who it lists, saved once and reported', async () => {
      await forget();
      const { job } = await sync(sources.t2);
      expect(
        issuesOf(job, 'AUDIENCE_GUESSED')
          .map((e) => e.sheetTab)
          .toSorted(),
      ).toEqual(['Algorithm', 'CCNA1', 'ENG']);
      expect([
        await audienceOf('Algorithm'),
        await audienceOf('CCNA1'),
        await audienceOf('ENG'),
      ]).toEqual(['WEP', 'SNAC', 'SHARED']);
      expect(await enrolled('Algorithm')).toBe(75);

      // The guess is kept: a SNAC student added to Algorithm later is rejected, not taken in.
      term2((tabs) => {
        const n = String(SNAC_STUDENT).padStart(3, '0');
        tabs['Algorithm']!.push([
          99,
          code(SNAC_STUDENT),
          `FN${n}`,
          `LN${n}`,
          'M',
          'D',
          'SNAC',
          60,
          60,
        ]);
      });
      const again = await sync(sources.t2);
      expect(issuesOf(again.job, 'AUDIENCE_GUESSED')).toEqual([]);
      expect(issuesOf(again.job, 'PROGRAM_NOT_IN_AUDIENCE').map((e) => e.studentCode)).toEqual([
        code(SNAC_STUDENT),
      ]);
      expect(await audienceOf('Algorithm')).toBe('WEP');
    });

    it('the preview shows the guess and saves nothing', async () => {
      await forget();
      const { summary } = await previewSource(prisma, reader, sources.t2);
      expect(summary.issues.filter((i) => (i.code as string) === 'AUDIENCE_GUESSED')).toHaveLength(
        3,
      );
      expect(await audienceOf('Algorithm')).toBeNull();
    });

    it('still needs one when no listed student has a known program', async () => {
      await forget();
      term2((tabs) => {
        tabs['Algorithm']!.splice(3); // headers only
      });
      const { job } = await sync(sources.t2);
      expect(issuesOf(job, 'AUDIENCE_REQUIRED').map((e) => e.sheetTab)).toEqual(['Algorithm']);
      expect(await audienceOf('Algorithm')).toBeNull();
    });
  });

  it('a term without a class list creates nothing and says so once', async () => {
    await prisma.termClass.deleteMany({ where: { termId: termIds[1] } });
    const { job, counts } = await sync(sources.t2);
    expect(issuesOf(job, 'NO_CLASS_LIST')).toHaveLength(1);
    expect(counts.termEnrollments.created).toBe(0);
    expect(await prisma.studentTerm.count({ where: { termId: termIds[1] } })).toBe(0);
  });
});

describe('preview of Term 2', () => {
  beforeEach(async () => {
    await sync(sources.t1);
  });

  it('counts new enrollments first, then class changes and program changes, writing nothing', async () => {
    const first = (await previewSource(prisma, reader, sources.t2)).summary;
    expect(first.termEnrollments).toEqual({
      created: 100,
      classChanged: 0,
      unchanged: 0,
      blocked: 0,
    });
    expect(await prisma.studentTerm.count({ where: { termId: termIds[1] } })).toBe(0);

    await sync(sources.t2);
    const [moved, switched] = PROGRAM_WEP_STUDENTS.slice(0, 2) as [number, number];
    const to = programTerm2Class(moved) === 'A' ? 'B' : 'A';
    term2((tabs) => {
      rosterRow(tabs, moved)[ALL_CLASS] = to;
      rosterRow(tabs, moved)[ALL_CLASS2] = `WEP ${to}`;
      rosterRow(tabs, switched)[ALL_CLASS] = 'D';
      rosterRow(tabs, switched)[ALL_CLASS2] = 'SNAC';
    });
    const summary = (await previewSource(prisma, reader, sources.t2)).summary;
    expect(summary.termEnrollments).toEqual({
      created: 0,
      classChanged: 1,
      unchanged: 98,
      blocked: 1,
    });
    expect(summary.programChanges).toEqual([
      { studentCode: code(switched), from: 'WEP', to: 'SNAC' },
    ]);
    expect(summary.studentIssues).toEqual({ PROGRAM_SWITCH: 1 });
    expect(summary.issues.map((i) => i.code)).toContain('IDENTITY_MISMATCH_TAB');
    expect((await termsOf(moved))[2]).toBe(`WEP ${programTerm2Class(moved)}`);
  });
});
