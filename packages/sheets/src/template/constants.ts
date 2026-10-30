/** Limits and vocabulary shared by the term-workbook parser. */
export const CRITERION_CATEGORIES = [
  'QUIZ',
  'EXAM',
  'HOMEWORK',
  'ASSIGNMENT',
  'PROJECT',
  'PRESENTATION',
  'PARTICIPATION',
  'OTHER',
] as const;
export type CriterionCategory = (typeof CRITERION_CATEGORIES)[number];

export type Gender = 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';

/** Safety limits to keep a malformed or huge file from exhausting memory. */
export const LIMITS = {
  maxRowsPerTab: 20_000,
  maxColumnsPerTab: 300,
  maxRawValueLength: 200,
} as const;
