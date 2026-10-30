import type { Prisma, PrismaClient } from '@ssrs/database';
import type { ParsedCourse, SubjectRow } from '@ssrs/sheets';
import { sameSchemeItems } from './scheme-diff.js';
import type { SyncCounts, SyncDeps, SyncIssue } from './types.js';

export interface CourseContext {
  syncJobId: string;
  sourceId: string;
  generationId: string;
  studentIdByCode: Map<string, string>;
  now: Date;
  hooks?: SyncDeps['hooks'];
}

export interface CourseResult {
  rejected: boolean;
  issues: SyncIssue[];
  counts: Pick<SyncCounts, 'offerings' | 'criteria' | 'schemes' | 'enrollments' | 'scores'>;
}

type Tx = Prisma.TransactionClient;
const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;
const upper = (s: string) => s.toUpperCase();

function zeroCounts(): CourseResult['counts'] {
  return {
    offerings: { created: 0, updated: 0, unchanged: 0, rejected: 0, failed: 0 },
    criteria: { created: 0, updated: 0, unchanged: 0 },
    schemes: { published: 0, drafted: 0, unchanged: 0, skipped: 0 },
    enrollments: { created: 0, unchanged: 0, missingInSource: 0 },
    scores: { created: 0, updated: 0, unchanged: 0, rejected: 0, clearedInSource: 0 },
  };
}

/** Thrown inside the transaction to roll back nothing-written rejections cleanly. */
class CourseRejected extends Error {
  constructor(readonly issue: SyncIssue) {
    super(issue.message);
  }
}

/**
 * Applies one confirmed subject tab in a single transaction: criteria, grading scheme,
 * enrollments and marks with revision history. Idempotent: unchanged data produces no writes
 * beyond "last seen" markers. Visibility is never touched: only a term release changes it.
 */
export async function applyCourse(
  prisma: PrismaClient,
  ctx: CourseContext,
  course: ParsedCourse,
  /** Runs inside this transaction instead of its own (all-or-nothing sheet changes). */
  shared?: Tx,
): Promise<CourseResult> {
  const counts = zeroCounts();
  const issues: SyncIssue[] = [];

  const run = (work: (tx: Tx) => Promise<void>) =>
    shared ? work(shared) : prisma.$transaction(work, TX_OPTIONS);
  try {
    await run(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssrs:sync:offering:${ctx.generationId}:${upper(course.courseKey)}`}))`;
      const offeringId = await upsertOffering(tx, ctx, course, counts);
      const criterionIdByKey = await syncCriteria(tx, offeringId, course, counts, issues);
      await syncScheme(tx, ctx, offeringId, course, criterionIdByKey, counts);
      const enrollmentIdByCode = await syncEnrollments(tx, ctx, offeringId, course, counts, issues);
      await syncScores(
        tx,
        ctx,
        offeringId,
        course,
        criterionIdByKey,
        enrollmentIdByCode,
        counts,
        issues,
      );
      await ctx.hooks?.beforeCourseCommit?.(course.courseKey);
    });
  } catch (err) {
    if (err instanceof CourseRejected) {
      const rejected = zeroCounts();
      rejected.offerings.rejected = 1;
      return { rejected: true, issues: [err.issue], counts: rejected };
    }
    throw err;
  }
  return { rejected: false, issues, counts };
}

// ---------------------------------------------------------------------------------------------

/** The offering exists since the tab was confirmed; only its sheet-derived fields can change. */
async function upsertOffering(
  tx: Tx,
  ctx: CourseContext,
  course: ParsedCourse,
  counts: CourseResult['counts'],
): Promise<string> {
  const existing = await tx.courseOffering.findUnique({ where: { id: course.offeringId } });
  if (!existing) {
    throw new CourseRejected({
      severity: 'ERROR',
      scope: 'COURSE',
      code: 'OFFERING_NOT_FOUND',
      message: `The subject for tab "${course.worksheet}" no longer exists. Confirm the tab again.`,
      sheetTab: course.worksheet,
      courseKey: course.courseKey,
    });
  }
  const data: Prisma.CourseOfferingUpdateInput = {};
  if (existing.title !== course.title) data.title = course.title;
  if (existing.sheetTab !== course.worksheet) data.sheetTab = course.worksheet;
  if (existing.sourceId !== ctx.sourceId) data.source = { connect: { id: ctx.sourceId } };
  if (Object.keys(data).length > 0) {
    await tx.courseOffering.update({ where: { id: existing.id }, data });
    counts.offerings.updated++;
  } else {
    counts.offerings.unchanged++;
  }
  return existing.id;
}

/** Creates new criteria and applies cosmetic changes (name, category, order). */
async function syncCriteria(
  tx: Tx,
  offeringId: string,
  course: ParsedCourse,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<Map<string, string>> {
  const existing = await tx.assessmentCriterion.findMany({ where: { offeringId } });
  const byKey = new Map(existing.map((c) => [upper(c.key), c]));
  const result = new Map<string, string>();
  const sheetKeys = new Set(course.criteria.map((c) => upper(c.key)));

  const toCreate: Prisma.AssessmentCriterionCreateManyInput[] = [];
  for (const parsed of course.criteria) {
    const current = byKey.get(upper(parsed.key));
    if (!current) {
      toCreate.push({
        offeringId,
        key: parsed.key,
        name: parsed.name,
        category: parsed.category,
        displayOrder: parsed.order,
      });
      continue;
    }
    result.set(upper(parsed.key), current.id);
    const data: Prisma.AssessmentCriterionUpdateInput = {};
    if (current.name !== parsed.name) data.name = parsed.name;
    if (current.category !== parsed.category) data.category = parsed.category;
    if (current.displayOrder !== parsed.order) data.displayOrder = parsed.order;
    if (Object.keys(data).length > 0) {
      await tx.assessmentCriterion.update({ where: { id: current.id }, data });
      counts.criteria.updated++;
    } else {
      counts.criteria.unchanged++;
    }
  }
  if (toCreate.length > 0) {
    const created = await tx.assessmentCriterion.createManyAndReturn({
      data: toCreate,
      select: { id: true, key: true },
    });
    for (const c of created) result.set(upper(c.key), c.id);
    counts.criteria.created += created.length;
  }
  for (const c of existing) {
    if (c.isActive && !sheetKeys.has(upper(c.key))) {
      issues.push({
        severity: 'WARNING',
        scope: 'CELL',
        code: 'CRITERION_REMOVED_IN_SOURCE',
        message: `Column "${c.name}" is no longer mapped in this tab. It is kept with its marks but does not count towards the total.`,
        sheetTab: course.worksheet,
        courseKey: course.courseKey,
        criterionKey: c.key,
      });
    }
  }
  return result;
}

/**
 * The weights confirmed on the mapping screen are authoritative: when they differ from the
 * published scheme, a new version is published and the old one archived. Results always use
 * the newest confirmed weights, and past versions stay on record.
 */
async function syncScheme(
  tx: Tx,
  ctx: CourseContext,
  offeringId: string,
  course: ParsedCourse,
  criteria: Map<string, string>,
  counts: CourseResult['counts'],
): Promise<void> {
  const items = course.criteria.map((c) => {
    const criterionId = criteria.get(upper(c.key));
    if (!criterionId) throw new Error(`Criterion ${c.key} missing after sync`);
    return { criterionId, maxMark: c.maxMark, weight: c.weight };
  });
  const published = await tx.gradingScheme.findFirst({
    where: { offeringId, status: 'PUBLISHED' },
    include: { items: true },
  });
  if (published && sameSchemeItems(published.items, items)) {
    counts.schemes.unchanged++;
    return;
  }
  if (published) {
    await tx.gradingScheme.update({ where: { id: published.id }, data: { status: 'ARCHIVED' } });
  }
  const last = await tx.gradingScheme.aggregate({ where: { offeringId }, _max: { version: true } });
  const version = (last._max.version ?? 0) + 1;
  // Follow the DB-enforced lifecycle: items can only be written while the scheme is a DRAFT.
  const draft = await tx.gradingScheme.create({
    data: {
      offeringId,
      version,
      status: 'DRAFT',
      origin: 'SHEET',
      totalWeight: '100',
      syncJobId: ctx.syncJobId,
      items: { create: items },
    },
  });
  await tx.gradingScheme.update({
    where: { id: draft.id },
    data: { status: 'PUBLISHED', publishedAt: ctx.now },
  });
  await tx.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'scheme.published',
      entityType: 'grading_scheme',
      entityId: draft.id,
      metadata: { offeringId, version, origin: 'SHEET', syncJobId: ctx.syncJobId },
    },
  });
  counts.schemes.published++;
}

const fixedTotal = (row: SubjectRow) => row.sheetTotal?.toFixed(3) ?? null;

async function syncEnrollments(
  tx: Tx,
  ctx: CourseContext,
  offeringId: string,
  course: ParsedCourse,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<Map<string, string>> {
  const existing = await tx.enrollment.findMany({
    where: { offeringId },
    include: { student: { select: { studentCode: true } } },
  });
  const byStudentId = new Map(existing.map((e) => [e.studentId, e]));
  const enrollmentIdByCode = new Map<string, string>();
  const seenIds: string[] = [];
  const toCreate: { studentId: string; code: string; row: SubjectRow }[] = [];

  for (const row of course.rows) {
    const studentId = ctx.studentIdByCode.get(row.studentCode);
    if (!studentId) continue; // rejected while applying the roster (already reported)
    const current = byStudentId.get(studentId);
    if (current) {
      seenIds.push(current.id);
      enrollmentIdByCode.set(row.studentCode, current.id);
      counts.enrollments.unchanged++;
      const sheetTotal = fixedTotal(row);
      if (
        (current.teacherComment ?? null) !== row.comment ||
        (current.sheetTotal?.toFixed(3) ?? null) !== sheetTotal
      ) {
        await tx.enrollment.update({
          where: { id: current.id },
          data: { teacherComment: row.comment, sheetTotal },
        });
      }
    } else {
      toCreate.push({ studentId, code: row.studentCode, row });
    }
  }
  if (toCreate.length > 0) {
    const created = await tx.enrollment.createManyAndReturn({
      data: toCreate.map((c) => ({
        studentId: c.studentId,
        offeringId,
        lastSeenSyncJobId: ctx.syncJobId,
        teacherComment: c.row.comment,
        sheetTotal: fixedTotal(c.row),
      })),
      select: { id: true, studentId: true },
    });
    const codeById = new Map(toCreate.map((c) => [c.studentId, c.code]));
    for (const e of created) {
      const code = codeById.get(e.studentId);
      if (code) enrollmentIdByCode.set(code, e.id);
    }
    counts.enrollments.created += created.length;
  }
  if (seenIds.length > 0) {
    await tx.enrollment.updateMany({
      where: { id: { in: seenIds } },
      data: { presentInSource: true, lastSeenSyncJobId: ctx.syncJobId },
    });
  }

  // Never delete on disappearance (SYNC-08): flag, report, keep marks.
  const seen = new Set(seenIds);
  const missing = existing.filter((e) => !seen.has(e.id) && e.presentInSource);
  if (missing.length > 0) {
    await tx.enrollment.updateMany({
      where: { id: { in: missing.map((e) => e.id) } },
      data: { presentInSource: false },
    });
    counts.enrollments.missingInSource += missing.length;
    for (const e of missing) {
      issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'ENROLLMENT_MISSING_IN_SOURCE',
        message: `Student ${e.student.studentCode} is no longer listed in this course's tab. The enrollment and marks are kept.`,
        sheetTab: course.worksheet,
        courseKey: course.courseKey,
        studentCode: e.student.studentCode,
      });
    }
  }
  return enrollmentIdByCode;
}

async function syncScores(
  tx: Tx,
  ctx: CourseContext,
  offeringId: string,
  course: ParsedCourse,
  criteria: Map<string, string>,
  enrollmentIdByCode: Map<string, string>,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<void> {
  const existing = await tx.assessmentScore.findMany({ where: { offeringId } });
  const byKey = new Map(existing.map((s) => [`${s.enrollmentId}:${s.criterionId}`, s]));
  const keyByCriterionId = new Map(course.criteria.map((c) => [criteria.get(upper(c.key)), c.key]));

  const creates: Prisma.AssessmentScoreCreateManyInput[] = [];
  const revisions: Prisma.AssessmentScoreRevisionCreateManyInput[] = [];

  for (const row of course.rows) {
    const enrollmentId = enrollmentIdByCode.get(row.studentCode);
    if (!enrollmentId) continue;
    for (const [keyUpper, value] of row.marks) {
      const criterionId = criteria.get(keyUpper);
      if (!criterionId) continue;
      const current = byKey.get(`${enrollmentId}:${criterionId}`);
      const cellAt = {
        sheetTab: course.worksheet,
        rowNumber: row.rowNumber,
        courseKey: course.courseKey,
        studentCode: row.studentCode,
        criterionKey: keyByCriterionId.get(criterionId) ?? keyUpper,
        columnKey: keyByCriterionId.get(criterionId) ?? keyUpper,
      };

      if (value === 'BLANK') {
        if (current) {
          counts.scores.clearedInSource++;
          issues.push({
            severity: 'WARNING',
            scope: 'CELL',
            code: 'MARK_CLEARED_IN_SOURCE',
            message: `The cell is now empty but a mark (${current.mark.toString()}) was recorded before. The recorded mark is kept.`,
            ...cellAt,
          });
        }
        continue;
      }

      if (current) {
        if (current.status === value.status && current.mark.equals(value.mark)) {
          counts.scores.unchanged++;
          continue;
        }
        await tx.assessmentScore.update({
          where: { id: current.id },
          data: {
            status: value.status,
            mark: value.mark,
            sourceId: ctx.sourceId,
            sourceTab: course.worksheet,
            sourceRow: row.rowNumber,
            syncJobId: ctx.syncJobId,
          },
        });
        revisions.push({
          scoreId: current.id,
          oldStatus: current.status,
          oldMark: current.mark,
          newStatus: value.status,
          newMark: value.mark,
          syncJobId: ctx.syncJobId,
          sourceTab: course.worksheet,
          sourceRow: row.rowNumber,
        });
        counts.scores.updated++;
      } else {
        creates.push({
          enrollmentId,
          offeringId,
          criterionId,
          status: value.status,
          mark: value.mark,
          sourceId: ctx.sourceId,
          sourceTab: course.worksheet,
          sourceRow: row.rowNumber,
          syncJobId: ctx.syncJobId,
        });
      }
    }
  }

  if (creates.length > 0) {
    const created = await tx.assessmentScore.createManyAndReturn({
      data: creates,
      select: { id: true, status: true, mark: true, sourceTab: true, sourceRow: true },
    });
    for (const s of created) {
      revisions.push({
        scoreId: s.id,
        newStatus: s.status,
        newMark: s.mark,
        syncJobId: ctx.syncJobId,
        sourceTab: s.sourceTab,
        sourceRow: s.sourceRow,
      });
    }
    counts.scores.created += created.length;
  }
  if (revisions.length > 0) await tx.assessmentScoreRevision.createMany({ data: revisions });
}
