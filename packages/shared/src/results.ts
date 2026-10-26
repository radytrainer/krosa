import type { CourseStatus, ScoreStatus, TermSummary } from './grading/grading.js';

/**
 * Response contract of the results API (docs/api-specification.md §3). Decimals are strings:
 * marks/max marks/weights with 3 decimals, contributions/scores/averages with 2.
 */
export interface StudentProfileView {
  id: string;
  studentCode: string;
  fullName: string;
  gender: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  className: string | null;
  generation: { id: string; code: string; name: string };
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
  attemptedWeight: string;
  earnedSoFar: string;
  /** Present in admin views only. */
  admin?: {
    visibility: 'HIDDEN' | 'VISIBLE';
    enrollmentStatus: 'ENROLLED' | 'WITHDRAWN';
    presentInSource: boolean;
  };
}

export interface TermResultView {
  number: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  summary: TermSummary;
  courses: CourseResultView[];
}

export interface StudentResultsView {
  student: StudentProfileView;
  terms: TermResultView[];
}

export interface StudentSummaryView {
  student: StudentProfileView;
  terms: { number: number; name: string; summary: TermSummary }[];
  /** Credit-weighted across all terms. */
  overall: TermSummary;
}

export interface StudentCourseListItem {
  offeringId: string;
  termNumber: number;
  courseCode: string;
  title: string;
  credits: string;
  status: CourseStatus;
  finalScore: string | null;
}
