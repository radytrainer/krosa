import { createPrismaClient, type PrismaClient } from '@ssrs/database';
import { assertTestDatabaseUrl, truncateAllTables } from '@ssrs/database/testing';
import {
  InMemorySheetsReader,
  TERM_FIXTURE_SPREADSHEET_ID,
  termWorkbookFixture,
  type FakeSpreadsheet,
} from '@ssrs/sheets/testing';
import { failJob, runSourceSync } from '../src/engine.js';
import { confirmAllTabs } from '../src/testing.js';
import type { SyncCounts, SyncDeps } from '../src/types.js';

let prisma: PrismaClient;
let reader: InMemorySheetsReader;
let adminId: string;
let generationId: string;
let termId: string;
let sourceId: string;

const ID = TERM_FIXTURE_SPREADSHEET_ID;
const ONCE = { attempt: 1, maxAttempts: 1 };
const S1 = 'PNC2027-001';
const S2 = 'PNC2027-002';

/** Fixture totals: 5 tabs, 36 mark columns, 12 enrollments, 74 filled marks. */
const CRITERIA = 36;
const ENROLLMENTS = 12;
const MARKS = 74;

async function createGeneration(code: string) {
  return prisma.generation.create({
    data: {
      code,
      name: `Generation ${code}`,
      startDate: new Date('2026-11-02'),
      terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
    },
    include: { terms: { orderBy: { number: 'asc' } } },
  });
}

async function newJob(parentId?: string) {
  return prisma.syncJob.create({
    data: { scope: 'SOURCE', sourceId, requestedById: adminId, ...(parentId ? { parentId } : {}) },
  });
}

async function sync(deps: Partial<SyncDeps> = {}, options = ONCE) {
  const job = await newJob();
  const outcome = await runSourceSync({ prisma, reader, ...deps }, job.id, options);
  const row = await prisma.syncJob.findUniqueOrThrow({
    where: { id: job.id },
    include: { errors: true },
  });
  return { outcome, job: row, counts: row.counts as unknown as SyncCounts };
}

function edit(mutate: (tabs: FakeSpreadsheet['tabs']) => void) {
  const sheet = termWorkbookFixture();
  mutate(sheet.tabs);
  reader.set(ID, sheet);
}

async function scoreOf(studentCode: string, courseKey: string, criterionKey: string) {
  return prisma.assessmentScore.findFirst({
    where: {
      enrollment: { student: { studentCode } },
      criterion: { key: criterionKey, offering: { externalKey: courseKey } },
    },
  });
}

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
  reader = new InMemorySheetsReader().set(ID, termWorkbookFixture());
  adminId = (
    await prisma.user.create({ data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' } })
  ).id;
  const generation = await createGeneration('GEN2027');
  generationId = generation.id;
  termId = generation.terms[0]!.id;
  sourceId = (
    await prisma.googleSheetSource.create({
      data: { generationId, termId, spreadsheetId: ID, label: 'Term 1', createdById: adminId },
    })
  ).id;
  await confirmAllTabs(prisma, reader, sourceId);
});

describe('first import', () => {
  it('creates students, published schemes, enrollments and marks from confirmed tabs', async () => {
    const { outcome, job, counts } = await sync();
    expect(outcome).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(job).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'DONE',
      errorCount: 0,
      warningCount: 1, // BCU row 3 has first and last name swapped
      progressCurrent: 6,
      progressTotal: 6,
    });
    expect(counts).toEqual({
      students: { created: 3, updated: 0, unchanged: 0, rejected: 0 },
      offerings: { created: 0, updated: 0, unchanged: 5, rejected: 0, failed: 0 },
      criteria: { created: 0, updated: 0, unchanged: CRITERIA },
      schemes: { published: 5, drafted: 0, unchanged: 0, skipped: 0 },
      enrollments: { created: ENROLLMENTS, unchanged: 0, missingInSource: 0 },
      scores: { created: MARKS, updated: 0, unchanged: 0, rejected: 0, clearedInSource: 0 },
    });

    const users = await prisma.user.findMany({ where: { role: 'STUDENT' } });
    expect(users).toHaveLength(3);
    for (const u of users) {
      expect(u).toMatchObject({ status: 'PENDING', mustChangePassword: true });
      expect(u.passwordHash.startsWith('!locked:')).toBe(true);
    }
    const student = await prisma.student.findUniqueOrThrow({ where: { studentCode: S1 } });
    expect(student).toMatchObject({
      firstName: 'DARA',
      lastName: 'SOK',
      fullName: 'DARA SOK',
      gender: 'MALE',
      className: 'A',
    });

    const scheme = await prisma.gradingScheme.findFirstOrThrow({
      where: { offering: { externalKey: 'T1-ENG' } },
      include: { items: { include: { criterion: true } } },
    });
    expect(scheme).toMatchObject({ status: 'PUBLISHED', origin: 'SHEET', version: 1 });
    expect(scheme.items).toHaveLength(16);
    const rolePlay = scheme.items.find((i) => i.criterion.key === 'ROLE_PLAY');
    expect(rolePlay!.weight.toString()).toBe('7.5');
    expect(rolePlay!.maxMark.toString()).toBe('100');

    expect((await scoreOf(S1, 'T1-LOGIC', 'QUIZ_1'))!.mark.toString()).toBe('90');
    expect(await scoreOf(S1, 'T1-BCU', 'QUIZ_1')).toBeNull(); // blank is not zero
    expect(await prisma.assessmentScoreRevision.count()).toBe(MARKS);
    expect(await prisma.auditLog.count({ where: { action: 'student.provisioned' } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'sync.completed' } })).toBe(1);

    const source = await prisma.googleSheetSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.lastSyncJobId).toBe(job.id);
    expect(job.mappingVersions).toEqual(
      expect.objectContaining(
        Object.fromEntries((await prisma.sheetTabMapping.findMany()).map((t) => [t.id, t.version])),
      ),
    );
    expect(
      (await prisma.generation.findUniqueOrThrow({ where: { id: generationId } })).cacheVersion,
    ).toBe(2);
  });

  it('keeps every subject hidden until an admin releases the term', async () => {
    await sync();
    const offerings = await prisma.courseOffering.findMany();
    expect(offerings.map((o) => o.visibility)).toEqual(Array(5).fill('HIDDEN'));

    await prisma.courseOffering.updateMany({ data: { visibility: 'VISIBLE' } });
    await sync();
    const after = await prisma.courseOffering.findMany();
    expect(after.map((o) => o.visibility)).toEqual(Array(5).fill('VISIBLE'));
  });

  it('stores teacher comments and the sheet total on the enrollment', async () => {
    await sync();
    const pl = await prisma.enrollment.findFirstOrThrow({
      where: { student: { studentCode: S1 }, offering: { externalKey: 'T1-PL' } },
    });
    expect(pl.teacherComment).toBe('Works well in a team.');
    const logic = await prisma.enrollment.findFirstOrThrow({
      where: { student: { studentCode: S1 }, offering: { externalKey: 'T1-LOGIC' } },
    });
    expect(logic.sheetTotal!.toString()).toBe('78.9');

    edit((tabs) => (tabs['PL']![1]![10] = 'Much improved.'));
    await sync();
    const updated = await prisma.enrollment.findUniqueOrThrow({ where: { id: pl.id } });
    expect(updated.teacherComment).toBe('Much improved.');
  });
});

describe('repeat synchronization', () => {
  it('is idempotent: a second run with unchanged data changes nothing', async () => {
    await sync();
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    expect(counts).toEqual({
      students: { created: 0, updated: 0, unchanged: 3, rejected: 0 },
      offerings: { created: 0, updated: 0, unchanged: 5, rejected: 0, failed: 0 },
      criteria: { created: 0, updated: 0, unchanged: CRITERIA },
      schemes: { published: 0, drafted: 0, unchanged: 5, skipped: 0 },
      enrollments: { created: 0, unchanged: ENROLLMENTS, missingInSource: 0 },
      scores: { created: 0, updated: 0, unchanged: MARKS, rejected: 0, clearedInSource: 0 },
    });
    expect(await prisma.student.count()).toBe(3);
    expect(await prisma.assessmentScore.count()).toBe(MARKS);
    expect(await prisma.assessmentScoreRevision.count()).toBe(MARKS);
    expect(await prisma.gradingScheme.count()).toBe(5);
  });

  it('updates changed marks and records each change in the revision history', async () => {
    await sync();
    edit((tabs) => {
      tabs['Logic']![1]![5] = 95; // S1 Quiz 1: 90 → 95
      tabs['Logic']![2]![6] = 'ABS'; // S2 Quiz 2: 70 → absent
    });
    const { counts } = await sync();
    expect(counts.scores).toMatchObject({ updated: 2, unchanged: MARKS - 2 });

    const quiz = await scoreOf(S1, 'T1-LOGIC', 'QUIZ_1');
    expect(quiz!.mark.toString()).toBe('95');
    const history = await prisma.assessmentScoreRevision.findMany({
      where: { scoreId: quiz!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => [h.oldMark?.toString() ?? null, h.newMark.toString()])).toEqual([
      [null, '90'],
      ['90', '95'],
    ]);
    const absent = await scoreOf(S2, 'T1-LOGIC', 'QUIZ_2');
    expect(absent).toMatchObject({ status: 'ABSENT' });
    expect(absent!.mark.toString()).toBe('0');
  });

  it('keeps a recorded mark when its cell is cleared, with a warning', async () => {
    await sync();
    edit((tabs) => (tabs['Logic']![1]![9] = null)); // S1 MIDTERM cleared
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    expect(counts.scores.clearedInSource).toBe(1);
    expect((await scoreOf(S1, 'T1-LOGIC', 'MIDTERM'))!.mark.toString()).toBe('60');
    expect(job.errors).toContainEqual(
      expect.objectContaining({
        code: 'MARK_CLEARED_IN_SOURCE',
        severity: 'WARNING',
        rowNumber: 2,
        criterionKey: 'MIDTERM',
      }),
    );
  });

  it('never touches existing accounts but updates profile data from the roster', async () => {
    await sync();
    const user = await prisma.user.findUniqueOrThrow({ where: { username: S1 } });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', passwordHash: '$argon2id$real', mustChangePassword: false },
    });
    edit((tabs) => (tabs['ALL']![3]![2] = 'SOKHA'));

    const { counts } = await sync();
    expect(counts.students).toMatchObject({ updated: 1, unchanged: 2, created: 0 });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({
      status: 'ACTIVE',
      passwordHash: '$argon2id$real',
      mustChangePassword: false,
    });
    expect(await prisma.student.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      lastName: 'SOKHA',
      fullName: 'DARA SOKHA',
    });
  });

  it('flags students who disappear from a tab without deleting anything', async () => {
    await sync();
    edit((tabs) => tabs['PL']!.splice(2, 1)); // drop S2
    const { job, counts } = await sync();
    expect(counts.enrollments.missingInSource).toBe(1);
    const enrollment = await prisma.enrollment.findFirstOrThrow({
      where: { student: { studentCode: S2 }, offering: { externalKey: 'T1-PL' } },
    });
    expect(enrollment.presentInSource).toBe(false);
    expect(await scoreOf(S2, 'T1-PL', 'QUIZ')).not.toBeNull();
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'ENROLLMENT_MISSING_IN_SOURCE', studentCode: S2 }),
    );
  });
});

describe('tab mappings', () => {
  it('skips a tab whose headers changed and still applies the others', async () => {
    edit((tabs) => (tabs['Logic']![0]![5] = 'Quiz one 10%'));
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.offerings.rejected).toBe(1);
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'NEEDS_REMAP', sheetTab: 'Logic', severity: 'ERROR' }),
    );
    expect(await scoreOf(S1, 'T1-LOGIC', 'QUIZ_1')).toBeNull();
    expect(await scoreOf(S1, 'T1-PL', 'QUIZ')).not.toBeNull();
  });

  it('finds a renamed tab through its Google sheet id', async () => {
    const sheet = termWorkbookFixture();
    const tabs = Object.entries(sheet.tabs).map(
      ([title, grid]) => [title === 'Logic' ? 'Logic Thinking' : title, grid] as const,
    );
    reader.set(ID, { ...sheet, tabs: Object.fromEntries(tabs) });
    const { job } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    expect((await scoreOf(S1, 'T1-LOGIC', 'QUIZ_1'))!.sourceTab).toBe('Logic Thinking');
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: { externalKey: 'T1-LOGIC' },
    });
    expect(offering.sheetTab).toBe('Logic Thinking');
  });

  it('reports a confirmed tab that left the workbook and keeps its data', async () => {
    await sync();
    edit((tabs) => delete tabs['MsOffice']);
    const { job } = await sync();
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'WORKSHEET_NOT_FOUND', sheetTab: 'MsOffice' }),
    );
    expect(await scoreOf(S1, 'T1-MSOFFICE', 'MS_WORD')).not.toBeNull();
  });

  it('warns about new tabs nobody confirmed, but not about ignored ones', async () => {
    edit((tabs) => {
      tabs['Design'] = [['STUDENT ID', 'Project 100%']];
      tabs['Notes'] = [['free text']];
    });
    const tab = await prisma.sheetTabMapping.create({
      data: {
        sourceId,
        tabName: 'Notes',
        headerRow: 1,
        headerSignature: 'a'.repeat(64),
        status: 'IGNORED',
      },
    });
    const { job } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    const unmapped = job.errors.filter((e) => e.code === 'UNMAPPED_TAB').map((e) => e.sheetTab);
    expect(unmapped).toEqual(['Design']);
    expect(tab.status).toBe('IGNORED');
  });

  it('fails with nothing applied when no tab is confirmed', async () => {
    await prisma.sheetColumnMapping.deleteMany();
    await prisma.sheetTabMapping.deleteMany();
    const { job } = await sync();
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'TEMPLATE_INVALID' });
    const errors = job.errors.filter((e) => e.severity === 'ERROR');
    expect(errors.map((e) => e.code)).toEqual(['NO_CONFIRMED_TABS']);
    expect(await prisma.student.count()).toBe(0);
  });

  it('publishes re-confirmed weights as a new version and keeps the marks', async () => {
    await sync();
    const column = await prisma.sheetColumnMapping.findFirstOrThrow({
      where: { tabMapping: { tabName: 'PL' }, proposedName: 'Quiz' },
    });
    const other = await prisma.sheetColumnMapping.findFirstOrThrow({
      where: { tabMapping: { tabName: 'PL' }, proposedName: 'Homework' },
    });
    await prisma.sheetColumnMapping.update({
      where: { id: column.id },
      data: { proposedWeight: '25' },
    });
    await prisma.sheetColumnMapping.update({
      where: { id: other.id },
      data: { proposedWeight: '5' },
    });

    const { counts } = await sync();
    expect(counts.schemes).toMatchObject({ published: 1, unchanged: 4 });
    expect(counts.scores.unchanged).toBe(MARKS);
    const schemes = await prisma.gradingScheme.findMany({
      where: { offering: { externalKey: 'T1-PL' } },
      orderBy: { version: 'asc' },
      include: { items: { include: { criterion: true } } },
    });
    expect(schemes.map((s) => [s.version, s.status])).toEqual([
      [1, 'ARCHIVED'],
      [2, 'PUBLISHED'],
    ]);
    const quiz = schemes[1]!.items.find((i) => i.criterion.key === 'QUIZ');
    expect(quiz!.weight.toString()).toBe('25');

    const again = await sync();
    expect(again.counts.schemes).toMatchObject({ published: 0, unchanged: 5 });
  });

  it('warns when a mapped column is removed from the mapping and keeps its marks', async () => {
    await sync();
    await prisma.sheetColumnMapping.updateMany({
      where: { tabMapping: { tabName: 'MsOffice' }, proposedName: 'PARTICIPATIONS' },
      data: { role: 'IGNORE', criterionId: null, proposedWeight: null },
    });
    await prisma.sheetColumnMapping.updateMany({
      where: { tabMapping: { tabName: 'MsOffice' }, proposedName: 'MS WORD' },
      data: { proposedWeight: '40' },
    });
    const { job } = await sync();
    expect(job.errors).toContainEqual(
      expect.objectContaining({
        code: 'CRITERION_REMOVED_IN_SOURCE',
        criterionKey: 'PARTICIPATIONS',
      }),
    );
    expect(await scoreOf(S1, 'T1-MSOFFICE', 'PARTICIPATIONS')).not.toBeNull();
  });
});

describe('rejections and partial failures', () => {
  it('never moves a student between generations', async () => {
    const other = await createGeneration('GEN2030');
    const user = await prisma.user.create({
      data: { username: S2, role: 'STUDENT', passwordHash: 'x' },
    });
    await prisma.student.create({
      data: {
        studentCode: S2,
        userId: user.id,
        generationId: other.id,
        fullName: 'Other Generation',
      },
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.students).toMatchObject({ created: 2, rejected: 1 });
    const student = await prisma.student.findUniqueOrThrow({ where: { studentCode: S2 } });
    expect(student).toMatchObject({ generationId: other.id, fullName: 'Other Generation' });
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'STUDENT_IN_OTHER_GENERATION', studentCode: S2 }),
    );
  });

  it('rolls back a tab whose transaction fails, keeping the other tabs', async () => {
    const { job, counts } = await sync({
      hooks: {
        beforeCourseCommit: (courseKey) => {
          if (courseKey === 'T1-PL') throw new Error('simulated failure');
        },
      },
    });
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.offerings.failed).toBe(1);
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'APPLY_FAILED', courseKey: 'T1-PL' }),
    );
    expect(await scoreOf(S1, 'T1-PL', 'QUIZ')).toBeNull();
    expect(
      await prisma.gradingScheme.count({ where: { offering: { externalKey: 'T1-PL' } } }),
    ).toBe(0);
    expect(await prisma.assessmentScore.count()).toBe(MARKS - 12);
  });

  it('reports row and cell rejections from the parser in the counts', async () => {
    edit((tabs) => {
      tabs['Logic']![1]![5] = 120; // invalid mark
      tabs['ALL']!.push(['bad id!', 'NOPE', 'NOPE', 'F', 'A']);
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.scores.rejected).toBe(1);
    expect(counts.students.rejected).toBe(1);
    expect(job.errorCount).toBe(2);
  });

  it('rejects a student who is in a subject tab but not in the roster', async () => {
    edit((tabs) => tabs['Logic']!.push(['PNC2027-099', 'NEW', 'ONE', 'F', 'A', 50]));
    const { job } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_STUDENT', studentCode: 'PNC2027-099' }),
    );
    expect(await prisma.student.count()).toBe(3);
  });
});

describe('failures before anything is written', () => {
  it('fails on file-level errors and stores the report', async () => {
    edit((tabs) => (tabs['_meta']![3]![1] = 2));
    const { outcome, job } = await sync();
    expect(outcome).toEqual({ kind: 'finished', status: 'FAILED' });
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'TEMPLATE_INVALID' });
    expect(job.errors.map((e) => e.code)).toEqual(['TERM_MISMATCH']);
    expect(await prisma.student.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'sync.failed' } })).toBe(1);
  });

  it('fails when the roster tab is gone', async () => {
    edit((tabs) => delete tabs['ALL']);
    const { job } = await sync();
    expect(job.failureCode).toBe('TEMPLATE_INVALID');
    expect(job.errors.map((e) => e.code)).toContain('ROSTER_TAB_MISSING');
  });

  it('fails when the spreadsheet is no longer shared', async () => {
    reader.fail(ID, 'SHEET_NOT_SHARED');
    const { job } = await sync();
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_NOT_SHARED' });
  });

  it('asks for a retry on transient Google errors until attempts run out', async () => {
    reader.fail(ID, 'GOOGLE_UNAVAILABLE');
    const job = await newJob();
    const first = await runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 3 });
    expect(first).toMatchObject({ kind: 'retry', code: 'GOOGLE_UNAVAILABLE' });
    expect(await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'RUNNING',
      phase: 'WAITING_RETRY',
      finishedAt: null,
    });

    reader.set(ID, termWorkbookFixture());
    const second = await runSourceSync({ prisma, reader }, job.id, { attempt: 2, maxAttempts: 3 });
    expect(second).toEqual({ kind: 'finished', status: 'SUCCEEDED' });

    reader.fail(ID, 'GOOGLE_UNAVAILABLE');
    const last = await newJob();
    const final = await runSourceSync({ prisma, reader }, last.id, { attempt: 3, maxAttempts: 3 });
    expect(final).toEqual({ kind: 'finished', status: 'FAILED' });
  });

  it('refuses disabled sources and archived generations', async () => {
    await prisma.googleSheetSource.update({
      where: { id: sourceId },
      data: { status: 'DISABLED' },
    });
    expect((await sync()).job.failureCode).toBe('SOURCE_DISABLED');
    await prisma.googleSheetSource.update({ where: { id: sourceId }, data: { status: 'ACTIVE' } });
    await prisma.generation.update({ where: { id: generationId }, data: { status: 'ARCHIVED' } });
    expect((await sync()).job.failureCode).toBe('GENERATION_ARCHIVED');
  });

  it('treats a re-delivered finished job as done', async () => {
    const { job } = await sync();
    const again = await runSourceSync({ prisma, reader }, job.id, ONCE);
    expect(again).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(await prisma.assessmentScoreRevision.count()).toBe(MARKS);
  });
});

describe('run lease', () => {
  it('lets only one of two simultaneous deliveries run, and releases the lease', async () => {
    const job = await newJob();
    const outcomes = await Promise.all([
      runSourceSync({ prisma, reader }, job.id, ONCE),
      runSourceSync({ prisma, reader }, job.id, ONCE),
    ]);
    expect(outcomes.map((o) => o.kind).toSorted()).toEqual(['busy', 'finished']);
    const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', leaseToken: null, leaseExpiresAt: null });
    expect(
      await prisma.auditLog.count({ where: { entityId: job.id, action: 'sync.completed' } }),
    ).toBe(1);
    expect(await prisma.assessmentScoreRevision.count()).toBe(MARKS);
  });

  it('does not touch a job whose lease is held by a live run', async () => {
    const job = await newJob();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await runSourceSync({ prisma, reader }, job.id, ONCE)).toEqual({ kind: 'busy' });
    expect(await prisma.student.count()).toBe(0);
  });

  it('takes over a job whose lease expired (the worker died)', async () => {
    const job = await newJob();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        phase: 'APPLY',
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    const outcome = await runSourceSync({ prisma, reader }, job.id, ONCE);
    expect(outcome).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(await prisma.student.count()).toBe(3);
  });

  it('releases the lease when asking for a retry, so the next attempt can run', async () => {
    reader.fail(ID, 'GOOGLE_UNAVAILABLE');
    const job = await newJob();
    const first = await runSourceSync({ prisma, reader }, job.id, { attempt: 1, maxAttempts: 3 });
    expect(first.kind).toBe('retry');
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } })).leaseToken,
    ).toBeNull();
    reader.set(ID, termWorkbookFixture());
    const second = await runSourceSync({ prisma, reader }, job.id, { attempt: 2, maxAttempts: 3 });
    expect(second).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
  });
});

describe('multi-source parent jobs', () => {
  it('aggregates children honestly', async () => {
    const parent = await prisma.syncJob.create({
      data: { scope: 'GENERATION', generationId, requestedById: adminId },
    });
    const first = await newJob(parent.id);
    // A workbook for term 2 whose file is not shared.
    const otherId = '1OtherSpreadsheetId0000000000000000000000';
    const term2 = await prisma.term.findFirstOrThrow({ where: { generationId, number: 2 } });
    const other = await prisma.googleSheetSource.create({
      data: {
        generationId,
        termId: term2.id,
        spreadsheetId: otherId,
        label: 'Term 2',
        createdById: adminId,
      },
    });
    reader.fail(otherId, 'SHEET_NOT_SHARED');
    const second = await prisma.syncJob.create({
      data: { scope: 'SOURCE', sourceId: other.id, parentId: parent.id, requestedById: adminId },
    });

    await runSourceSync({ prisma, reader }, first.id, ONCE);
    expect(await prisma.syncJob.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      status: 'RUNNING',
      progressCurrent: 1,
      progressTotal: 2,
    });

    await runSourceSync({ prisma, reader }, second.id, ONCE);
    const done = await prisma.syncJob.findUniqueOrThrow({ where: { id: parent.id } });
    expect(done).toMatchObject({ status: 'SUCCEEDED_WITH_ERRORS', progressCurrent: 2 });
    expect(done.finishedAt).not.toBeNull();
    expect((done.counts as unknown as SyncCounts).scores.created).toBe(MARKS);
  });

  it('fails the parent when every child fails, including jobs failed without running', async () => {
    const parent = await prisma.syncJob.create({ data: { scope: 'ALL', requestedById: adminId } });
    const child = await newJob(parent.id);
    await failJob(prisma, child.id, 'ENQUEUE_FAILED', 'Queue unavailable');
    expect(await prisma.syncJob.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'ALL_SOURCES_FAILED',
    });
  });
});
