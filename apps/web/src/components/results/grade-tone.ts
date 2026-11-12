import { gradeTone, type GradeTone } from '@ssrs/shared';

/**
 * Colour classes for a final score and its grade (decisions.md G7): the project's own success,
 * warning and destructive (error) colours, unchanged. The rule (letter to tone) lives in
 * @ssrs/shared next to the scale; screens only ask for the classes of a letter and never name
 * letters themselves. No letter (no final score, no usable scale) gives no colour.
 */
const SCORE: Record<GradeTone, string> = {
  good: 'text-success',
  caution: 'text-warning',
  fail: 'text-destructive',
};

/**
 * The "Grade B" pill is outlined, not filled: any tint behind it would bring the error colour
 * below 4.5:1 in light mode, while on the card itself every tone stays above it.
 */
const PILL: Record<GradeTone, string> = {
  good: 'bg-transparent text-success ring-success/50',
  caution: 'bg-transparent text-warning ring-warning/50',
  fail: 'bg-transparent text-destructive ring-destructive/50',
};

/** Text colour for a final score (and a "(B+)" letter beside it). */
export function gradeScoreClass(letter: string | null | undefined): string | undefined {
  const tone = gradeTone(letter);
  return tone ? SCORE[tone] : undefined;
}

/** Tinted pill for the "Grade B+" letter. */
export function gradePillClass(letter: string | null | undefined): string | undefined {
  const tone = gradeTone(letter);
  return tone ? PILL[tone] : undefined;
}

/** `data-grade-tone` for tests and styling hooks; absent without a tone. */
export function gradeToneAttr(letter: string | null | undefined): GradeTone | undefined {
  return gradeTone(letter) ?? undefined;
}
