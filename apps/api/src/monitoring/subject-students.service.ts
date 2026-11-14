import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import {
  formatFixed,
  GRADED_LEVELS,
  GradeDecimal,
  levelFor,
  MONITORING_LEVELS,
  SCORE_DP,
  toDecimal,
  VALUE_DP,
  type GradeScaleInfo,
  type LastSyncInfo,
  type LevelCounts,
  type MonitoringCriterion,
  type MonitoringLevel,
  type MonitoringMark,
  type MonitoringStudentRow,
  type MonitoringSubjectRef,
  type ProgramRef,
} from '@ssrs/shared';
import { PrismaService } from '../infra/prisma.service.js';
import {
  bandsOf,
  computeCourse,
  ENROLLMENT_INCLUDE,
  type Computed,
} from '../results/course-view.js';

/**
 * Every student row of a subject selection, computed exactly as the results views compute them
 * (course-view.ts), and the counts over those rows. Page 1 (term subjects), page 2 (one subject)
 * and a later export all go through `loadTerm` → `loadRows` → `summarize`, so their counts agree.
 * A fixed number of queries per call, whatever the number of students. Read-only; never cached.
 */

const OFFERING_SELECT = {
  ...ENROLLMENT_INCLUDE.offering.select,
  courseId: true,
  status: true,
  archivedAt: true,
  programs: { select: { program: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.CourseOfferingSelect;

const TERM_SELECT = {
  id: true,
  number: true,
  name: true,
  generation: {
    select: {
      id: true,
      code: true,
      name: true,
      gradeScale: {
        select: {
          confirmed: true,
          bands: { select: { letter: true, minTotal: true, isPass: true, level: true } },
        },
      },
    },
  },
  programs: {
    select: {
      program: { select: { id: true, code: true, name: true } },
      classes: { select: { id: true, name: true, programId: true } },
    },
  },
  sources: {
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      label: true,
      spreadsheetTitle: true,
      lastSyncedAt: true,
      syncJobs: {
        orderBy: { queuedAt: 'desc' },
        take: 1,
        select: { id: true, status: true, errorCount: true, warningCount: true },
      },
    },
  },
} satisfies Prisma.TermSelect;

type TermRow = Prisma.TermGetPayload<{ select: typeof TERM_SELECT }>;
export type OfferingRow = Prisma.CourseOfferingGetPayload<{ select: typeof OFFERING_SELECT }>;
type BandRow = NonNullable<TermRow['generation']['gradeScale']>['bands'][number];

export interface TermClassRef {
  id: string;
  name: string;
  programId: string;
  programCode: string;
}

/** A term with its configuration, grade scale, last sync and offerings (ACTIVE and ARCHIVED). */
export interface TermContext {
  generation: { id: string; code: string; name: string };
  term: { id: string; number: number; name: string };
  /** The term's programs (term_programs), by code. */
  programs: ProgramRef[];
  /** The term's class list (term_classes), by program code then name. */
  classes: TermClassRef[];
  /** Confirmed, usable bands with their levels; null: no grades and no graded levels. */
  bands: readonly BandRow[] | null;
  gradeScale: GradeScaleInfo;
  lastSync: LastSyncInfo | null;
  offerings: OfferingRow[];
}

/** One enrollment of a subject, computed. Withdrawn rows are listed but never counted. */
export interface SubjectStudent {
  enrollmentId: string;
  offeringId: string;
  studentId: string;
  studentCode: string;
  fullName: string;
  /** The student's program and class in this term (student_terms); null without one. */
  program: ProgramRef | null;
  className: string | null;
  computed: Computed;
  level: MonitoringLevel | null;
  /** The band's is_pass for a COMPLETE result with a grade; null otherwise. */
  passed: boolean | null;
  withdrawn: boolean;
  withdrawnByProgramSwitch: boolean;
  presentInSource: boolean;
  teacherComment: string | null;
}

export interface SubjectStats {
  students: number;
  complete: number;
  incomplete: number;
  needsReview: number;
  /** Graded keys stay 0 without a usable scale. */
  levels: LevelCounts;
  passRate: string | null;
  averageTotal: string | null;
  highestTotal: string | null;
  lowestTotal: string | null;
  withdrawn: number;
  withdrawnByProgramSwitch: number;
  missingFromSheet: number;
}

const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);

export function isNeedsReview(status: string): boolean {
  return status === 'NEEDS_REVIEW' || status === 'NOT_CONFIGURED';
}

/** Percent with 1 decimal, half up. */
export function percent(count: number, of: number): string {
  if (of === 0) return formatFixed(new GradeDecimal(0), 1);
  return formatFixed(new GradeDecimal(count).div(of).times(100), 1);
}

/** The published scheme's criteria, in the order the results views use. */
export function criteriaOf(offering: OfferingRow): MonitoringCriterion[] {
  const scheme = offering.schemes[0];
  if (!scheme) return [];
  return scheme.items
    .toSorted(
      (a, b) =>
        a.criterion.displayOrder - b.criterion.displayOrder ||
        a.criterion.key.localeCompare(b.criterion.key),
    )
    .map((i) => ({
      criterionId: i.criterionId,
      key: i.criterion.key,
      name: i.criterion.name,
      order: i.criterion.displayOrder,
      maxMark: formatFixed(toDecimal(i.maxMark), VALUE_DP),
      weight: formatFixed(toDecimal(i.weight), VALUE_DP),
    }));
}

/** SHARED (no offering_programs rows) is offered to every program of the term. */
export function audienceOf(offering: OfferingRow, termPrograms: ProgramRef[]) {
  const own = offering.programs.map((p) => p.program).toSorted(byCode);
  return own.length
    ? { kind: 'PROGRAM' as const, programs: own }
    : { kind: 'SHARED' as const, programs: termPrograms };
}

export function subjectRef(
  offering: OfferingRow,
  termPrograms: ProgramRef[],
): MonitoringSubjectRef {
  const scheme = offering.schemes[0];
  return {
    subjectId: offering.courseId,
    offeringId: offering.id,
    courseCode: offering.course.code,
    title: offering.title,
    audience: audienceOf(offering, termPrograms),
    visibility: offering.visibility,
    archived: offering.status === 'ARCHIVED',
    archivedAt: offering.archivedAt?.toISOString() ?? null,
    configured: !!scheme && scheme.items.length > 0,
  };
}

/** The row the student table shows. */
export function toStudentRow(s: SubjectStudent): MonitoringStudentRow {
  const marks: Record<string, MonitoringMark | null> = {};
  for (const c of s.computed.view.criteria) marks[c.criterionId] = c.score;
  const status = s.computed.view.status;
  return {
    studentId: s.studentId,
    studentCode: s.studentCode,
    fullName: s.fullName,
    program: s.program,
    className: s.className,
    marks,
    status,
    finalScore: s.computed.view.finalScore,
    finalGrade: s.computed.view.finalGrade,
    level: s.level,
    teacherComment: s.teacherComment,
    flags: {
      withdrawn: s.withdrawn,
      withdrawnByProgramSwitch: s.withdrawnByProgramSwitch,
      presentInSource: s.presentInSource,
      needsReview: isNeedsReview(status),
    },
  };
}

/**
 * The counts of a set of rows (docs/decisions.md, Subject monitoring): ENROLLED rows only;
 * NEEDS_REVIEW and NOT_CONFIGURED are INCOMPLETE and also `needsReview`; averages, extremes and
 * pass rate over COMPLETE results only. Page 1 and page 2 both call this.
 */
export function summarize(rows: readonly SubjectStudent[], usable: boolean): SubjectStats {
  const levels = Object.fromEntries(MONITORING_LEVELS.map((l) => [l, 0])) as LevelCounts;
  const enrolled = rows.filter((r) => !r.withdrawn);
  let complete = 0;
  let needsReview = 0;
  let passed = 0;
  let sum = new GradeDecimal(0);
  let highest: GradeDecimal | null = null;
  let lowest: GradeDecimal | null = null;
  for (const r of enrolled) {
    if (r.level && (usable || r.level === 'INCOMPLETE')) levels[r.level]++;
    if (isNeedsReview(r.computed.result.status)) needsReview++;
    const exact = r.computed.result.finalScoreExact;
    if (r.computed.result.status !== 'COMPLETE' || !exact) continue;
    complete++;
    if (r.passed) passed++;
    sum = sum.plus(exact);
    if (!highest || exact.gt(highest)) highest = exact;
    if (!lowest || exact.lt(lowest)) lowest = exact;
  }
  const withdrawn = rows.filter((r) => r.withdrawn);
  return {
    students: enrolled.length,
    complete,
    incomplete: enrolled.length - complete,
    needsReview,
    levels,
    passRate: usable && complete > 0 ? percent(passed, complete) : null,
    averageTotal: complete > 0 ? formatFixed(sum.div(complete), SCORE_DP) : null,
    highestTotal: highest ? formatFixed(highest, SCORE_DP) : null,
    lowestTotal: lowest ? formatFixed(lowest, SCORE_DP) : null,
    withdrawn: withdrawn.length,
    withdrawnByProgramSwitch: withdrawn.filter((r) => r.withdrawnByProgramSwitch).length,
    missingFromSheet: enrolled.filter((r) => !r.presentInSource).length,
  };
}

function gradeScaleInfo(bands: readonly BandRow[] | null): GradeScaleInfo {
  if (!bands) return { usable: false, levels: [] };
  const ordered = bands.toSorted((a, b) => b.minTotal.comparedTo(a.minTotal));
  return {
    usable: true,
    levels: GRADED_LEVELS.map((level) => ({
      level,
      letters: ordered.filter((b) => b.level === level).map((b) => b.letter.trim()),
    })),
  };
}

function lastSyncOf(term: TermRow): LastSyncInfo | null {
  const source = term.sources[0];
  if (!source) return null;
  const job = source.syncJobs[0] ?? null;
  return {
    sourceId: source.id,
    label: source.label,
    spreadsheetTitle: source.spreadsheetTitle,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    errorCount: job?.errorCount ?? 0,
    warningCount: job?.warningCount ?? 0,
  };
}

@Injectable()
export class SubjectStudentsService {
  private readonly logger = new Logger(SubjectStudentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One query: the term, its generation and grade scale, programs and classes, the active sheet
   * with its latest job, and every offering of the term (the release state needs them all).
   * 404 for no such term.
   */
  async loadTerm(generationId: string, termNumber: number): Promise<TermContext> {
    const term = await this.prisma.client.term.findUnique({
      where: { generationId_number: { generationId, number: termNumber } },
      select: {
        ...TERM_SELECT,
        offerings: { select: OFFERING_SELECT },
      },
    });
    if (!term) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Term not found' });

    const programs = term.programs.map((p) => p.program).toSorted(byCode);
    const codeById = new Map(programs.map((p) => [p.id, p.code]));
    const classes = term.programs
      .flatMap((p) => p.classes)
      .map((c) => ({ ...c, programCode: codeById.get(c.programId) ?? '' }))
      .toSorted(
        (a, b) =>
          a.programCode.localeCompare(b.programCode) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    // The results views log a missing scale as an error; here gradeScale.usable reports it, so
    // each admin request only notes it at debug level.
    const bands = bandsOf(term.generation, {
      error: (message: string) => this.logger.debug(message),
    });
    const { gradeScale: _scale, ...generation } = term.generation;
    return {
      generation,
      term: { id: term.id, number: term.number, name: term.name },
      programs,
      classes,
      bands,
      gradeScale: gradeScaleInfo(bands),
      lastSync: lastSyncOf(term),
      offerings: term.offerings,
    };
  }

  /**
   * Three batched queries for any number of offerings and students: enrollments (with the
   * student's ID and name), scores, and the term's student_terms. Rows are keyed by offering id.
   */
  async loadRows(
    ctx: TermContext,
    offerings: readonly OfferingRow[],
  ): Promise<Map<string, SubjectStudent[]>> {
    const byOffering = new Map<string, SubjectStudent[]>(offerings.map((o) => [o.id, []]));
    if (offerings.length === 0) return byOffering;
    const offeringIds = offerings.map((o) => o.id);
    const db = this.prisma.client;
    const [enrollments, scores, studentTerms] = await Promise.all([
      db.enrollment.findMany({
        where: { offeringId: { in: offeringIds } },
        select: {
          id: true,
          offeringId: true,
          studentId: true,
          status: true,
          endedReason: true,
          presentInSource: true,
          teacherComment: true,
          student: { select: { studentCode: true, fullName: true } },
        },
      }),
      // A mark erased in the sheet is not entered (D3), as in the results views.
      db.assessmentScore.findMany({
        // Through enrollments: assessment_scores has no index on offering_id.
        where: {
          enrollment: { offeringId: { in: offeringIds } },
          status: { in: ['RECORDED', 'ABSENT'] },
        },
        select: { enrollmentId: true, criterionId: true, status: true, mark: true },
      }),
      db.studentTerm.findMany({
        where: { termId: ctx.term.id },
        select: {
          studentId: true,
          program: { select: { id: true, code: true, name: true } },
          class: { select: { name: true } },
        },
      }),
    ]);

    type Score = { criterionId: string; status: 'RECORDED' | 'ABSENT'; mark: Prisma.Decimal };
    const scoresByEnrollment = new Map<string, Score[]>();
    for (const s of scores) {
      if (s.status === 'CLEARED') continue;
      const list = scoresByEnrollment.get(s.enrollmentId) ?? [];
      list.push({ criterionId: s.criterionId, status: s.status, mark: s.mark });
      scoresByEnrollment.set(s.enrollmentId, list);
    }
    const termOf = new Map(studentTerms.map((t) => [t.studentId, t]));
    const offeringById = new Map(offerings.map((o) => [o.id, o]));
    const passByLetter = new Map(ctx.bands?.map((b) => [b.letter.trim(), b.isPass]));

    for (const e of enrollments) {
      const offering = offeringById.get(e.offeringId);
      if (!offering) continue;
      const computed = computeCourse(
        { ...e, offering },
        ctx.term.number,
        scoresByEnrollment.get(e.id) ?? [],
        { admin: true, bands: ctx.bands },
      );
      const { status, finalGrade } = computed.view;
      const st = termOf.get(e.studentId);
      const withdrawn = e.status !== 'ENROLLED';
      byOffering.get(e.offeringId)?.push({
        enrollmentId: e.id,
        offeringId: e.offeringId,
        studentId: e.studentId,
        studentCode: e.student.studentCode,
        fullName: e.student.fullName,
        program: st?.program ?? null,
        className: st?.class.name ?? null,
        computed,
        level: levelFor(status, finalGrade, ctx.bands),
        passed: status === 'COMPLETE' && finalGrade ? (passByLetter.get(finalGrade) ?? null) : null,
        withdrawn,
        withdrawnByProgramSwitch: withdrawn && e.endedReason === 'PROGRAM_SWITCH',
        presentInSource: e.presentInSource,
        teacherComment: e.teacherComment,
      });
    }
    return byOffering;
  }
}
