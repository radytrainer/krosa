import type { GradeScaleInfo, MonitoringLevel } from '@ssrs/shared';

/**
 * The only place that names performance levels on screen. Letters are never named here: which
 * letters belong to a level comes from the API (`gradeScale.levels`, read from grade_bands).
 */
export const LEVEL_LABEL: Record<MonitoringLevel, string> = {
  VERY_GOOD: 'Very good',
  GOOD: 'Good',
  FAIR: 'Fair',
  FAIL: 'Fail',
  INCOMPLETE: 'Incomplete',
};

export function levelLabel(level: MonitoringLevel | null | undefined): string {
  return level ? LEVEL_LABEL[level] : '-';
}

/** "A, B+" for a graded level, from the API's scale; empty for Incomplete or no usable scale. */
export function levelLetters(scale: GradeScaleInfo, level: MonitoringLevel): string {
  if (!scale.usable || level === 'INCOMPLETE') return '';
  return scale.levels.find((l) => l.level === level)?.letters.join(', ') ?? '';
}
