import { GradeDecimal, SCORE_DP, tryDecimal, type DecimalInput } from './decimal.js';

/**
 * Letter grades (docs/decisions.md G2–G5). A grade belongs only to a subject's final score: it is
 * never computed for a component mark, a partial figure or an average.
 */

export interface GradeBandInput {
  letter: string;
  /** The lowest final score that earns `letter` (inclusive). */
  minTotal: DecimalInput;
}

/**
 * The official scale since 2026-11-12 (decisions.md G5; it supersedes G1). Minimum-score
 * thresholds, lower bound inclusive, so there are no gaps: 84.99 is B+, 85.00 is A. E (below 50)
 * is the only fail. The database holds a copy per generation (`grade_bands`, written
 * by migration 20261113090000_grade_scale_2026_11 and for every new generation); this list is the
 * same table.
 */
export const OFFICIAL_GRADE_BANDS: readonly {
  letter: string;
  minTotal: string;
  isPass: boolean;
  /** The colour of a final score with this letter (decisions.md G7). */
  tone: GradeTone;
}[] = [
  { letter: 'A', minTotal: '85', isPass: true, tone: 'good' },
  { letter: 'B+', minTotal: '80', isPass: true, tone: 'good' },
  { letter: 'B', minTotal: '70', isPass: true, tone: 'good' },
  { letter: 'C+', minTotal: '65', isPass: true, tone: 'good' },
  { letter: 'C', minTotal: '60', isPass: true, tone: 'caution' },
  { letter: 'D', minTotal: '50', isPass: true, tone: 'caution' },
  { letter: 'E', minTotal: '0', isPass: false, tone: 'fail' },
];

/**
 * How a final score and its letter are coloured (decisions.md G7): `good` green (A, B+, B, C+),
 * `caution` yellow (C, D), `fail` red (E). Screens colour by tone and never name letters; the
 * letter is always shown as text too, so colour is never the only signal. The API returns only the
 * letter.
 */
export type GradeTone = 'good' | 'caution' | 'fail';

const TONE_BY_LETTER = new Map(OFFICIAL_GRADE_BANDS.map((b) => [b.letter, b.tone]));

/** The tone of a grade letter, or null without one (no final score, no usable scale). */
export function gradeTone(letter: string | null | undefined): GradeTone | null {
  return (letter && TONE_BY_LETTER.get(letter)) || null;
}

/**
 * A usable scale has at least one band, a band starting at 0, thresholds within 0–100 and no
 * repeated letter or threshold. Anything else gives no grade at all, never a default letter.
 */
export function isUsableGradeScale(bands: readonly GradeBandInput[]): boolean {
  if (bands.length === 0) return false;
  const letters = new Set<string>();
  const mins = new Set<string>();
  let hasZero = false;
  for (const band of bands) {
    const min = tryDecimal(band.minTotal);
    const letter = band.letter.trim();
    if (!min || min.lt(0) || min.gt(100) || letter === '') return false;
    if (letters.has(letter) || mins.has(min.toFixed())) return false;
    letters.add(letter);
    mins.add(min.toFixed());
    if (min.eq(0)) hasZero = true;
  }
  return hasZero;
}

/**
 * The letter for a subject's final score, or null when there is no final score or no usable
 * scale (never a default letter). The comparison uses the score as displayed (2 decimals, half
 * up), so a student never sees a score and a letter that disagree: a raw 84.995 shows 85.00 and A;
 * 84.99 shows B+.
 */
export function gradeFor(
  bands: readonly GradeBandInput[] | null,
  finalScore: DecimalInput | null,
): string | null {
  if (finalScore === null || !bands || !isUsableGradeScale(bands)) return null;
  const parsed = tryDecimal(finalScore);
  if (!parsed) return null;
  const score = parsed.toDecimalPlaces(SCORE_DP, GradeDecimal.ROUND_HALF_UP);
  const ordered = bands
    .map((b) => ({ letter: b.letter.trim(), min: new GradeDecimal(b.minTotal.toString().trim()) }))
    .toSorted((a, b) => b.min.comparedTo(a.min));
  return ordered.find((b) => score.gte(b.min))?.letter ?? null;
}
