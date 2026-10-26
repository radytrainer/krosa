import { createPrismaClient, type PrismaClient } from '../src/index.js';
import { assertTestDatabaseUrl, truncateAllTables } from '../src/testing.js';

/**
 * Verifies that data-integrity rules hold at the database level, independently of any
 * application code (docs/database-design.md).
 */
let prisma: PrismaClient;

interface Fixture {
  userId: string;
  generationId: string;
  termId: string;
  offeringId: string;
  otherOfferingId: string;
  criterionId: string;
  otherCriterionId: string;
  enrollmentId: string;
}

let fx: Fixture;

async function seed(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { username: 'admin', role: 'ADMIN', passwordHash: 'x' },
  });
  const studentUser = await prisma.user.create({
    data: { username: 'GEN26-0001', role: 'STUDENT', passwordHash: 'x' },
  });
  const generation = await prisma.generation.create({
    data: {
      code: 'GEN2026',
      name: 'Generation 2026',
      startDate: new Date('2026-01-01'),
      terms: {
        create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })),
      },
    },
    include: { terms: { orderBy: { number: 'asc' } } },
  });
  const term = generation.terms[0]!;
  const math = await prisma.course.create({ data: { code: 'MATH101', name: 'Mathematics I' } });
  const eng = await prisma.course.create({ data: { code: 'ENG101', name: 'English I' } });
  const offering = await prisma.courseOffering.create({
    data: {
      termId: term.id,
      generationId: generation.id,
      courseId: math.id,
      externalKey: 'T1-MATH101',
      title: 'Mathematics I',
    },
  });
  const otherOffering = await prisma.courseOffering.create({
    data: {
      termId: term.id,
      generationId: generation.id,
      courseId: eng.id,
      externalKey: 'T1-ENG101',
      title: 'English I',
    },
  });
  const criterion = await prisma.assessmentCriterion.create({
    data: { offeringId: offering.id, key: 'Q1', name: 'Quiz 1', category: 'QUIZ', displayOrder: 1 },
  });
  const otherCriterion = await prisma.assessmentCriterion.create({
    data: { offeringId: otherOffering.id, key: 'Q1', name: 'Quiz 1', displayOrder: 1 },
  });
  const student = await prisma.student.create({
    data: {
      studentCode: 'GEN26-0001',
      userId: studentUser.id,
      generationId: generation.id,
      fullName: 'Example Student A',
    },
  });
  const enrollment = await prisma.enrollment.create({
    data: { studentId: student.id, offeringId: offering.id },
  });
  return {
    userId: user.id,
    generationId: generation.id,
    termId: term.id,
    offeringId: offering.id,
    otherOfferingId: otherOffering.id,
    criterionId: criterion.id,
    otherCriterionId: otherCriterion.id,
    enrollmentId: enrollment.id,
  };
}

async function createScheme(status: 'DRAFT' | 'PUBLISHED', version: number) {
  return prisma.gradingScheme.create({
    data: {
      offeringId: fx.offeringId,
      version,
      status,
      origin: 'ADMIN',
      totalWeight: 100,
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
      items:
        status === 'DRAFT'
          ? // offeringId comes from the parent via the composite relation.
            { create: [{ criterionId: fx.criterionId, maxMark: 10, weight: 100 }] }
          : undefined,
    },
  });
}

async function source() {
  return prisma.googleSheetSource.create({
    data: {
      generationId: fx.generationId,
      spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      label: 'Main',
      createdById: fx.userId,
    },
  });
}

beforeAll(async () => {
  prisma = createPrismaClient({
    connectionString: assertTestDatabaseUrl(process.env['TEST_DATABASE_URL']),
    poolMax: 2,
    log: [],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  fx = await seed();
});

describe('identity and normalization', () => {
  it('treats generation codes and usernames case-insensitively (citext)', async () => {
    await expect(
      prisma.generation.create({ data: { code: 'gen2026', name: 'dup', startDate: new Date() } }),
    ).rejects.toThrow();
    await expect(
      prisma.user.create({ data: { username: 'ADMIN', role: 'ADMIN', passwordHash: 'x' } }),
    ).rejects.toThrow();
  });

  it('requires normalized upper-case student codes', async () => {
    const u = await prisma.user.create({
      data: { username: 'gen26-0099', role: 'STUDENT', passwordHash: 'x' },
    });
    await expect(
      prisma.student.create({
        data: {
          studentCode: 'gen26-0099',
          userId: u.id,
          generationId: fx.generationId,
          fullName: 'X',
        },
      }),
    ).rejects.toThrow(/students_student_code_check/);
  });

  it('allows only terms 1-5', async () => {
    await expect(
      prisma.term.create({ data: { generationId: fx.generationId, number: 6, name: 'Term 6' } }),
    ).rejects.toThrow(/terms_number_check/);
  });

  it('rejects generation end dates before start dates', async () => {
    await expect(
      prisma.generation.create({
        data: {
          code: 'GEN2030',
          name: 'x',
          startDate: new Date('2030-01-01'),
          endDate: new Date('2029-01-01'),
        },
      }),
    ).rejects.toThrow(/generations_dates_check/);
  });
});

describe('enrollment and scores', () => {
  it('prevents duplicate enrollments and duplicate marks', async () => {
    const enrollment = await prisma.enrollment.findUniqueOrThrow({
      where: { id: fx.enrollmentId },
    });
    await expect(
      prisma.enrollment.create({
        data: { studentId: enrollment.studentId, offeringId: fx.offeringId },
      }),
    ).rejects.toThrow();

    const data = {
      enrollmentId: fx.enrollmentId,
      offeringId: fx.offeringId,
      criterionId: fx.criterionId,
      status: 'RECORDED' as const,
      mark: 8,
    };
    await prisma.assessmentScore.create({ data });
    await expect(prisma.assessmentScore.create({ data })).rejects.toThrow();
  });

  it('rejects a score whose criterion belongs to a different offering', async () => {
    await expect(
      prisma.assessmentScore.create({
        data: {
          enrollmentId: fx.enrollmentId,
          offeringId: fx.offeringId,
          criterionId: fx.otherCriterionId,
          status: 'RECORDED',
          mark: 5,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects negative marks and non-zero ABSENT marks', async () => {
    const base = {
      enrollmentId: fx.enrollmentId,
      offeringId: fx.offeringId,
      criterionId: fx.criterionId,
    };
    await expect(
      prisma.assessmentScore.create({ data: { ...base, status: 'RECORDED', mark: -1 } }),
    ).rejects.toThrow(/assessment_scores_mark_check/);
    await expect(
      prisma.assessmentScore.create({ data: { ...base, status: 'ABSENT', mark: 5 } }),
    ).rejects.toThrow(/assessment_scores_absent_check/);
    await expect(
      prisma.assessmentScore.create({ data: { ...base, status: 'ABSENT', mark: 0 } }),
    ).resolves.toBeDefined();
  });

  it('stores decimal marks exactly', async () => {
    const score = await prisma.assessmentScore.create({
      data: {
        enrollmentId: fx.enrollmentId,
        offeringId: fx.offeringId,
        criterionId: fx.criterionId,
        status: 'RECORDED',
        mark: '41.125',
      },
    });
    expect(score.mark.toString()).toBe('41.125');
  });
});

describe('grading schemes', () => {
  it('allows at most one draft and one published scheme per offering', async () => {
    await createScheme('PUBLISHED', 1);
    await expect(createScheme('PUBLISHED', 2)).rejects.toThrow();
    await createScheme('DRAFT', 3);
    await expect(createScheme('DRAFT', 4)).rejects.toThrow();
  });

  it('rejects invalid weights and max marks', async () => {
    const draft = await prisma.gradingScheme.create({
      data: { offeringId: fx.offeringId, version: 1, origin: 'ADMIN' },
    });
    const item = { schemeId: draft.id, offeringId: fx.offeringId, criterionId: fx.criterionId };
    await expect(
      prisma.gradingSchemeItem.create({ data: { ...item, maxMark: 10, weight: 0 } }),
    ).rejects.toThrow(/grading_scheme_items_weight_check/);
    await expect(
      prisma.gradingSchemeItem.create({ data: { ...item, maxMark: 0, weight: 10 } }),
    ).rejects.toThrow(/grading_scheme_items_max_mark_check/);
    await expect(
      prisma.gradingSchemeItem.create({ data: { ...item, maxMark: 10, weight: 100.5 } }),
    ).rejects.toThrow(/grading_scheme_items_weight_check/);
  });

  it('rejects a scheme item whose criterion belongs to another offering', async () => {
    const draft = await prisma.gradingScheme.create({
      data: { offeringId: fx.offeringId, version: 1, origin: 'ADMIN' },
    });
    await expect(
      prisma.gradingSchemeItem.create({
        data: {
          schemeId: draft.id,
          offeringId: fx.offeringId,
          criterionId: fx.otherCriterionId,
          maxMark: 10,
          weight: 10,
        },
      }),
    ).rejects.toThrow();
  });

  it('freezes items once a scheme is published and enforces the lifecycle', async () => {
    const scheme = await createScheme('DRAFT', 1);
    await prisma.gradingScheme.update({
      where: { id: scheme.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    await expect(
      prisma.gradingSchemeItem.updateMany({ where: { schemeId: scheme.id }, data: { weight: 50 } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.gradingScheme.delete({ where: { id: scheme.id } })).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      prisma.gradingScheme.update({ where: { id: scheme.id }, data: { status: 'DRAFT' } }),
    ).rejects.toThrow(/invalid grading scheme transition/);

    await prisma.gradingScheme.update({ where: { id: scheme.id }, data: { status: 'ARCHIVED' } });
    await expect(
      prisma.gradingScheme.update({ where: { id: scheme.id }, data: { status: 'PUBLISHED' } }),
    ).rejects.toThrow(/invalid grading scheme transition/);
  });

  it('lets drafts be edited and deleted (items cascade)', async () => {
    const scheme = await createScheme('DRAFT', 1);
    await prisma.gradingSchemeItem.updateMany({
      where: { schemeId: scheme.id },
      data: { weight: 90 },
    });
    await prisma.gradingScheme.delete({ where: { id: scheme.id } });
    expect(await prisma.gradingSchemeItem.count({ where: { schemeId: scheme.id } })).toBe(0);
  });

  it('requires published_at on non-draft schemes', async () => {
    await expect(
      prisma.gradingScheme.create({
        data: { offeringId: fx.offeringId, version: 1, origin: 'ADMIN', status: 'PUBLISHED' },
      }),
    ).rejects.toThrow(/grading_schemes_published_check/);
  });
});

describe('sync jobs', () => {
  it('allows only one active job per source', async () => {
    const s = await source();
    const job = { scope: 'SOURCE' as const, sourceId: s.id, requestedById: fx.userId };
    const first = await prisma.syncJob.create({ data: job });
    await expect(prisma.syncJob.create({ data: job })).rejects.toThrow();

    await prisma.syncJob.update({
      where: { id: first.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });
    await expect(prisma.syncJob.create({ data: job })).resolves.toBeDefined();
  });

  it('keeps status and finished_at consistent', async () => {
    const s = await source();
    await expect(
      prisma.syncJob.create({
        data: { scope: 'SOURCE', sourceId: s.id, requestedById: fx.userId, status: 'FAILED' },
      }),
    ).rejects.toThrow(/sync_jobs_finished_check/);
    await expect(
      prisma.syncJob.create({
        data: { scope: 'SOURCE', sourceId: s.id, requestedById: fx.userId, finishedAt: new Date() },
      }),
    ).rejects.toThrow(/sync_jobs_finished_check/);
  });

  it('requires a target matching the scope', async () => {
    await expect(
      prisma.syncJob.create({ data: { scope: 'SOURCE', requestedById: fx.userId } }),
    ).rejects.toThrow(/sync_jobs_scope_check/);
    await expect(
      prisma.syncJob.create({ data: { scope: 'ALL', requestedById: fx.userId } }),
    ).resolves.toBeDefined();
  });

  it('rejects malformed spreadsheet IDs', async () => {
    await expect(
      prisma.googleSheetSource.create({
        data: {
          generationId: fx.generationId,
          spreadsheetId: 'short',
          label: 'x',
          createdById: fx.userId,
        },
      }),
    ).rejects.toThrow(/google_sheet_sources_spreadsheet_id_check/);
  });
});

describe('append-only tables', () => {
  it('rejects updates and deletes of audit logs unless a purge is explicitly enabled', async () => {
    const log = await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.event', metadata: { a: 1 } },
    });
    await expect(
      prisma.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ssrs.allow_append_only_purge = 'on'`);
      await tx.auditLog.delete({ where: { id: log.id } });
    });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('rejects updates of score revisions', async () => {
    const score = await prisma.assessmentScore.create({
      data: {
        enrollmentId: fx.enrollmentId,
        offeringId: fx.offeringId,
        criterionId: fx.criterionId,
        status: 'RECORDED',
        mark: 7,
      },
    });
    const rev = await prisma.assessmentScoreRevision.create({
      data: { scoreId: score.id, newStatus: 'RECORDED', newMark: 7 },
    });
    await expect(
      prisma.assessmentScoreRevision.update({ where: { id: rev.id }, data: { newMark: 9 } }),
    ).rejects.toThrow(/append-only/);
  });
});
