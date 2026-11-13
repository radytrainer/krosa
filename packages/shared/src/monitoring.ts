import type { CourseStatus } from './grading/grading.js';
import type { GradedLevel, MonitoringLevel } from './grading/levels.js';

/**
 * Response contract of admin subject monitoring (docs/api-specification.md, Subject monitoring).
 * Admin only; read-only; never cached; viewing is not audited. Decimals are strings: marks, max
 * marks and weights with 3 decimals, totals with 2, percentages with 1.
 *
 * Counting rules (docs/decisions.md):
 * - `students` counts ENROLLED enrollments only. Withdrawn ones are listed, flagged, and counted
 *   only in `notes.withdrawn`.
 * - NEEDS_REVIEW and NOT_CONFIGURED results count as INCOMPLETE in `levels`, and also in
 *   `needsReview` so data problems can be found.
 * - Averages, highest, lowest and pass rate use COMPLETE results only. Pass = the band's is_pass.
 */

/** `GET /admin/monitoring/...` query values for the student table sort. */
export const MONITORING_STUDENT_SORTS = [
  'studentCode',
  'name',
  'program',
  'class',
  'total',
  'grade',
  'level',
] as const;
/** A sort key: one of MONITORING_STUDENT_SORTS, or `criterion:<criterionId>`. */
export type MonitoringStudentSort =
  | (typeof MONITORING_STUDENT_SORTS)[number]
  | `criterion:${string}`;

export const MONITORING_SUBJECT_SORTS = ['name', 'fail'] as const;
export type MonitoringSubjectSort = (typeof MONITORING_SUBJECT_SORTS)[number];

export type SortOrder = 'asc' | 'desc';

export const MONITORING_DEFAULT_PAGE_SIZE = 25;
export const MONITORING_MAX_PAGE_SIZE = 100;

export type MonitoringReleaseState = 'RELEASED' | 'HIDDEN' | 'PARTLY_RELEASED' | 'EMPTY';

export interface ProgramRef {
  id: string;
  code: string;
  name: string;
}

export interface GradeScaleInfo {
  /** false: no confirmed, usable scale → totals only, no grade or level, show a notice. */
  usable: boolean;
  /** Letters per level, read from grade_bands. For the legend only; empty when not usable. */
  levels: { level: GradedLevel; letters: string[] }[];
}

export interface LastSyncInfo {
  sourceId: string;
  label: string;
  spreadsheetTitle: string | null;
  /** null: the term has a sheet but was never synced. */
  lastSyncedAt: string | null;
  jobId: string | null;
  jobStatus: string | null;
  errorCount: number;
  warningCount: number;
}

export type LevelCounts = Record<MonitoringLevel, number>;

export interface SubjectAudience {
  /** SHARED: no offering_programs rows; `programs` then lists the term's programs. */
  kind: 'SHARED' | 'PROGRAM';
  programs: ProgramRef[];
}

export interface MonitoringGenerationRef {
  id: string;
  code: string;
  name: string;
}

export interface MonitoringTermRef {
  id: string;
  number: number;
  name: string;
  releaseState: MonitoringReleaseState;
  /** The term's configured programs (term_programs). */
  programs: ProgramRef[];
}

// GET /admin/monitoring/generations
export interface MonitoringGenerationOption extends MonitoringGenerationRef {
  status: 'ACTIVE' | 'ARCHIVED';
  terms: {
    id: string;
    number: number;
    name: string;
    subjects: number;
    releaseState: MonitoringReleaseState;
    lastSyncedAt: string | null;
  }[];
}

export interface MonitoringGenerationsView {
  data: MonitoringGenerationOption[];
}

// GET /admin/monitoring/terms/:generationId/:termNumber/subjects?includeArchived&sort
export interface MonitoringSubjectRef {
  /** The course id; the route's `subjectId`. */
  subjectId: string;
  offeringId: string;
  courseCode: string;
  title: string;
  audience: SubjectAudience;
  visibility: 'HIDDEN' | 'VISIBLE';
  archived: boolean;
  archivedAt: string | null;
  /** false: no published grading scheme (every result NOT_CONFIGURED). */
  configured: boolean;
}

export interface MonitoringSubjectRow extends MonitoringSubjectRef {
  /** ENROLLED students; equals the sum of `levels` (plus no-level COMPLETE when !usable). */
  students: number;
  complete: number;
  /** NEEDS_REVIEW + NOT_CONFIGURED; also inside levels.INCOMPLETE. */
  needsReview: number;
  /** Graded keys are 0 when !gradeScale.usable. */
  levels: LevelCounts;
  /** Percent of complete results whose band is a pass, 1 decimal; null with no complete result or no usable scale. */
  passRate: string | null;
}

export interface MonitoringTermSubjectsView {
  generation: MonitoringGenerationRef;
  term: MonitoringTermRef;
  gradeScale: GradeScaleInfo;
  lastSync: LastSyncInfo | null;
  subjects: MonitoringSubjectRow[];
}

export interface MonitoringCriterion {
  criterionId: string;
  key: string;
  name: string;
  order: number;
  maxMark: string;
  weight: string;
}

/** Query shared by the summary and students endpoints. */
export interface MonitoringSubjectQuery {
  generationId: string;
  termNumber: number;
  subjectId: string;
  /** Program code; omitted = all programs the subject is offered to. */
  program?: string;
  /** Class name from the term's class list. */
  className?: string;
  includeArchived?: boolean;
}

export interface MonitoringStudentsQuery extends MonitoringSubjectQuery {
  level?: MonitoringLevel;
  search?: string;
  sort?: MonitoringStudentSort;
  order?: SortOrder;
  page?: number;
  pageSize?: number;
}

// GET /admin/monitoring/subjects/summary?<MonitoringSubjectQuery>
export interface MonitoringSubjectSummaryView {
  generation: MonitoringGenerationRef;
  term: MonitoringTermRef;
  subject: MonitoringSubjectRef;
  filters: {
    /** false in a single-program term (Term 1): hide the Program filter. */
    programFilter: boolean;
    /** Only programs this subject is offered to. */
    programs: ProgramRef[];
    /** The term's class list; every class when no program is selected, labelled by program. */
    classes: { id: string; name: string; programCode: string }[];
  };
  gradeScale: GradeScaleInfo;
  criteria: MonitoringCriterion[];
  stats: {
    students: number;
    complete: number;
    incomplete: number;
    needsReview: number;
    /** null when !gradeScale.usable. Includes INCOMPLETE. Percent of `students`, 1 decimal. */
    levels: { level: MonitoringLevel; count: number; percent: string }[] | null;
    /** Complete results only; 2 decimals. Admin only: students never see averages. */
    averageTotal: string | null;
    highestTotal: string | null;
    lowestTotal: string | null;
    passRate: string | null;
  };
  notes: {
    /** Term-level count of open student_term_issues (not per subject). */
    termUndeterminedProgram: number;
    /** Open PROGRAM_SWITCH issues for students of this subject. */
    pendingProgramSwitch: number;
    /** Withdrawn enrollments (any reason), excluded from every count. */
    withdrawn: number;
    /** Of those, withdrawn by an approved program switch (marks kept, shown flagged). */
    withdrawnByProgramSwitch: number;
    /** ENROLLED but no longer in the sheet (presentInSource = false); counted, flagged. */
    missingFromSheet: number;
  };
  lastSync: LastSyncInfo | null;
}

export interface MonitoringMark {
  status: 'RECORDED' | 'ABSENT';
  mark: string;
}

export interface MonitoringStudentRow {
  studentId: string;
  studentCode: string;
  fullName: string;
  program: ProgramRef | null;
  className: string | null;
  /** By criterionId; null = not entered (shown as "-", never 0). CLEARED is null. */
  marks: Record<string, MonitoringMark | null>;
  status: CourseStatus;
  finalScore: string | null;
  finalGrade: string | null;
  level: MonitoringLevel | null;
  /** Plain text. Never render as HTML. */
  teacherComment: string | null;
  flags: {
    withdrawn: boolean;
    withdrawnByProgramSwitch: boolean;
    /** false: no longer in the sheet. */
    presentInSource: boolean;
    /** status is NEEDS_REVIEW or NOT_CONFIGURED. */
    needsReview: boolean;
  };
}

// GET /admin/monitoring/subjects/students?<MonitoringStudentsQuery>
export interface MonitoringStudentsPage {
  data: MonitoringStudentRow[];
  meta: { page: number; pageSize: number; total: number };
  criteria: MonitoringCriterion[];
}
