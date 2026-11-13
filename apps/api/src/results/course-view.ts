import type { Logger } from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import {
  computeCourseResult,
  gradeFor,
  isUsableGradeScale,
  type CourseResult,
  type CourseResultView,
  type GradeBandInput,
} from '@ssrs/shared';

/**
 * One subject result as students and admins see it, from raw marks and the PUBLISHED scheme.
 * Shared by the results views and admin subject monitoring, so both compute it one way.
 */

export const ENROLLMENT_INCLUDE = {
  offering: {
    select: {
      id: true,
      termId: true,
      title: true,
      credits: true,
      visibility: true,
      course: { select: { code: true } },
      schemes: {
        where: { status: 'PUBLISHED' },
        select: {
          version: true,
          items: {
            select: {
              criterionId: true,
              maxMark: true,
              weight: true,
              criterion: { select: { key: true, name: true, category: true, displayOrder: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.EnrollmentInclude;

export type EnrollmentRow = Prisma.EnrollmentGetPayload<{ include: typeof ENROLLMENT_INCLUDE }>;

/** What computeCourse reads of an enrollment (an EnrollmentRow, or one assembled from batches). */
export type CourseEnrollment = Pick<
  EnrollmentRow,
  'offering' | 'teacherComment' | 'status' | 'endedReason' | 'presentInSource'
>;

export interface CourseViewOptions {
  /** Admin view: hidden offerings and withdrawn enrollments, with `admin` metadata. */
  admin: boolean;
  /** The generation's confirmed letter-grade bands; null gives no grades at all. */
  bands: readonly GradeBandInput[] | null;
}

export interface Computed {
  view: CourseResultView;
  result: CourseResult;
  /** Withdrawn enrollments (admin view only) are listed but not counted in summaries. */
  counted: boolean;
}

export interface GenerationScale<B extends GradeBandInput> {
  id: string;
  gradeScale: { confirmed: boolean; bands: B[] } | null;
}

/**
 * Letters come only from a confirmed, usable scale. Without one there is no grade (never a
 * default letter) and an error is logged, by generation id only.
 */
export function bandsOf<B extends GradeBandInput>(
  generation: GenerationScale<B>,
  logger: Pick<Logger, 'error'>,
): readonly B[] | null {
  const scale = generation.gradeScale;
  if (scale?.confirmed && isUsableGradeScale(scale.bands)) return scale.bands;
  logger.error(
    `Generation ${generation.id} has no confirmed, usable grade scale: grades are not shown`,
  );
  return null;
}

export function computeCourse(
  enrollment: CourseEnrollment,
  termNumber: number,
  scores: { criterionId: string; status: 'RECORDED' | 'ABSENT'; mark: Prisma.Decimal }[],
  options: CourseViewOptions,
): Computed {
  const { offering } = enrollment;
  const scheme = offering.schemes[0] ?? null;
  const items = scheme
    ? scheme.items.toSorted(
        (a, b) =>
          a.criterion.displayOrder - b.criterion.displayOrder ||
          a.criterion.key.localeCompare(b.criterion.key),
      )
    : null;
  const result = computeCourseResult(
    items?.map((i) => ({ criterionId: i.criterionId, maxMark: i.maxMark, weight: i.weight })) ??
      null,
    scores.map((s) => ({ criterionId: s.criterionId, status: s.status, mark: s.mark })),
  );

  const criterionById = new Map(items?.map((i) => [i.criterionId, i.criterion]));
  const view: CourseResultView = {
    offeringId: offering.id,
    termNumber,
    courseCode: offering.course.code,
    title: offering.title,
    credits: offering.credits.toFixed(1),
    status: result.status,
    schemeVersion: scheme && result.status !== 'NOT_CONFIGURED' ? scheme.version : null,
    criteria: result.criteria.flatMap((c) => {
      const criterion = criterionById.get(c.criterionId);
      if (!criterion) return [];
      return {
        criterionId: c.criterionId,
        key: criterion.key,
        name: criterion.name,
        category: criterion.category,
        order: criterion.displayOrder,
        maxMark: c.maxMark,
        weight: c.weight,
        score: c.score,
        contribution: c.contribution,
        invalidMark: c.invalidMark,
      };
    }),
    finalScore: result.finalScore,
    // Only beside a COMPLETE subject's final score (finalScore is null otherwise).
    finalGrade: result.status === 'COMPLETE' ? gradeFor(options.bands, result.finalScore) : null,
    attemptedWeight: result.attemptedWeight,
    earnedSoFar: result.earnedSoFar,
    teacherComment: enrollment.teacherComment,
    ...(options.admin
      ? {
          admin: {
            visibility: offering.visibility,
            enrollmentStatus: enrollment.status,
            endedReason: enrollment.endedReason,
            presentInSource: enrollment.presentInSource,
          },
        }
      : {}),
  };
  return { view, result, counted: enrollment.status === 'ENROLLED' };
}
