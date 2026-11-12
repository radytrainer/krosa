import type { CourseStatus, ScoreStatus, TermSummary } from './grading/grading.js';

/**
 * Response contract of the results API (docs/api-specification.md §3). Decimals are strings:
 * marks/max marks/weights with 3 decimals, contributions and scores with 2.
 */
export interface StudentProfileView {
  id: string;
  studentCode: string;
  fullName: string;
  gender: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  /** The latest term's class. */
  className: string | null;
  generation: { id: string; code: string; name: string };
  /** Program and class in each term the student was enrolled in, Term 1 first. */
  terms: StudentTermView[];
}

export interface StudentTermView {
  termNumber: number;
  termName: string;
  program: { code: string; name: string };
  className: string;
}

export interface CriterionResultView {
  criterionId: string;
  key: string;
  name: string;
  category: string;
  order: number;
  maxMark: string;
  weight: string;
  /** null = not entered yet (never shown as zero). */
  score: { status: ScoreStatus; mark: string } | null;
  contribution: string | null;
  invalidMark: boolean;
}

export interface CourseResultView {
  offeringId: string;
  termNumber: number;
  courseCode: string;
  title: string;
  credits: string;
  status: CourseStatus;
  /** Version of the published grading scheme used; null when not configured. */
  schemeVersion: number | null;
  criteria: CriterionResultView[];
  /** Only when status is COMPLETE. */
  finalScore: string | null;
  /**
   * Letter for `finalScore` (official scale, docs/decisions.md G2–G5). Only when status is
   * COMPLETE; null otherwise or when the generation has no usable scale. No other figure has one.
   */
  finalGrade: string | null;
  attemptedWeight: string;
  earnedSoFar: string;
  /** The teacher's comment from the sheet, as plain text. Never part of any calculation. */
  teacherComment: string | null;
  /** Present in admin views only. */
  admin?: {
    visibility: 'HIDDEN' | 'VISIBLE';
    enrollmentStatus: 'ENROLLED' | 'WITHDRAWN';
    /** PROGRAM_SWITCH: withdrawn because the student moved to a program without this subject. */
    endedReason: 'PROGRAM_SWITCH' | null;
    presentInSource: boolean;
  };
}

/**
 * A term's best result (decisions.md T1–T3): the highest final score among its COMPLETE subjects,
 * with every subject tied on that score. Null when the term has no COMPLETE subject yet.
 */
export interface TopScoringView {
  finalScore: string;
  /** Letter beside that final score (G3); null without a usable scale. The summary's only grade. */
  finalGrade: string | null;
  /** Every subject with that score (ties), in the term's order. */
  subjects: TopScoringSubject[];
}

export interface TopScoringSubject {
  offeringId: string;
  courseCode: string;
  title: string;
  /** Admin views only: true when the subject is hidden from the student. */
  hiddenFromStudent?: boolean;
}

/** One term's summary: how many courses are complete, and its Top scoring subject. */
export interface TermSummaryView extends TermSummary {
  topScoring: TopScoringView | null;
}

export interface TermResultView {
  number: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  summary: TermSummaryView;
  courses: CourseResultView[];
}

export interface StudentResultsView {
  student: StudentProfileView;
  terms: TermResultView[];
}

export interface StudentSummaryView {
  student: StudentProfileView;
  terms: { number: number; name: string; summary: TermSummaryView }[];
  /** Courses complete across all terms. */
  overall: TermSummary;
  /** Null when the student has no released subject. See latestTermHighest. */
  latestTermHighest: LatestTermHighestView | null;
}

/**
 * The highest final score in the latest term with a released subject (decisions.md S1–S3): that
 * term's Top scoring, from the same helper (topScoring). `finalScore` is null when that term has
 * no COMPLETE subject yet; then `subjects` is empty.
 */
export interface LatestTermHighestView {
  termNumber: number;
  termName: string;
  finalScore: string | null;
  /** Letter beside that final score (G3); null without a final score or a usable scale. */
  finalGrade: string | null;
  /** Every subject with that score (ties), in the term's order. */
  subjects: { offeringId: string; courseCode: string; title: string }[];
}

export interface StudentCourseListItem {
  offeringId: string;
  termNumber: number;
  courseCode: string;
  title: string;
  credits: string;
  status: CourseStatus;
  finalScore: string | null;
  /** Same rule as CourseResultView.finalGrade. */
  finalGrade: string | null;
}
