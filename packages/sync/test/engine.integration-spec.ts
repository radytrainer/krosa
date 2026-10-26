import { createPrismaClient, type PrismaClient } from '@ssrs/database';
import { assertTestDatabaseUrl, truncateAllTables } from '@ssrs/database/testing';
import {
  cloneSpreadsheet,
  FIXTURE_SPREADSHEET_ID,
  InMemorySheetsReader,
  workbookFixture,
  type FakeSpreadsheet,
} from '@ssrs/sheets/testing';
import { failJob, runSourceSync } from '../src/engine.js';
import type { SyncCounts, SyncDeps } from '../src/types.js';

let prisma: PrismaClient;
let reader: InMemorySheetsReader;
let adminId: string;
let generationId: string;
let sourceId: string;

const ID = FIXTURE_SPREADSHEET_ID;
const ONCE = { attempt: 1, maxAttempts: 1 };

async function createGeneration(code: string) {
  return prisma.generation.create({
    data: {
      code,
      name: `Generation ${code}`,
      startDate: new Date('2026-01-05'),
      terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
    },
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
  const sheet = cloneSpreadsheet(workbookFixture('GEN2026'));
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
  reader = new InMemorySheetsReader().set(ID, workbookFixture('GEN2026'));
  adminId = (
    await prisma.user.create({ data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' } })
  ).id;
  generationId = (await createGeneration('GEN2026')).id;
  sourceId = (
    await prisma.googleSheetSource.create({
      data: { generationId, spreadsheetId: ID, label: 'Main', createdById: adminId },
    })
  ).id;
});

describe('first import', () => {
  it('creates students, offerings, criteria, published schemes, enrollments and marks', async () => {
    const { outcome, job, counts } = await sync();
    expect(outcome).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(job).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'DONE',
      errorCount: 0,
      warningCount: 0,
      progressCurrent: 3,
      progressTotal: 3,
    });
    expect(job.finishedAt).not.toBeNull();
    expect(counts).toEqual({
      students: { created: 3, updated: 0, unchanged: 0, rejected: 0 },
      offerings: { created: 2, updated: 0, unchanged: 0, rejected: 0, failed: 0 },
      criteria: { created: 10, updated: 0, unchanged: 0 },
      schemes: { published: 2, drafted: 0, unchanged: 0, skipped: 0 },
      enrollments: { created: 6, unchanged: 0, missingInSource: 0 },
      scores: { created: 29, updated: 0, unchanged: 0, rejected: 0, clearedInSource: 0 },
    });

    const users = await prisma.user.findMany({ where: { role: 'STUDENT' } });
    expect(users).toHaveLength(3);
    for (const u of users) {
      expect(u).toMatchObject({ status: 'PENDING', mustChangePassword: true });
      expect(u.passwordHash.startsWith('!locked:')).toBe(true);
    }

    const offerings = await prisma.courseOffering.findMany({ orderBy: { externalKey: 'asc' } });
    expect(
      offerings.map((o) => [o.externalKey, o.visibility, o.credits.toString(), o.sourceId]),
    ).toEqual([
      ['T1-MATH101', 'VISIBLE', '3', sourceId],
      ['T2-ENG101', 'HIDDEN', '2', sourceId],
    ]);
    const schemes = await prisma.gradingScheme.findMany({ include: { items: true } });
    expect(schemes.map((s) => [s.status, s.origin, s.version, s.items.length])).toEqual(
      expect.arrayContaining([
        ['PUBLISHED', 'SHEET', 1, 6],
        ['PUBLISHED', 'SHEET', 1, 4],
      ]),
    );

    const absent = await scoreOf('GEN26-0002', 'T1-MATH101', 'Q2');
    expect(absent).toMatchObject({ status: 'ABSENT', sourceTab: 'T1 Math', sourceRow: 4 });
    expect(absent!.mark.toString()).toBe('0');
    expect(await scoreOf('GEN26-0003', 'T2-ENG101', 'FINAL')).toBeNull(); // blank is not zero
    expect((await scoreOf('GEN26-0002', 'T2-ENG101', 'PROJECT'))!.mark.toString()).toBe('70.25');

    expect(await prisma.assessmentScoreRevision.count()).toBe(29);
    expect(await prisma.auditLog.count({ where: { action: 'student.provisioned' } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'scheme.published' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'sync.completed' } })).toBe(1);

    const source = await prisma.googleSheetSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.lastSyncJobId).toBe(job.id);
    expect(source.lastSyncedAt).not.toBeNull();
    expect(
      (await prisma.generation.findUniqueOrThrow({ where: { id: generationId } })).cacheVersion,
    ).toBe(2);
  });
});

describe('repeat synchronization', () => {
  it('is idempotent: a second run with unchanged data changes nothing', async () => {
    await sync();
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    expect(counts).toEqual({
      students: { created: 0, updated: 0, unchanged: 3, rejected: 0 },
      offerings: { created: 0, updated: 0, unchanged: 2, rejected: 0, failed: 0 },
      criteria: { created: 0, updated: 0, unchanged: 10 },
      schemes: { published: 0, drafted: 0, unchanged: 2, skipped: 0 },
      enrollments: { created: 0, unchanged: 6, missingInSource: 0 },
      scores: { created: 0, updated: 0, unchanged: 29, rejected: 0, clearedInSource: 0 },
    });
    expect(await prisma.student.count()).toBe(3);
    expect(await prisma.assessmentScore.count()).toBe(29);
    expect(await prisma.assessmentScoreRevision.count()).toBe(29);
    expect(await prisma.gradingScheme.count()).toBe(2);
  });

  it('updates changed marks and records each change in the revision history', async () => {
    await sync();
    edit((tabs) => {
      tabs['T1 Math']![2]![2] = 9.5; // GEN26-0001 Q1: 8 → 9.5
      tabs['T1 Math']![3]![3] = 6; // GEN26-0002 Q2: ABS → 6
    });
    const { counts } = await sync();
    expect(counts.scores).toMatchObject({ updated: 2, unchanged: 27 });

    const q1 = await scoreOf('GEN26-0001', 'T1-MATH101', 'Q1');
    expect(q1!.mark.toString()).toBe('9.5');
    const history = await prisma.assessmentScoreRevision.findMany({
      where: { scoreId: q1!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => [h.oldMark?.toString() ?? null, h.newMark.toString()])).toEqual([
      [null, '8'],
      ['8', '9.5'],
    ]);
    const q2 = await scoreOf('GEN26-0002', 'T1-MATH101', 'Q2');
    expect(q2).toMatchObject({ status: 'RECORDED' });
  });

  it('keeps a recorded mark when its cell is cleared, with a warning', async () => {
    await sync();
    edit((tabs) => (tabs['T1 Math']![2]![4] = null)); // GEN26-0001 MID cleared
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED');
    expect(counts.scores.clearedInSource).toBe(1);
    expect((await scoreOf('GEN26-0001', 'T1-MATH101', 'MID'))!.mark.toString()).toBe('41.5');
    expect(job.errors).toContainEqual(
      expect.objectContaining({
        code: 'MARK_CLEARED_IN_SOURCE',
        severity: 'WARNING',
        rowNumber: 3,
        criterionKey: 'MID',
      }),
    );
  });

  it('never touches existing accounts but updates profile data', async () => {
    await sync();
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'GEN26-0001' } });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', passwordHash: '$argon2id$real', mustChangePassword: false },
    });
    edit((tabs) => (tabs['Students']![1]![1] = 'Example Student A Renamed'));

    const { counts } = await sync();
    expect(counts.students).toMatchObject({ updated: 1, unchanged: 2, created: 0 });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({
      status: 'ACTIVE',
      passwordHash: '$argon2id$real',
      mustChangePassword: false,
    });
    expect((await prisma.student.findUniqueOrThrow({ where: { userId: user.id } })).fullName).toBe(
      'Example Student A Renamed',
    );
  });

  it('flags students who disappear from a course tab without deleting anything', async () => {
    await sync();
    edit((tabs) => tabs['T2 English']!.splice(3, 1)); // drop GEN26-0002
    const { job, counts } = await sync();
    expect(counts.enrollments.missingInSource).toBe(1);
    const enrollment = await prisma.enrollment.findFirstOrThrow({
      where: { student: { studentCode: 'GEN26-0002' }, offering: { externalKey: 'T2-ENG101' } },
    });
    expect(enrollment.presentInSource).toBe(false);
    expect(await scoreOf('GEN26-0002', 'T2-ENG101', 'PROJECT')).not.toBeNull();
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'ENROLLMENT_MISSING_IN_SOURCE', studentCode: 'GEN26-0002' }),
    );
  });

  it('applies name/order changes to criteria and creates new criteria', async () => {
    await sync();
    edit((tabs) => {
      tabs['Criteria']![1]![2] = 'Pop Quiz 1';
      tabs['Criteria']![1]![5] = 3; // Q1 weight 5 → 3
      tabs['Criteria']!.splice(3, 0, ['T1-MATH101', 'Q3', 'Quiz 3', 'QUIZ', 10, 2, 3, '']);
      tabs['T1 Math']![0]!.push('Q3');
      tabs['T1 Math']![2]!.push(7);
    });
    const { counts } = await sync();
    // Q1 renamed; the others keep their explicit `order` values, so only Q1 counts as updated.
    expect(counts.criteria).toMatchObject({ created: 1, updated: 1, unchanged: 9 });
    const q1 = await prisma.assessmentCriterion.findFirstOrThrow({
      where: { key: 'Q1', offering: { externalKey: 'T1-MATH101' } },
    });
    expect(q1.name).toBe('Pop Quiz 1');
    expect(counts.schemes.drafted).toBe(1);
  });
});

describe('grading schemes (hybrid authority)', () => {
  it('turns sheet weight changes into a draft and leaves the published scheme alone', async () => {
    await sync();
    edit((tabs) => {
      tabs['Criteria']![1]![5] = 10; // Q1 5 → 10
      tabs['Criteria']![3]![5] = 25; // MID 30 → 25
    });
    const first = await sync();
    expect(first.counts.schemes).toMatchObject({ drafted: 1, unchanged: 1 });
    expect(first.job.errors).toContainEqual(
      expect.objectContaining({ code: 'SCHEME_DRAFT_PENDING', courseKey: 'T1-MATH101' }),
    );

    const schemes = await prisma.gradingScheme.findMany({
      where: { offering: { externalKey: 'T1-MATH101' } },
      orderBy: { version: 'asc' },
      include: { items: { include: { criterion: true } } },
    });
    expect(schemes.map((s) => [s.version, s.status, s.origin])).toEqual([
      [1, 'PUBLISHED', 'SHEET'],
      [2, 'DRAFT', 'SHEET'],
    ]);
    expect(schemes[0]!.items.find((i) => i.criterion.key === 'Q1')!.weight.toString()).toBe('5');

    const again = await sync();
    expect(again.counts.schemes).toMatchObject({ drafted: 0, unchanged: 2 });
    expect(
      await prisma.gradingScheme.count({ where: { offering: { externalKey: 'T1-MATH101' } } }),
    ).toBe(2);
  });

  it('never overwrites an admin draft', async () => {
    await sync();
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: { externalKey: 'T1-MATH101' },
    });
    const q1 = await prisma.assessmentCriterion.findFirstOrThrow({
      where: { offeringId: offering.id, key: 'Q1' },
    });
    const adminDraft = await prisma.gradingScheme.create({
      data: {
        offeringId: offering.id,
        version: 2,
        origin: 'ADMIN',
        createdById: adminId,
        items: { create: [{ criterionId: q1.id, maxMark: 10, weight: 100 }] },
      },
    });
    edit((tabs) => {
      tabs['Criteria']![1]![5] = 10; // Q1 5 → 10
      tabs['Criteria']![3]![5] = 25; // MID 30 → 25 (total stays 100)
    });
    const { job, counts } = await sync();
    expect(counts.schemes.skipped).toBe(1);
    expect(job.errors).toContainEqual(expect.objectContaining({ code: 'SCHEME_DRAFT_CONFLICT' }));
    const draft = await prisma.gradingScheme.findUniqueOrThrow({
      where: { id: adminDraft.id },
      include: { items: true },
    });
    expect(draft.items).toHaveLength(1);
  });

  it('rejects marks above the published max until the raised max is published', async () => {
    await sync();
    edit((tabs) => {
      tabs['Criteria']![1]![4] = 20; // Q1 max 10 → 20 (sheet)
      tabs['T1 Math']![2]![2] = 15; // GEN26-0001 Q1 = 15
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.scores.rejected).toBe(1);
    expect(counts.schemes.drafted).toBe(1);
    expect(job.errors).toContainEqual(
      expect.objectContaining({
        code: 'MARK_EXCEEDS_PUBLISHED_MAX',
        studentCode: 'GEN26-0001',
        criterionKey: 'Q1',
        rawValue: '15',
      }),
    );
    expect((await scoreOf('GEN26-0001', 'T1-MATH101', 'Q1'))!.mark.toString()).toBe('8');
  });

  it('imports marks but no scheme when weights do not total 100', async () => {
    edit((tabs) => (tabs['Criteria']![7]![5] = 31)); // English total 101
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.schemes).toMatchObject({ published: 1, skipped: 1 });
    expect(
      await prisma.gradingScheme.count({ where: { offering: { externalKey: 'T2-ENG101' } } }),
    ).toBe(0);
    expect(
      await prisma.assessmentScore.count({
        where: { criterion: { offering: { externalKey: 'T2-ENG101' } } },
      }),
    ).toBe(11);
  });
});

describe('rejections and partial failures', () => {
  it('never moves a student between generations', async () => {
    const other = await createGeneration('GEN2027');
    const user = await prisma.user.create({
      data: { username: 'GEN26-0002', role: 'STUDENT', passwordHash: 'x' },
    });
    await prisma.student.create({
      data: {
        studentCode: 'GEN26-0002',
        userId: user.id,
        generationId: other.id,
        fullName: 'Other Generation',
      },
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.students).toMatchObject({ created: 2, rejected: 1 });
    expect(counts.enrollments.created).toBe(4);
    const student = await prisma.student.findUniqueOrThrow({
      where: { studentCode: 'GEN26-0002' },
    });
    expect(student).toMatchObject({ generationId: other.id, fullName: 'Other Generation' });
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'STUDENT_IN_OTHER_GENERATION', studentCode: 'GEN26-0002' }),
    );
  });

  it('rejects a course owned by something else and still applies the others', async () => {
    const term = await prisma.term.findFirstOrThrow({ where: { generationId, number: 1 } });
    const course = await prisma.course.create({ data: { code: 'MATH101', name: 'Mathematics I' } });
    await prisma.courseOffering.create({
      data: {
        termId: term.id,
        generationId,
        courseId: course.id,
        externalKey: 'T1-MATH101',
        title: 'Manual',
      },
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.offerings).toMatchObject({ created: 1, rejected: 1 });
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'OFFERING_OWNED_ELSEWHERE', courseKey: 'T1-MATH101' }),
    );
    expect(
      await prisma.assessmentCriterion.count({
        where: { offering: { externalKey: 'T1-MATH101' } },
      }),
    ).toBe(0);
    expect(
      await prisma.assessmentScore.count({
        where: { criterion: { offering: { externalKey: 'T2-ENG101' } } },
      }),
    ).toBe(11);
  });

  it('rolls back a course whose transaction fails, keeping the other courses', async () => {
    const { job, counts } = await sync({
      hooks: {
        beforeCourseCommit: (courseKey) => {
          if (courseKey === 'T2-ENG101') throw new Error('simulated failure');
        },
      },
    });
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.offerings.failed).toBe(1);
    expect(job.errors).toContainEqual(
      expect.objectContaining({ code: 'APPLY_FAILED', courseKey: 'T2-ENG101' }),
    );
    expect(
      await prisma.courseOffering.findFirst({ where: { externalKey: 'T2-ENG101' } }),
    ).toBeNull();
    expect(await prisma.assessmentCriterion.count({ where: { key: 'PROJECT' } })).toBe(0);
    expect(await prisma.courseOffering.count({ where: { externalKey: 'T1-MATH101' } })).toBe(1);
    expect(await prisma.assessmentScore.count()).toBe(18);
  });

  it('reports row and cell rejections from the parser in the counts', async () => {
    edit((tabs) => {
      tabs['T1 Math']![2]![2] = 11; // invalid mark
      tabs['Students']!.push(['bad id!', 'Nope', 'F', 'A']);
    });
    const { job, counts } = await sync();
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    expect(counts.scores.rejected).toBe(1);
    expect(counts.students.rejected).toBe(1);
    expect(job.errorCount).toBe(2);
  });
});

describe('failures before anything is written', () => {
  it('fails on file-level template errors and stores the report', async () => {
    reader.set(ID, workbookFixture('GEN2099'));
    const { outcome, job } = await sync();
    expect(outcome).toEqual({ kind: 'finished', status: 'FAILED' });
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'TEMPLATE_INVALID' });
    expect(job.errors.map((e) => e.code)).toEqual(['GENERATION_MISMATCH']);
    expect(await prisma.student.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'sync.failed' } })).toBe(1);
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

    reader.set(ID, workbookFixture('GEN2026'));
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
    expect(await prisma.assessmentScoreRevision.count()).toBe(29);
  });
});

describe('multi-source parent jobs', () => {
  it('aggregates children honestly', async () => {
    const parent = await prisma.syncJob.create({
      data: { scope: 'GENERATION', generationId, requestedById: adminId },
    });
    const first = await newJob(parent.id);
    // A second source of the same generation whose file is not shared.
    const otherId = '1OtherSpreadsheetId0000000000000000000000';
    const other = await prisma.googleSheetSource.create({
      data: { generationId, spreadsheetId: otherId, label: 'Other', createdById: adminId },
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
    expect((done.counts as unknown as SyncCounts).scores.created).toBe(29);
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
