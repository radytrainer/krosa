import { GradeDecimal, SCORE_DP, tryDecimal, type DecimalInput } from './decimal.js';

/**
 * Letter grades (docs/decisions.md G1–G4). A grade belongs only to a subject's final score: it is
 * never computed for a component mark, a partial figure or an average.
 */

export interface GradeBandInput {
  letter: string;
  /** The lowest final score that earns `letter` (inclusive). */
  minTotal: DecimalInput;
}

/**
 * The official scale. Minimum-score thresholds, so there are no gaps: 89.99 is B, 90.00 is A.
 * The database holds a copy per generation (`grade_bands`, migration 20261110090000_grade_scale);
 * this list is what that migration and new generations write.
 */
export const OFFICIAL_GRADE_BANDS: readonly {
  letter: string;
  minTotal: string;
  isPass: boolean;
}[] = [
  { letter: 'A', minTotal: '90', isPass: true },
  { letter: 'B', minTotal: '80', isPass: true },
  { letter: 'C', minTotal: '70', isPass: true },
  { letter: 'D', minTotal: '60', isPass: true },
  { letter: 'E', minTotal: '50', isPass: true },
  { letter: 'F', minTotal: '0', isPass: false },
];

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
 * scale. The comparison uses the score as displayed (2 decimals, half up), so a student never
 * sees a score and a letter that disagree: a raw 89.995 shows 90.00 and A; 89.99 shows B.
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
