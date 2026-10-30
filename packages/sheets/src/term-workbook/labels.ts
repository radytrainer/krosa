import type { CriterionCategory } from '../template/constants.js';

/**
 * Header-label rules for term workbooks: human labels such as "Quiz 1 10%", "Speaking (10%)",
 * "PARTICIPATION\n10%" or "Quiz 3- 10%" (docs/delivery-plan-2027.md B.1).
 */

/** Column roles a detected header can take. Mirrors the database enum `ColumnRole`. */
export type ColumnRole =
  | 'STUDENT_ID'
  | 'FIRST_NAME'
  | 'LAST_NAME'
  | 'FULL_NAME'
  | 'GENDER'
  | 'CLASS'
  | 'CRITERION'
  | 'REFERENCE_TOTAL'
  | 'COMMENT'
  | 'IGNORE';

/** Collapses whitespace (including line breaks inside a cell) and trims. Case is kept. */
export function cleanLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Comparison form: cleaned, upper case. */
export function normalizeLabel(text: string): string {
  return cleanLabel(text).toUpperCase();
}

// A trailing percentage, optionally in parentheses and after a separator: "x 10%", "x (10%)",
// "x - 10%", "x- 10%", "x: 10 %".
const TRAILING_WEIGHT = /^(.*?)[\s\-–—:(]*(\d{1,3}(?:\.\d{1,3})?)\s*%\s*\)?$/;

export interface LabelParts {
  /** Label without the weight, e.g. "Quiz 1". Empty when the label was only a weight. */
  name: string;
  /** Weight as a decimal string ("10", "7.5"), or null when the label has none. */
  weight: string | null;
}

export function parseLabelWeight(label: string): LabelParts {
  const clean = cleanLabel(label);
  const match = TRAILING_WEIGHT.exec(clean);
  if (!match) return { name: clean, weight: null };
  const weight = Number(match[2]);
  const name = (match[1] ?? '').replace(/[\s\-–—:(]+$/, '').trim();
  if (!(weight > 0 && weight <= 100)) return { name: clean, weight: null };
  return { name, weight: String(weight) };
}

const ROLE_SYNONYMS: [ColumnRole, readonly string[]][] = [
  ['STUDENT_ID', ['STUDENT ID', 'STUDENT_ID', 'STUDENTID', 'STUDENT CODE', 'ID']],
  ['FIRST_NAME', ['FIRST NAME', 'FIRSTNAME', 'FIRST_NAME', 'GIVEN NAME']],
  ['LAST_NAME', ['LAST NAME', 'LASTNAME', 'LAST_NAME', 'FAMILY NAME', 'SURNAME']],
  ['FULL_NAME', ['NAME', 'FULL NAME', 'STUDENT NAME', 'STUDENT_NAME']],
  ['GENDER', ['GENDER', 'SEX']],
  ['CLASS', ['CLASS', 'GROUP']],
  ['REFERENCE_TOTAL', ['TOTAL', 'TOTAL SCORE', 'FINAL TOTAL', 'FINAL SCORE']],
  ['COMMENT', ['COMMENT', 'COMMENTS', 'REMARK', 'REMARKS', 'FEEDBACK']],
];

/** Computed or bookkeeping columns that are never marks. */
const COMPUTED = [
  /^GRADE$/,
  /^GLOBAL GRADE$/,
  /^RANK$/,
  /^NO\.?$/,
  /^#$/,
  /^TOTAL \d+$/,
  /^AVERAGE\b/,
];

/** Role implied by the label alone; CRITERION when nothing else matches. */
export function roleFromLabel(label: string): ColumnRole {
  const normalized = normalizeLabel(label);
  for (const [role, synonyms] of ROLE_SYNONYMS) {
    if (synonyms.includes(normalized)) return role;
  }
  if (COMPUTED.some((re) => re.test(normalized))) return 'IGNORE';
  return 'CRITERION';
}

export function isStudentIdLabel(label: string): boolean {
  return roleFromLabel(label) === 'STUDENT_ID';
}

const CATEGORY_RULES: [CriterionCategory, RegExp][] = [
  ['PARTICIPATION', /PARTICIPATION|ATTENDANCE/],
  ['QUIZ', /QUIZ|^Q\d+$/],
  ['HOMEWORK', /HOMEWORK|^HW\s*\d*$/],
  ['EXAM', /MIDTERM|FINAL|EXAM/],
  ['PROJECT', /PROJECT|CAPSTONE/],
  ['PRESENTATION', /PRESENTATION|SPEAKING|ORAL|ROLE PLAY/],
];

function categoryOf(text: string | null): CriterionCategory | null {
  if (!text) return null;
  const normalized = normalizeLabel(text);
  return CATEGORY_RULES.find(([, re]) => re.test(normalized))?.[0] ?? null;
}

/** The group decides first ("FINAL (40%)" › Speaking is an exam part), then the column name. */
export function guessCategory(name: string, groupName: string | null): CriterionCategory {
  return categoryOf(groupName) ?? categoryOf(name) ?? 'OTHER';
}

/** Criterion key from a display name: "Quiz 1" → QUIZ_1, "MS WORD" → MS_WORD. */
export function keyFromName(name: string): string {
  let key = normalizeLabel(name)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key) key = 'CRITERION';
  if (!/^[A-Z]/.test(key)) key = `C_${key}`;
  return key.slice(0, 32).replace(/_+$/, '');
}
