import {
  formatFixed,
  GradeDecimal,
  SCORE_DP,
  toDecimal,
  tryDecimal,
  VALUE_DP,
  type DecimalInput,
} from './decimal.js';

/**
 * Grading engine (docs/requirements.md GRADE-01…09).
 *
 *   contribution = mark / maxMark × weight
 *   finalScore   = Σ contributions            (weights are percentages, so out of 100)
 *
 * Rules:
 *  - Arithmetic is decimal (no floating point). Contributions and the final score are computed
 *    exactly and rounded once, half-up, to 2 dp. The final score is the rounded exact sum, not the
 *    sum of rounded contributions.
 *  - A missing mark is never zero. A course is COMPLETE only when every criterion of the scheme
 *    has a mark; otherwise it is INCOMPLETE and has no final score.
 *  - ABSENT is an explicit zero.
 *  - A mark outside 0…maxMark (possible only through inconsistent data) puts the course in
 *    NEEDS_REVIEW, with no final score.
 */

export const WEIGHT_TOTAL = '100';
const MAX_WEIGHT = new GradeDecimal(100);
const MAX_MARK_LIMIT = new GradeDecimal('99999.999');

export interface SchemeItemInput {
  criterionId: string;
  maxMark: DecimalInput;
  weight: DecimalInput;
}

export type SchemeIssueCode =
  | 'EMPTY_SCHEME'
  | 'DUPLICATE_CRITERION'
  | 'INVALID_WEIGHT'
  | 'INVALID_MAX_MARK'
  | 'TOO_MANY_DECIMALS'
  | 'WEIGHTS_NOT_100';

export interface SchemeIssue {
  code: SchemeIssueCode;
  message: string;
  criterionId?: string;
}

export interface SchemeValidation {
  valid: boolean;
  /** Sum of valid weights, 3 dp. */
  totalWeight: string;
  issues: SchemeIssue[];
}

function decimalPlaces(value: GradeDecimal): number {
  return value.decimalPlaces();
}

/** Validates a grading scheme for publication. Drafts may be saved while invalid. */
export function validateScheme(items: readonly SchemeItemInput[]): SchemeValidation {
  const issues: SchemeIssue[] = [];
  if (items.length === 0) {
    issues.push({ code: 'EMPTY_SCHEME', message: 'The grading scheme has no criteria.' });
  }

  const seen = new Set<string>();
  let total = new GradeDecimal(0);
  for (const item of items) {
    if (seen.has(item.criterionId)) {
      issues.push({
        code: 'DUPLICATE_CRITERION',
        message: 'A criterion appears more than once.',
        criterionId: item.criterionId,
      });
    }
    seen.add(item.criterionId);

    const weight = tryDecimal(item.weight);
    if (!weight || weight.lte(0) || weight.gt(MAX_WEIGHT)) {
      issues.push({
        code: 'INVALID_WEIGHT',
        message: 'Weight must be greater than 0 and at most 100.',
        criterionId: item.criterionId,
      });
    } else if (decimalPlaces(weight) > VALUE_DP) {
      issues.push({
        code: 'TOO_MANY_DECIMALS',
        message: `Weight may have at most ${VALUE_DP} decimal places.`,
        criterionId: item.criterionId,
      });
    } else {
      total = total.plus(weight);
    }

    const maxMark = tryDecimal(item.maxMark);
    if (!maxMark || maxMark.lte(0) || maxMark.gt(MAX_MARK_LIMIT)) {
      issues.push({
        code: 'INVALID_MAX_MARK',
        message: 'Maximum mark must be greater than 0 and at most 99999.999.',
        criterionId: item.criterionId,
      });
    } else if (decimalPlaces(maxMark) > VALUE_DP) {
      issues.push({
        code: 'TOO_MANY_DECIMALS',
        message: `Maximum mark may have at most ${VALUE_DP} decimal places.`,
        criterionId: item.criterionId,
      });
    }
  }

  const itemsValid = issues.length === 0;
  if (items.length > 0 && itemsValid && !total.eq(WEIGHT_TOTAL)) {
    issues.push({
      code: 'WEIGHTS_NOT_100',
      message: `Weights total ${formatFixed(total, VALUE_DP)}%, but must total exactly 100%.`,
    });
  }
  return { valid: issues.length === 0, totalWeight: formatFixed(total, VALUE_DP), issues };
}

// ---------------------------------------------------------------------------------------------
// Course results
// ---------------------------------------------------------------------------------------------

export type ScoreStatus = 'RECORDED' | 'ABSENT';

export interface ScoreInput {
  criterionId: string;
  status: ScoreStatus;
  mark: DecimalInput;
}

export type CourseStatus = 'COMPLETE' | 'INCOMPLETE' | 'NEEDS_REVIEW' | 'NOT_CONFIGURED';

export interface CriterionResult {
  criterionId: string;
  maxMark: string;
  weight: string;
  score: { status: ScoreStatus; mark: string } | null;
  /** Rounded to 2 dp; null when no mark is recorded or the mark is invalid. */
  contribution: string | null;
  /** True when the stored mark lies outside 0…maxMark. */
  invalidMark: boolean;
}

export interface CourseResult {
  status: CourseStatus;
  criteria: CriterionResult[];
  /** Only for COMPLETE courses (2 dp). */
  finalScore: string | null;
  /** Sum of weights of criteria that have a valid mark (3 dp). */
  attemptedWeight: string;
  /** Sum of exact contributions so far, rounded (2 dp). */
  earnedSoFar: string;
  /** Exact final score for aggregation; null unless COMPLETE. Not for display. */
  finalScoreExact: GradeDecimal | null;
}

/**
 * Computes one course result from the PUBLISHED scheme's items and the student's scores.
 * Pass `scheme = null` when the offering has no published scheme. Scores for criteria that are
 * not in the scheme are ignored (they remain stored, e.g. for disabled criteria).
 */
export function computeCourseResult(
  scheme: readonly SchemeItemInput[] | null,
  scores: readonly ScoreInput[],
): CourseResult {
  if (!scheme || scheme.length === 0) {
    return {
      status: 'NOT_CONFIGURED',
      criteria: [],
      finalScore: null,
      attemptedWeight: formatFixed(new GradeDecimal(0), VALUE_DP),
      earnedSoFar: formatFixed(new GradeDecimal(0), SCORE_DP),
      finalScoreExact: null,
    };
  }

  const byCriterion = new Map(scores.map((s) => [s.criterionId, s]));
  let earned = new GradeDecimal(0);
  let attempted = new GradeDecimal(0);
  let missing = 0;
  let invalid = 0;

  const criteria = scheme.map((item): CriterionResult => {
    const maxMark = toDecimal(item.maxMark);
    const weight = toDecimal(item.weight);
    const score = byCriterion.get(item.criterionId);
    const base = {
      criterionId: item.criterionId,
      maxMark: formatFixed(maxMark, VALUE_DP),
      weight: formatFixed(weight, VALUE_DP),
    };
    if (!score) {
      missing++;
      return { ...base, score: null, contribution: null, invalidMark: false };
    }

    const mark = score.status === 'ABSENT' ? new GradeDecimal(0) : tryDecimal(score.mark);
    const shownScore = {
      status: score.status,
      mark: mark ? formatFixed(mark, VALUE_DP) : score.mark.toString(),
    };
    if (!mark || mark.lt(0) || mark.gt(maxMark)) {
      invalid++;
      return { ...base, score: shownScore, contribution: null, invalidMark: true };
    }

    const contribution = mark.div(maxMark).times(weight);
    earned = earned.plus(contribution);
    attempted = attempted.plus(weight);
    return {
      ...base,
      score: shownScore,
      contribution: formatFixed(contribution, SCORE_DP),
      invalidMark: false,
    };
  });

  const status: CourseStatus =
    invalid > 0 ? 'NEEDS_REVIEW' : missing > 0 ? 'INCOMPLETE' : 'COMPLETE';
  return {
    status,
    criteria,
    finalScore: status === 'COMPLETE' ? formatFixed(earned, SCORE_DP) : null,
    attemptedWeight: formatFixed(attempted, VALUE_DP),
    earnedSoFar: formatFixed(earned, SCORE_DP),
    finalScoreExact: status === 'COMPLETE' ? earned : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Term summary
// ---------------------------------------------------------------------------------------------

export interface TermCourseInput {
  credits: DecimalInput;
  result: Pick<CourseResult, 'status' | 'finalScoreExact'>;
}

export interface TermSummary {
  status: 'COMPLETE' | 'INCOMPLETE' | 'EMPTY';
  /** Credit-weighted mean of all courses; only when every course is COMPLETE (2 dp). */
  average: string | null;
  /** Credit-weighted mean of the COMPLETE courses so far (2 dp); null if none. */
  provisionalAverage: string | null;
  completedCourses: number;
  totalCourses: number;
  creditsCompleted: string;
  creditsTotal: string;
}

export function computeTermSummary(courses: readonly TermCourseInput[]): TermSummary {
  let weighted = new GradeDecimal(0);
  let creditsCompleted = new GradeDecimal(0);
  let creditsTotal = new GradeDecimal(0);
  let completed = 0;

  for (const course of courses) {
    const credits = toDecimal(course.credits);
    creditsTotal = creditsTotal.plus(credits);
    if (course.result.status === 'COMPLETE' && course.result.finalScoreExact) {
      completed++;
      creditsCompleted = creditsCompleted.plus(credits);
      weighted = weighted.plus(course.result.finalScoreExact.times(credits));
    }
  }

  const provisional = creditsCompleted.gt(0) ? weighted.div(creditsCompleted) : null;
  const allComplete = courses.length > 0 && completed === courses.length;
  return {
    status: courses.length === 0 ? 'EMPTY' : allComplete ? 'COMPLETE' : 'INCOMPLETE',
    average: allComplete && provisional ? formatFixed(provisional, SCORE_DP) : null,
    provisionalAverage: provisional ? formatFixed(provisional, SCORE_DP) : null,
    completedCourses: completed,
    totalCourses: courses.length,
    creditsCompleted: formatFixed(creditsCompleted, 1),
    creditsTotal: formatFixed(creditsTotal, 1),
  };
}
