import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import {
  computeCourseResult,
  computeTermSummary,
  type CourseResult,
  type CourseResultView,
  type StudentCourseListItem,
  type StudentProfileView,
  type StudentResultsView,
  type StudentSummaryView,
  type TermResultView,
  type TermSummary,
} from '@ssrs/shared';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisService } from '../infra/redis.service.js';

/** Cached student views live until the generation version moves on, at most this long. */
export const RESULTS_CACHE_TTL_SECONDS = 600;

/** docs/architecture.md §6. The version segment makes stale entries unreachable. */
export function resultsCacheKey(generationId: string, version: number, studentId: string): string {
  return `ssrs:v1:results:gen:${generationId}:v${version}:student:${studentId}`;
}

const STUDENT_SELECT = {
  id: true,
  studentCode: true,
  fullName: true,
  gender: true,
  className: true,
  generation: { select: { id: true, code: true, name: true, cacheVersion: true } },
} satisfies Prisma.StudentSelect;

type StudentRow = Prisma.StudentGetPayload<{ select: typeof STUDENT_SELECT }>;

const ENROLLMENT_INCLUDE = {
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

type EnrollmentRow = Prisma.EnrollmentGetPayload<{ include: typeof ENROLLMENT_INCLUDE }>;

/** What is cached: the overall summary needs exact final scores, which views do not carry. */
interface AssembledResults {
  results: StudentResultsView;
  overall: TermSummary;
}

interface AssembleOptions {
  /** Admin view: hidden offerings and withdrawn enrollments, with `admin` metadata. */
  admin: boolean;
}

function toProfile(s: StudentRow): StudentProfileView {
  const { cacheVersion: _version, ...generation } = s.generation;
  return {
    id: s.id,
    studentCode: s.studentCode,
    fullName: s.fullName,
    gender: s.gender,
    className: s.className,
    generation,
  };
}

/**
 * Builds student results from raw marks and the currently PUBLISHED schemes (GRADE-08). Nothing
 * computed is stored. Student views are cached per generation version; admin views never are.
 */
@Injectable()
export class ResultsService {
  private readonly logger = new Logger(ResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Results as the student sees them (STU-04: VISIBLE offerings, ENROLLED only). */
  async forStudentUser(userId: string): Promise<StudentResultsView> {
    return (await this.load(userId)).results;
  }

  private async load(userId: string): Promise<AssembledResults> {
    const student = await this.prisma.client.student.findUnique({
      where: { userId },
      select: STUDENT_SELECT,
    });
    // Every STUDENT user has a student row; treat a missing one like any unknown resource.
    if (!student) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });

    const key = resultsCacheKey(student.generation.id, student.generation.cacheVersion, student.id);
    const cached = await this.cacheGet(key);
    if (cached) return cached;

    const view = await this.assemble(student, { admin: false });
    await this.cacheSet(key, view);
    return view;
  }

  /** Admin view of one student: every offering including hidden ones. Never cached. */
  async forAdmin(studentId: string): Promise<StudentResultsView> {
    const student = await this.prisma.client.student.findUnique({
      where: { id: studentId },
      select: STUDENT_SELECT,
    });
    if (!student) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });
    return (await this.assemble(student, { admin: true })).results;
  }

  async profile(userId: string): Promise<StudentProfileView> {
    return (await this.forStudentUser(userId)).student;
  }

  async summary(userId: string): Promise<StudentSummaryView> {
    const { results, overall } = await this.load(userId);
    return {
      student: results.student,
      terms: results.terms.map((t) => ({ number: t.number, name: t.name, summary: t.summary })),
      overall,
    };
  }

  async courses(userId: string): Promise<StudentCourseListItem[]> {
    const results = await this.forStudentUser(userId);
    return results.terms.flatMap((t) =>
      t.courses.map((c) => ({
        offeringId: c.offeringId,
        termNumber: c.termNumber,
        courseCode: c.courseCode,
        title: c.title,
        credits: c.credits,
        status: c.status,
        finalScore: c.finalScore,
      })),
    );
  }

  /** 404 alike for unknown, hidden, withdrawn and other students' offerings. */
  async course(userId: string, offeringId: string): Promise<CourseResultView> {
    const results = await this.forStudentUser(userId);
    const course = results.terms.flatMap((t) => t.courses).find((c) => c.offeringId === offeringId);
    if (!course) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course not found' });
    return course;
  }

  /**
   * Three batched reads: terms; enrollments with offering, course and published scheme items;
   * scores of those enrollments.
   */
  private async assemble(student: StudentRow, options: AssembleOptions): Promise<AssembledResults> {
    const db = this.prisma.client;
    const [terms, enrollments] = await Promise.all([
      db.term.findMany({
        where: { generationId: student.generation.id },
        orderBy: { number: 'asc' },
        select: { id: true, number: true, name: true, startDate: true, endDate: true },
      }),
      db.enrollment.findMany({
        where: {
          studentId: student.id,
          ...(options.admin ? {} : { status: 'ENROLLED', offering: { visibility: 'VISIBLE' } }),
        },
        include: ENROLLMENT_INCLUDE,
      }),
    ]);
    const scores = enrollments.length
      ? await db.assessmentScore.findMany({
          where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
          select: { enrollmentId: true, criterionId: true, status: true, mark: true },
        })
      : [];

    const scoresByEnrollment = new Map<string, typeof scores>();
    for (const score of scores) {
      const list = scoresByEnrollment.get(score.enrollmentId) ?? [];
      list.push(score);
      scoresByEnrollment.set(score.enrollmentId, list);
    }

    const termNumberById = new Map(terms.map((t) => [t.id, t.number]));
    const coursesByTerm = new Map<string, Computed[]>();
    for (const enrollment of enrollments) {
      const termNumber = termNumberById.get(enrollment.offering.termId);
      if (termNumber === undefined) continue; // composite FK makes this unreachable
      const computed = computeCourse(
        enrollment,
        termNumber,
        scoresByEnrollment.get(enrollment.id) ?? [],
        options,
      );
      const list = coursesByTerm.get(enrollment.offering.termId) ?? [];
      list.push(computed);
      coursesByTerm.set(enrollment.offering.termId, list);
    }

    const all: Computed[] = [];
    const termViews = terms.map((term): TermResultView => {
      const courses = (coursesByTerm.get(term.id) ?? []).toSorted(
        (a, b) =>
          a.view.courseCode.localeCompare(b.view.courseCode) ||
          a.view.title.localeCompare(b.view.title),
      );
      all.push(...courses);
      return {
        number: term.number,
        name: term.name,
        startDate: term.startDate?.toISOString().slice(0, 10) ?? null,
        endDate: term.endDate?.toISOString().slice(0, 10) ?? null,
        summary: summarizeCourses(courses),
        courses: courses.map((c) => c.view),
      };
    });
    return {
      results: { student: toProfile(student), terms: termViews },
      overall: summarizeCourses(all),
    };
  }

  // Redis is an optimization: when it is unavailable, results are served from PostgreSQL.
  private async cacheGet(key: string): Promise<AssembledResults | null> {
    try {
      const raw = await this.redis.client.get(key);
      return raw ? (JSON.parse(raw) as AssembledResults) : null;
    } catch (err) {
      this.logger.warn(`Results cache read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async cacheSet(key: string, view: AssembledResults): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(view), 'EX', RESULTS_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Results cache write failed: ${(err as Error).message}`);
    }
  }
}

interface Computed {
  view: CourseResultView;
  result: CourseResult;
  /** Withdrawn enrollments (admin view only) are listed but not counted in summaries. */
  counted: boolean;
}

function summarizeCourses(courses: readonly Computed[]): TermSummary {
  return computeTermSummary(
    courses.filter((c) => c.counted).map((c) => ({ credits: c.view.credits, result: c.result })),
  );
}

function computeCourse(
  enrollment: EnrollmentRow,
  termNumber: number,
  scores: { criterionId: string; status: 'RECORDED' | 'ABSENT'; mark: Prisma.Decimal }[],
  options: AssembleOptions,
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
    attemptedWeight: result.attemptedWeight,
    earnedSoFar: result.earnedSoFar,
    ...(options.admin
      ? {
          admin: {
            visibility: offering.visibility,
            enrollmentStatus: enrollment.status,
            presentInSource: enrollment.presentInSource,
          },
        }
      : {}),
  };
  return { view, result, counted: enrollment.status === 'ENROLLED' };
}
