import type { CourseStatus } from './grading.js';

/**
 * Performance levels for admin subject monitoring (docs/decisions.md, Subject monitoring). The
 * letter-to-level mapping is configuration: each row of `grade_bands` carries its `level`, seeded
 * by migration 20261114090000_grade_levels. Code never names letters; it reads the bands.
 */
export type GradedLevel = 'VERY_GOOD' | 'GOOD' | 'FAIR' | 'FAIL';

/** INCOMPLETE is not a band: it is any subject result that is not COMPLETE. It is never FAIL. */
export type MonitoringLevel = GradedLevel | 'INCOMPLETE';

export const GRADED_LEVELS: readonly GradedLevel[] = ['VERY_GOOD', 'GOOD', 'FAIR', 'FAIL'];

export const MONITORING_LEVELS: readonly MonitoringLevel[] = [...GRADED_LEVELS, 'INCOMPLETE'];

export interface GradeBandLevelInput {
  letter: string;
  level: GradedLevel;
}

/**
 * The level of one subject result.
 * - Not COMPLETE (INCOMPLETE, NEEDS_REVIEW, NOT_CONFIGURED) → INCOMPLETE, whatever the letter.
 * - COMPLETE with a letter found in `bands` → that band's level.
 * - COMPLETE without a letter or without a matching band (no usable scale) → null: no level.
 */
export function levelFor(
  status: CourseStatus,
  letter: string | null,
  bands: readonly GradeBandLevelInput[] | null,
): MonitoringLevel | null {
  if (status !== 'COMPLETE') return 'INCOMPLETE';
  if (letter === null || !bands) return null;
  const wanted = letter.trim();
  return bands.find((b) => b.letter.trim() === wanted)?.level ?? null;
}
