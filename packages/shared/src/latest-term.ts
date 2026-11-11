import { GradeDecimal } from './grading/decimal.js';
import type { LatestTermHighestView, TermResultView } from './results.js';

/**
 * "Highest final score of the latest term" on the student summary (docs/decisions.md S1–S3).
 *
 * Pass the terms as the student sees them: released subjects and ENROLLED enrollments only.
 * The latest term is the highest term number with at least one such subject; there is no fallback
 * to an older term. Only COMPLETE subjects count; subjects tied on the displayed score are all
 * returned, in the term's order. Returns null when the student has no released subject at all.
 */
export function latestTermHighest(
  terms: readonly Pick<TermResultView, 'number' | 'name' | 'courses'>[],
): LatestTermHighestView | null {
  const latest = terms
    .filter((t) => t.courses.length > 0)
    .toSorted((a, b) => b.number - a.number)[0];
  if (!latest) return null;

  let best: { score: GradeDecimal; finalScore: string; finalGrade: string | null } | null = null;
  let subjects: LatestTermHighestView['subjects'] = [];
  for (const course of latest.courses) {
    if (course.status !== 'COMPLETE' || course.finalScore === null) continue;
    const score = new GradeDecimal(course.finalScore);
    const subject = {
      offeringId: course.offeringId,
      courseCode: course.courseCode,
      title: course.title,
    };
    if (best === null || score.gt(best.score)) {
      best = { score, finalScore: course.finalScore, finalGrade: course.finalGrade };
      subjects = [subject];
    } else if (score.eq(best.score)) {
      subjects.push(subject);
    }
  }
  return {
    termNumber: latest.number,
    termName: latest.name,
    finalScore: best?.finalScore ?? null,
    finalGrade: best?.finalGrade ?? null,
    subjects,
  };
}
