/** Template contract (docs/google-sheets-template.md). */
export const TEMPLATE_VERSION = 1;

export const TAB = {
  meta: '_meta',
  students: 'Students',
  courses: 'Courses',
  criteria: 'Criteria',
} as const;

export const REQUIRED_TABS = [TAB.meta, TAB.students, TAB.courses, TAB.criteria] as const;

export const STUDENT_COLUMNS = {
  required: ['student_id', 'student_name'],
  optional: ['gender', 'class'],
} as const;

export const COURSE_COLUMNS = {
  required: ['course_key', 'term', 'course_code', 'course_name', 'worksheet'],
  optional: ['credits', 'visible'],
} as const;

export const CRITERIA_COLUMNS = {
  required: ['course_key', 'criterion_key', 'criterion_name', 'max_mark', 'weight'],
  optional: ['category', 'order', 'description'],
} as const;

/** Columns allowed in a course mark tab besides criterion keys. Profile columns are ignored. */
export const MARK_TAB_STUDENT_COLUMN = 'student_id';
export const MARK_TAB_PROFILE_COLUMNS = ['student_name', 'gender', 'class'] as const;
/** Row 1 holds machine keys, row 2 human labels, data starts at row 3. */
export const MARK_TAB_FIRST_DATA_ROW = 3;

export const COURSE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const COURSE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const CRITERION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

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
  maxCourses: 500,
  maxRawValueLength: 200,
} as const;
