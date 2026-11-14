import { GradeDecimal } from './grading/decimal.js';
import type { CourseResultView, TopScoringSubject, TopScoringView } from './results.js';

/**
 * A term's Top scoring (docs/decisions.md T1–T3), the one rule behind every "highest final score"
 * shown: the per-term summary and the dashboard's latest term (latestTermHighest).
 *
 *  - Only COMPLETE subjects with a final score count; INCOMPLETE, NEEDS_REVIEW and NOT_CONFIGURED
 *    never do, whatever they have so far.
 *  - Scores compare as displayed (2 decimals), so the score, its grade and the ties always agree.
 *  - Ties: every subject on that score, in the order given.
 *  - Withdrawn enrollments (admin views) never count, like Courses complete.
 *  - Pass what the viewer sees: a student's released subjects only. In admin views hidden subjects
 *    count and are marked `hiddenFromStudent`.
 *
 * Returns null when no subject counts ("No final score yet", never a zero).
 */
export function topScoring(
  courses: readonly Pick<
    CourseResultView,
    'offeringId' | 'courseCode' | 'title' | 'status' | 'finalScore' | 'finalGrade' | 'admin'
  >[],
): TopScoringView | null {
  let best: { score: GradeDecimal; finalScore: string; finalGrade: string | null } | null = null;
  let subjects: TopScoringSubject[] = [];
  for (const course of courses) {
    if (course.admin?.enrollmentStatus === 'WITHDRAWN') continue;
    if (course.status !== 'COMPLETE' || course.finalScore === null) continue;
    const score = new GradeDecimal(course.finalScore);
    const subject: TopScoringSubject = {
      offeringId: course.offeringId,
      courseCode: course.courseCode,
      title: course.title,
      ...(course.admin ? { hiddenFromStudent: course.admin.visibility === 'HIDDEN' } : {}),
    };
    if (best === null || score.gt(best.score)) {
      best = { score, finalScore: course.finalScore, finalGrade: course.finalGrade };
      subjects = [subject];
    } else if (score.eq(best.score)) {
      subjects.push(subject);
    }
  }
  return best ? { finalScore: best.finalScore, finalGrade: best.finalGrade, subjects } : null;
}
