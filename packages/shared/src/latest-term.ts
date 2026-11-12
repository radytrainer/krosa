import type { LatestTermHighestView, TermResultView } from './results.js';
import { topScoring } from './top-scoring.js';

/**
 * "Highest final score of the latest term" on the student summary (docs/decisions.md S1–S3).
 *
 * Pass the terms as the student sees them: released subjects and ENROLLED enrollments only.
 * The latest term is the highest term number with at least one such subject; there is no fallback
 * to an older term. Its highest score is that term's Top scoring (same helper, same rules: only
 * COMPLETE subjects, ties all returned in the term's order). Returns null when the student has no
 * released subject at all.
 */
export function latestTermHighest(
  terms: readonly Pick<TermResultView, 'number' | 'name' | 'courses'>[],
): LatestTermHighestView | null {
  const latest = terms
    .filter((t) => t.courses.length > 0)
    .toSorted((a, b) => b.number - a.number)[0];
  if (!latest) return null;
  const top = topScoring(latest.courses);
  return {
    termNumber: latest.number,
    termName: latest.name,
    finalScore: top?.finalScore ?? null,
    finalGrade: top?.finalGrade ?? null,
    subjects: top?.subjects ?? [],
  };
}
