import type { Prisma, PrismaClient } from '@ssrs/database';
import type { ParsedCourse } from '@ssrs/sheets';
import { tryDecimal } from '@ssrs/shared';
import { sameSchemeItems } from './scheme-diff.js';
import type { SyncCounts, SyncDeps, SyncIssue } from './types.js';

export interface CourseContext {
  syncJobId: string;
  sourceId: string;
  generationId: string;
  termIdByNumber: Map<number, string>;
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
 * Applies one course offering in a single transaction (docs/architecture.md §5): offering,
 * criteria, grading scheme (hybrid rule A1), enrollments and marks with revision history.
 * Idempotent: unchanged data produces no writes beyond "last seen" markers.
 */
export async function applyCourse(
  prisma: PrismaClient,
  ctx: CourseContext,
  course: ParsedCourse,
): Promise<CourseResult> {
  const counts = zeroCounts();
  const issues: SyncIssue[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssrs:sync:offering:${ctx.generationId}:${upper(course.courseKey)}`}))`;
      const offeringId = await upsertOffering(tx, ctx, course, counts);
      const criterionIdByKey = await syncCriteria(tx, offeringId, course, counts, issues);
      const effectiveMax = await syncScheme(
        tx,
        ctx,
        offeringId,
        course,
        criterionIdByKey,
        counts,
        issues,
      );
      const enrollmentIdByCode = await syncEnrollments(tx, ctx, offeringId, course, counts, issues);
      await syncScores(
        tx,
        ctx,
        offeringId,
        course,
        criterionIdByKey,
        enrollmentIdByCode,
        effectiveMax,
        counts,
        issues,
      );
      await ctx.hooks?.beforeCourseCommit?.(course.courseKey);
    }, TX_OPTIONS);
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

async function upsertOffering(
  tx: Tx,
  ctx: CourseContext,
  course: ParsedCourse,
  counts: CourseResult['counts'],
): Promise<string> {
  const at = { sheetTab: 'Courses', rowNumber: course.rowNumber, courseKey: course.courseKey };
  const termId = ctx.termIdByNumber.get(course.termNumber);
  if (!termId) throw new Error(`Generation has no term ${course.termNumber}`);

  const catalog = await tx.course.upsert({
    where: { code: course.courseCode },
    create: { code: course.courseCode, name: course.courseName },
    update: {},
  });
  const visibility = course.visible ? 'VISIBLE' : 'HIDDEN';
  const existing = await tx.courseOffering.findUnique({
    where: {
      generationId_externalKey: { generationId: ctx.generationId, externalKey: course.courseKey },
    },
  });

  if (!existing) {
    const clash = await tx.courseOffering.findUnique({
      where: { termId_courseId: { termId, courseId: catalog.id } },
    });
    if (clash) {
      throw new CourseRejected({
        severity: 'ERROR',
        scope: 'COURSE',
        code: 'OFFERING_EXISTS_FOR_COURSE',
        message: `${course.courseCode} is already offered in term ${course.termNumber} under the key "${clash.externalKey}".`,
        ...at,
      });
    }
    const created = await tx.courseOffering.create({
      data: {
        termId,
        generationId: ctx.generationId,
        courseId: catalog.id,
        externalKey: course.courseKey,
        title: course.courseName,
        credits: course.credits,
        visibility,
        sourceId: ctx.sourceId,
        sheetTab: course.worksheet,
      },
    });
    counts.offerings.created++;
    return created.id;
  }

  if (existing.sourceId !== ctx.sourceId) {
    throw new CourseRejected({
      severity: 'ERROR',
      scope: 'COURSE',
      code: 'OFFERING_OWNED_ELSEWHERE',
      message: existing.sourceId
        ? `Course "${course.courseKey}" is managed by another spreadsheet of this generation.`
        : `Course "${course.courseKey}" was created manually in the app and is not managed by a spreadsheet.`,
      ...at,
    });
  }
  if (existing.termId !== termId) {
    throw new CourseRejected({
      severity: 'ERROR',
      scope: 'COURSE',
      code: 'OFFERING_TERM_CHANGED',
      message: `Course "${course.courseKey}" was imported into a different term; moving recorded results between terms is not allowed. Use a new course_key.`,
      ...at,
    });
  }
  if (existing.courseId !== catalog.id) {
    throw new CourseRejected({
      severity: 'ERROR',
      scope: 'COURSE',
      code: 'OFFERING_COURSE_CHANGED',
      message: `Course "${course.courseKey}" was imported with a different course_code. Use a new course_key.`,
      ...at,
    });
  }

  const data: Prisma.CourseOfferingUpdateInput = {};
  if (existing.title !== course.courseName) data.title = course.courseName;
  if (!existing.credits.equals(course.credits)) data.credits = course.credits;
  if (existing.sheetTab !== course.worksheet) data.sheetTab = course.worksheet;
  if (!existing.visibilityOverridden && existing.visibility !== visibility)
    data.visibility = visibility;
  if (Object.keys(data).length > 0) {
    await tx.courseOffering.update({ where: { id: existing.id }, data });
    counts.offerings.updated++;
  } else {
    counts.offerings.unchanged++;
  }
  return existing.id;
}

/** Creates new criteria and applies cosmetic changes (name, category, description, order). */
async function syncCriteria(
  tx: Tx,
  offeringId: string,
  course: ParsedCourse,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<Map<string, { id: string; isActive: boolean }>> {
  const existing = await tx.assessmentCriterion.findMany({ where: { offeringId } });
  const byKey = new Map(existing.map((c) => [upper(c.key), c]));
  const result = new Map<string, { id: string; isActive: boolean }>();
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
        description: parsed.description,
        displayOrder: parsed.order,
      });
      continue;
    }
    result.set(upper(parsed.key), { id: current.id, isActive: current.isActive });
    if (!current.isActive) {
      issues.push({
        severity: 'WARNING',
        scope: 'CELL',
        code: 'CRITERION_INACTIVE',
        message: `Criterion "${current.key}" is disabled in the app. Its marks are stored but it is not reactivated.`,
        sheetTab: 'Criteria',
        rowNumber: parsed.rowNumber,
        courseKey: course.courseKey,
        criterionKey: current.key,
      });
    }
    const data: Prisma.AssessmentCriterionUpdateInput = {};
    if (current.name !== parsed.name) data.name = parsed.name;
    if (current.category !== parsed.category) data.category = parsed.category;
    if ((current.description ?? null) !== parsed.description) data.description = parsed.description;
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
    for (const c of created) result.set(upper(c.key), { id: c.id, isActive: true });
    counts.criteria.created += created.length;
  }
  for (const c of existing) {
    if (c.isActive && !sheetKeys.has(upper(c.key))) {
      issues.push({
        severity: 'WARNING',
        scope: 'CELL',
        code: 'CRITERION_REMOVED_IN_SOURCE',
        message: `Criterion "${c.key}" is no longer in the Criteria tab. It is kept (with its marks); disable it in the app if it was removed on purpose.`,
        sheetTab: 'Criteria',
        courseKey: course.courseKey,
        criterionKey: c.key,
      });
    }
  }
  return result;
}

/**
 * Hybrid structure authority (docs/requirements.md A1):
 *  - no published scheme → the sheet's scheme is published as the next version;
 *  - published scheme equals the sheet → nothing to do (a stale sheet-made draft is dropped);
 *  - otherwise → a DRAFT (origin SHEET) awaits an admin, unless an admin draft exists.
 * Returns the max mark to validate marks against, per criterion id.
 */
async function syncScheme(
  tx: Tx,
  ctx: CourseContext,
  offeringId: string,
  course: ParsedCourse,
  criteria: Map<string, { id: string; isActive: boolean }>,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<Map<string, string>> {
  const at = { sheetTab: 'Criteria', courseKey: course.courseKey };
  const sheetMax = new Map<string, string>();
  const desired = course.criteria.map((c) => {
    const criterion = criteria.get(upper(c.key));
    if (!criterion) throw new Error(`Criterion ${c.key} missing after sync`);
    sheetMax.set(criterion.id, c.maxMark);
    return {
      criterionId: criterion.id,
      maxMark: c.maxMark,
      weight: c.weight,
      isActive: criterion.isActive,
    };
  });

  let published = await tx.gradingScheme.findFirst({
    where: { offeringId, status: 'PUBLISHED' },
    include: { items: true },
  });

  if (!course.schemeValid) {
    counts.schemes.skipped++;
  } else if (desired.some((d) => !d.isActive)) {
    counts.schemes.skipped++;
    issues.push({
      severity: 'WARNING',
      scope: 'COURSE',
      code: 'SCHEME_HAS_INACTIVE_CRITERIA',
      message:
        "The sheet's grading scheme uses a criterion that is disabled in the app, so it was not applied.",
      ...at,
    });
  } else if (
    !published &&
    (await tx.gradingScheme.count({ where: { offeringId, status: 'DRAFT', origin: 'ADMIN' } })) > 0
  ) {
    counts.schemes.skipped++;
    issues.push({
      severity: 'WARNING',
      scope: 'COURSE',
      code: 'SCHEME_DRAFT_CONFLICT',
      message:
        "An admin draft scheme exists for this course, so the sheet's scheme was not published.",
      ...at,
    });
  } else if (!published) {
    const items = desired.map((d) => ({
      criterionId: d.criterionId,
      maxMark: d.maxMark,
      weight: d.weight,
    }));
    // Follow the DB-enforced lifecycle: items can only change while the scheme is a DRAFT.
    const existingDraft = await tx.gradingScheme.findFirst({
      where: { offeringId, status: 'DRAFT' },
    });
    let draft: { id: string; version: number };
    if (existingDraft) {
      await tx.gradingSchemeItem.deleteMany({ where: { schemeId: existingDraft.id } });
      draft = await tx.gradingScheme.update({
        where: { id: existingDraft.id },
        data: { syncJobId: ctx.syncJobId, totalWeight: '100', items: { create: items } },
      });
    } else {
      const last = await tx.gradingScheme.aggregate({
        where: { offeringId },
        _max: { version: true },
      });
      draft = await tx.gradingScheme.create({
        data: {
          offeringId,
          version: (last._max.version ?? 0) + 1,
          status: 'DRAFT',
          origin: 'SHEET',
          totalWeight: '100',
          syncJobId: ctx.syncJobId,
          items: { create: items },
        },
      });
    }
    const version = draft.version;
    published = await tx.gradingScheme.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: ctx.now },
      include: { items: true },
    });
    await tx.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'scheme.published',
        entityType: 'grading_scheme',
        entityId: published.id,
        metadata: { offeringId, version, origin: 'SHEET', syncJobId: ctx.syncJobId },
      },
    });
    counts.schemes.published++;
  } else if (sameSchemeItems(published.items, desired)) {
    counts.schemes.unchanged++;
    await tx.gradingScheme.deleteMany({ where: { offeringId, status: 'DRAFT', origin: 'SHEET' } });
  } else {
    const draft = await tx.gradingScheme.findFirst({
      where: { offeringId, status: 'DRAFT' },
      include: { items: true },
    });
    if (draft?.origin === 'ADMIN') {
      counts.schemes.skipped++;
      issues.push({
        severity: 'WARNING',
        scope: 'COURSE',
        code: 'SCHEME_DRAFT_CONFLICT',
        message:
          "The sheet's weights or max marks differ from the published scheme, but an admin draft exists and was left untouched.",
        ...at,
      });
    } else {
      if (draft && sameSchemeItems(draft.items, desired)) {
        counts.schemes.unchanged++;
      } else {
        const items = desired.map((d) => ({
          criterionId: d.criterionId,
          maxMark: d.maxMark,
          weight: d.weight,
        }));
        if (draft) {
          await tx.gradingSchemeItem.deleteMany({ where: { schemeId: draft.id } });
          await tx.gradingScheme.update({
            where: { id: draft.id },
            data: { syncJobId: ctx.syncJobId, totalWeight: '100', items: { create: items } },
          });
        } else {
          const last = await tx.gradingScheme.aggregate({
            where: { offeringId },
            _max: { version: true },
          });
          await tx.gradingScheme.create({
            data: {
              offeringId,
              version: (last._max.version ?? 0) + 1,
              status: 'DRAFT',
              origin: 'SHEET',
              totalWeight: '100',
              syncJobId: ctx.syncJobId,
              items: { create: items },
            },
          });
        }
        counts.schemes.drafted++;
      }
      issues.push({
        severity: 'WARNING',
        scope: 'COURSE',
        code: 'SCHEME_DRAFT_PENDING',
        message:
          'The sheet changes weights or max marks. A draft scheme awaits review and publication by an admin; results still use the published scheme.',
        ...at,
      });
    }
  }

  // Marks are validated against the published max where a criterion is published, else the sheet's.
  const effective = new Map(sheetMax);
  for (const item of published?.items ?? [])
    effective.set(item.criterionId, item.maxMark.toString());
  return effective;
}

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
  const toCreate: { studentId: string; code: string }[] = [];

  for (const row of course.rows) {
    const studentId = ctx.studentIdByCode.get(row.studentCode);
    if (!studentId) continue; // rejected while applying the roster (already reported)
    const current = byStudentId.get(studentId);
    if (current) {
      seenIds.push(current.id);
      enrollmentIdByCode.set(row.studentCode, current.id);
      counts.enrollments.unchanged++;
    } else {
      toCreate.push({ studentId, code: row.studentCode });
    }
  }
  if (toCreate.length > 0) {
    const created = await tx.enrollment.createManyAndReturn({
      data: toCreate.map((c) => ({
        studentId: c.studentId,
        offeringId,
        lastSeenSyncJobId: ctx.syncJobId,
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
  criteria: Map<string, { id: string; isActive: boolean }>,
  enrollmentIdByCode: Map<string, string>,
  effectiveMax: Map<string, string>,
  counts: CourseResult['counts'],
  issues: SyncIssue[],
): Promise<void> {
  const existing = await tx.assessmentScore.findMany({ where: { offeringId } });
  const byKey = new Map(existing.map((s) => [`${s.enrollmentId}:${s.criterionId}`, s]));
  const keyByCriterionId = new Map(
    course.criteria.map((c) => [criteria.get(upper(c.key))?.id, c.key]),
  );

  const creates: Prisma.AssessmentScoreCreateManyInput[] = [];
  const revisions: Prisma.AssessmentScoreRevisionCreateManyInput[] = [];

  for (const row of course.rows) {
    const enrollmentId = enrollmentIdByCode.get(row.studentCode);
    if (!enrollmentId) continue;
    for (const [keyUpper, value] of row.marks) {
      const criterion = criteria.get(keyUpper);
      if (!criterion) continue;
      const current = byKey.get(`${enrollmentId}:${criterion.id}`);
      const cellAt = {
        sheetTab: course.worksheet,
        rowNumber: row.rowNumber,
        courseKey: course.courseKey,
        studentCode: row.studentCode,
        criterionKey: keyByCriterionId.get(criterion.id) ?? keyUpper,
        columnKey: keyByCriterionId.get(criterion.id) ?? keyUpper,
      };

      if (value === 'BLANK') {
        if (current) {
          counts.scores.clearedInSource++;
          issues.push({
            severity: 'WARNING',
            scope: 'CELL',
            code: 'MARK_CLEARED_IN_SOURCE',
            message: `The cell is now empty but a mark (${current.mark.toString()}) was recorded before. The recorded mark is kept; correct it in the app if it should be removed.`,
            ...cellAt,
          });
        }
        continue;
      }

      const max = effectiveMax.get(criterion.id);
      const mark = tryDecimal(value.mark);
      if (!mark || (max !== undefined && mark.gt(max))) {
        counts.scores.rejected++;
        issues.push({
          severity: 'ERROR',
          scope: 'CELL',
          code: 'MARK_EXCEEDS_PUBLISHED_MAX',
          message: `Mark ${value.mark} exceeds the published maximum (${max}). Publish the draft scheme with the new maximum, then sync again.`,
          rawValue: value.mark,
          ...cellAt,
        });
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
          criterionId: criterion.id,
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
