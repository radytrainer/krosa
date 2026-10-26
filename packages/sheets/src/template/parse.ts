import { normalizeStudentId, validateScheme } from '@ssrs/shared';
import type { CellValue, Grid } from '../reader.js';
import {
  cellText,
  isBlank,
  parseBooleanCell,
  parseDecimalCell,
  parseGenderCell,
  parseIntegerCell,
  parseMarkCell,
} from './cells.js';
import {
  COURSE_CODE_PATTERN,
  COURSE_COLUMNS,
  COURSE_KEY_PATTERN,
  CRITERIA_COLUMNS,
  CRITERION_CATEGORIES,
  CRITERION_KEY_PATTERN,
  LIMITS,
  MARK_TAB_FIRST_DATA_ROW,
  MARK_TAB_PROFILE_COLUMNS,
  MARK_TAB_STUDENT_COLUMN,
  REQUIRED_TABS,
  STUDENT_COLUMNS,
  TAB,
  TEMPLATE_VERSION,
  type CriterionCategory,
  type Gender,
} from './constants.js';
import { IssueLog, rawValue } from './issues.js';

export interface ParsedMeta {
  templateVersion: number;
  generationCode: string;
}

export interface ParsedStudent {
  studentCode: string;
  fullName: string;
  gender: Gender;
  className: string | null;
  rowNumber: number;
}

export interface ParsedCriterion {
  key: string;
  name: string;
  category: CriterionCategory;
  maxMark: string;
  weight: string;
  order: number;
  description: string | null;
  rowNumber: number;
}

export interface ParsedMark {
  status: 'RECORDED' | 'ABSENT';
  mark: string;
}

export interface ParsedMarkRow {
  studentCode: string;
  rowNumber: number;
  /**
   * Keyed by upper-cased criterion key. 'BLANK' = empty cell (not entered). Criteria without a
   * column, or with an invalid cell, are absent: their stored values must not be touched.
   */
  marks: Map<string, ParsedMark | 'BLANK'>;
}

export interface CourseDefinition {
  courseKey: string;
  termNumber: number;
  courseCode: string;
  courseName: string;
  credits: string;
  /** Actual tab title (resolved case-insensitively). */
  worksheet: string;
  /** null when the `visible` cell is empty or unrecognized (treated as hidden). */
  visible: boolean | null;
  criteria: ParsedCriterion[];
  /** False when weights don't total 100: marks are imported, the scheme is not. */
  schemeValid: boolean;
  rowNumber: number;
}

export interface ParsedCourse extends CourseDefinition {
  rows: ParsedMarkRow[];
}

export interface StructureResult {
  fatal: boolean;
  meta: ParsedMeta | null;
  students: ParsedStudent[];
  /** Courses that passed validation (rejected ones are reported in the log). */
  courses: CourseDefinition[];
}

export const normalizeTitle = (title: string) => title.trim().toLowerCase();
const upper = (s: string) => s.toUpperCase();

function isBlankRow(row: readonly CellValue[] | undefined): boolean {
  return !row || row.every((c) => isBlank(c));
}

function checkSize(
  grid: Grid,
  tab: string,
  log: IssueLog,
  scope: 'FILE' | 'COURSE',
  courseKey?: string,
): boolean {
  const tooManyRows = grid.length > LIMITS.maxRowsPerTab;
  const tooManyCols = grid.some((r) => r.length > LIMITS.maxColumnsPerTab);
  if (tooManyRows || tooManyCols) {
    log.error(
      scope,
      'TAB_TOO_LARGE',
      `Tab "${tab}" exceeds ${LIMITS.maxRowsPerTab} rows or ${LIMITS.maxColumnsPerTab} columns.`,
      { sheetTab: tab, courseKey },
    );
    return false;
  }
  return true;
}

/** Maps header keys (row 1, case-insensitive) to column indexes for a fixed tab. */
function readHeader(
  grid: Grid,
  tab: string,
  columns: { required: readonly string[]; optional: readonly string[] },
  log: IssueLog,
): Map<string, number> | null {
  const header = grid[0] ?? [];
  const map = new Map<string, number>();
  const known = new Set([...columns.required, ...columns.optional]);
  header.forEach((cell, index) => {
    const key = cellText(cell)?.toLowerCase();
    if (!key) return;
    if (!known.has(key)) {
      log.warn(
        'IGNORED_COLUMN',
        `Column "${key}" in tab "${tab}" is not part of the template and is ignored.`,
        {
          sheetTab: tab,
          columnKey: key,
        },
      );
      return;
    }
    if (map.has(key)) {
      log.error(
        'FILE',
        'MISSING_COLUMN',
        `Column "${key}" appears more than once in tab "${tab}".`,
        {
          sheetTab: tab,
          columnKey: key,
        },
      );
      return;
    }
    map.set(key, index);
  });
  const missing = columns.required.filter((c) => !map.has(c));
  for (const column of missing) {
    log.error(
      'FILE',
      'MISSING_COLUMN',
      `Tab "${tab}" is missing the required column "${column}" in row 1.`,
      {
        sheetTab: tab,
        columnKey: column,
      },
    );
  }
  return missing.length === 0 ? map : null;
}

/** Iterates data rows (skipping blank ones) with 1-based sheet row numbers. */
function* dataRows(
  grid: Grid,
  firstDataRow: number,
): Generator<{ row: CellValue[]; rowNumber: number }> {
  for (let i = firstDataRow - 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (!isBlankRow(row)) yield { row, rowNumber: i + 1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Fixed tabs
// ---------------------------------------------------------------------------------------------

export function parseMeta(
  grid: Grid,
  expectedGenerationCode: string,
  log: IssueLog,
): ParsedMeta | null {
  const values = new Map<string, CellValue>();
  for (const row of grid) {
    const key = cellText(row[0])?.toLowerCase();
    if (key && key !== 'key') values.set(key, row[1] ?? null);
  }

  const version = parseIntegerCell(values.get('template_version'), 0, 1_000);
  if (version !== TEMPLATE_VERSION) {
    log.error(
      'FILE',
      'UNSUPPORTED_TEMPLATE_VERSION',
      `_meta.template_version must be ${TEMPLATE_VERSION}.`,
      { sheetTab: TAB.meta, rawValue: rawValue(values.get('template_version')) },
    );
  }
  const generationCode = cellText(values.get('generation_code'));
  if (!generationCode) {
    log.error('FILE', 'GENERATION_CODE_MISSING', '_meta.generation_code is empty.', {
      sheetTab: TAB.meta,
    });
  } else if (generationCode.toLowerCase() !== expectedGenerationCode.toLowerCase()) {
    log.error(
      'FILE',
      'GENERATION_MISMATCH',
      `This spreadsheet belongs to generation "${generationCode}", not "${expectedGenerationCode}".`,
      { sheetTab: TAB.meta, rawValue: rawValue(generationCode) },
    );
  }
  return version === TEMPLATE_VERSION && generationCode
    ? { templateVersion: version, generationCode }
    : null;
}

function parseStudents(grid: Grid, log: IssueLog): ParsedStudent[] {
  const tab = TAB.students;
  if (!checkSize(grid, tab, log, 'FILE')) return [];
  const header = readHeader(grid, tab, STUDENT_COLUMNS, log);
  if (!header) return [];
  const col = (row: CellValue[], key: string) => {
    const index = header.get(key);
    return index === undefined ? null : (row[index] ?? null);
  };

  const candidates: ParsedStudent[] = [];
  for (const { row, rowNumber } of dataRows(grid, 2)) {
    const rawId = col(row, 'student_id');
    const id = normalizeStudentId(rawId);
    if (!id.ok) {
      log.error(
        'ROW',
        'INVALID_STUDENT_ID',
        'Student ID is missing or not in the allowed format (letters, digits, - and _).',
        {
          sheetTab: tab,
          rowNumber,
          columnKey: 'student_id',
          rawValue: rawValue(rawId),
        },
      );
      continue;
    }
    const fullName = cellText(col(row, 'student_name'));
    if (!fullName) {
      log.error('ROW', 'MISSING_STUDENT_NAME', 'Student name is empty.', {
        sheetTab: tab,
        rowNumber,
        studentCode: id.value,
        columnKey: 'student_name',
      });
      continue;
    }
    const gender = parseGenderCell(col(row, 'gender'));
    if (!gender.recognized) {
      log.warn('UNKNOWN_GENDER', 'Unrecognized gender; stored as unspecified.', {
        sheetTab: tab,
        rowNumber,
        studentCode: id.value,
        columnKey: 'gender',
        rawValue: rawValue(col(row, 'gender')),
      });
    }
    candidates.push({
      studentCode: id.value,
      fullName,
      gender: gender.gender,
      className: cellText(col(row, 'class')),
      rowNumber,
    });
  }

  // Duplicates are ambiguous: reject every copy rather than guessing which row is right.
  const counts = new Map<string, number>();
  for (const s of candidates) counts.set(s.studentCode, (counts.get(s.studentCode) ?? 0) + 1);
  return candidates.filter((s) => {
    if ((counts.get(s.studentCode) ?? 0) === 1) return true;
    log.error(
      'ROW',
      'DUPLICATE_STUDENT',
      `Student ${s.studentCode} appears more than once in the roster; all copies are rejected.`,
      {
        sheetTab: tab,
        rowNumber: s.rowNumber,
        studentCode: s.studentCode,
      },
    );
    return false;
  });
}

interface CourseCandidate extends Omit<CourseDefinition, 'criteria' | 'schemeValid'> {
  keyUpper: string;
  /** False when the row itself failed validation (still counted for duplicate-key detection). */
  valid: boolean;
}

function parseCourses(
  grid: Grid,
  tabTitles: readonly string[],
  log: IssueLog,
): { courses: CourseCandidate[]; allKeys: Set<string> } {
  const tab = TAB.courses;
  const allKeys = new Set<string>();
  if (!checkSize(grid, tab, log, 'FILE')) return { courses: [], allKeys };
  const header = readHeader(grid, tab, COURSE_COLUMNS, log);
  if (!header) return { courses: [], allKeys };
  const col = (row: CellValue[], key: string) => {
    const index = header.get(key);
    return index === undefined ? null : (row[index] ?? null);
  };
  const titleByNormalized = new Map(tabTitles.map((t) => [normalizeTitle(t), t]));
  const reserved = new Set(REQUIRED_TABS.map(normalizeTitle));

  const candidates: CourseCandidate[] = [];
  for (const { row, rowNumber } of dataRows(grid, 2)) {
    const at = { sheetTab: tab, rowNumber };
    const courseKey = cellText(col(row, 'course_key'));
    if (!courseKey || !COURSE_KEY_PATTERN.test(courseKey)) {
      log.error(
        'COURSE',
        'INVALID_COURSE_KEY',
        'course_key must be 1-40 letters, digits, - or _.',
        {
          ...at,
          columnKey: 'course_key',
          rawValue: rawValue(col(row, 'course_key')),
        },
      );
      continue;
    }
    allKeys.add(upper(courseKey));
    const courseAt = { ...at, courseKey };
    let valid = true;

    const termNumber = parseIntegerCell(col(row, 'term'), 1, 5);
    if (termNumber === null) {
      log.error('COURSE', 'INVALID_TERM', 'term must be a whole number from 1 to 5.', {
        ...courseAt,
        columnKey: 'term',
        rawValue: rawValue(col(row, 'term')),
      });
      valid = false;
    }
    const courseCode = cellText(col(row, 'course_code'));
    if (!courseCode || !COURSE_CODE_PATTERN.test(courseCode)) {
      log.error(
        'COURSE',
        'INVALID_COURSE_CODE',
        'course_code must be 1-32 letters, digits, - or _.',
        {
          ...courseAt,
          columnKey: 'course_code',
          rawValue: rawValue(col(row, 'course_code')),
        },
      );
      valid = false;
    }
    const courseName = cellText(col(row, 'course_name'));
    if (!courseName) {
      log.error('COURSE', 'MISSING_COURSE_NAME', 'course_name is empty.', {
        ...courseAt,
        columnKey: 'course_name',
      });
      valid = false;
    }
    let credits = '1';
    if (!isBlank(col(row, 'credits'))) {
      const parsed = parseDecimalCell(col(row, 'credits'), {
        maxDecimals: 1,
        min: '0',
        minExclusive: true,
        max: '999.9',
      });
      if (parsed.ok) credits = parsed.value;
      else {
        log.error(
          'COURSE',
          'INVALID_CREDITS',
          'credits must be a positive number with at most one decimal place.',
          {
            ...courseAt,
            columnKey: 'credits',
            rawValue: rawValue(col(row, 'credits')),
          },
        );
        valid = false;
      }
    }
    const visible = parseBooleanCell(col(row, 'visible'));
    if (visible === undefined) {
      log.warn('INVALID_VISIBLE', 'visible must be TRUE or FALSE; the course stays hidden.', {
        ...courseAt,
        columnKey: 'visible',
        rawValue: rawValue(col(row, 'visible')),
      });
    }
    const worksheetName = cellText(col(row, 'worksheet'));
    const worksheet = worksheetName
      ? titleByNormalized.get(normalizeTitle(worksheetName))
      : undefined;
    if (!worksheetName || !worksheet || reserved.has(normalizeTitle(worksheetName))) {
      log.error(
        'COURSE',
        'WORKSHEET_NOT_FOUND',
        `Worksheet "${worksheetName ?? ''}" does not exist in this spreadsheet.`,
        {
          ...courseAt,
          columnKey: 'worksheet',
          rawValue: rawValue(worksheetName),
        },
      );
      valid = false;
    }

    candidates.push({
      courseKey,
      keyUpper: upper(courseKey),
      termNumber: termNumber ?? 0,
      courseCode: courseCode ?? '',
      courseName: courseName ?? '',
      credits,
      worksheet: worksheet ?? '',
      visible: visible ?? null,
      rowNumber,
      valid,
    });
  }

  // Only the course_key check counts invalid rows: a broken duplicate still makes the key ambiguous.
  const rejectDuplicates = (
    keyOf: (c: CourseCandidate) => string,
    code: 'DUPLICATE_COURSE' | 'DUPLICATE_WORKSHEET',
    describe: string,
  ) => {
    const counts = new Map<string, number>();
    for (const c of candidates) {
      const k = keyOf(c);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return (c: CourseCandidate) => {
      if ((counts.get(keyOf(c)) ?? 0) <= 1) return true;
      log.error('COURSE', code, `${describe}; every course involved is rejected.`, {
        sheetTab: tab,
        rowNumber: c.rowNumber,
        courseKey: c.courseKey,
      });
      return false;
    };
  };
  const uniqueKey = rejectDuplicates(
    (c) => upper(c.courseKey),
    'DUPLICATE_COURSE',
    'The same course_key is defined more than once',
  );
  const uniqueTermCourse = rejectDuplicates(
    (c) => (c.valid ? `${c.termNumber}:${upper(c.courseCode)}` : ''),
    'DUPLICATE_COURSE',
    'The same course_code appears twice in one term',
  );
  const uniqueWorksheet = rejectDuplicates(
    (c) => (c.valid ? normalizeTitle(c.worksheet) : ''),
    'DUPLICATE_WORKSHEET',
    'Several courses point to the same worksheet',
  );
  const courses = candidates.filter(
    (c) => c.valid && [uniqueKey(c), uniqueTermCourse(c), uniqueWorksheet(c)].every(Boolean),
  );
  if (courses.length > LIMITS.maxCourses) {
    log.error(
      'FILE',
      'TOO_MANY_COURSES',
      `A spreadsheet may define at most ${LIMITS.maxCourses} courses.`,
      { sheetTab: tab },
    );
  }
  return { courses, allKeys };
}

function parseCriteria(
  grid: Grid,
  courses: readonly CourseCandidate[],
  allCourseKeys: Set<string>,
  log: IssueLog,
): { byCourse: Map<string, ParsedCriterion[]>; rejectedCourses: Set<string> } {
  const tab = TAB.criteria;
  const byCourse = new Map<string, ParsedCriterion[]>();
  const rejectedCourses = new Set<string>();
  if (!checkSize(grid, tab, log, 'FILE')) return { byCourse, rejectedCourses };
  const header = readHeader(grid, tab, CRITERIA_COLUMNS, log);
  if (!header) return { byCourse, rejectedCourses };
  const col = (row: CellValue[], key: string) => {
    const index = header.get(key);
    return index === undefined ? null : (row[index] ?? null);
  };
  const validKeys = new Set(courses.map((c) => c.keyUpper));
  const rejectCourse = (courseKeyUpper: string) => rejectedCourses.add(courseKeyUpper);

  let sequence = 0;
  for (const { row, rowNumber } of dataRows(grid, 2)) {
    sequence++;
    const courseKey = cellText(col(row, 'course_key'));
    const keyUpper = courseKey ? upper(courseKey) : '';
    if (!courseKey || !allCourseKeys.has(keyUpper)) {
      log.error(
        'ROW',
        'UNKNOWN_COURSE',
        `course_key "${courseKey ?? ''}" is not defined in the Courses tab.`,
        {
          sheetTab: tab,
          rowNumber,
          columnKey: 'course_key',
          rawValue: rawValue(courseKey),
        },
      );
      continue;
    }
    if (!validKeys.has(keyUpper)) continue; // course already rejected and reported
    const at = { sheetTab: tab, rowNumber, courseKey };

    const key = cellText(col(row, 'criterion_key'));
    if (!key || !CRITERION_KEY_PATTERN.test(key)) {
      log.error(
        'COURSE',
        'INVALID_CRITERION_KEY',
        'criterion_key must start with a letter and contain up to 32 letters, digits or _.',
        {
          ...at,
          columnKey: 'criterion_key',
          rawValue: rawValue(key),
        },
      );
      rejectCourse(keyUpper);
      continue;
    }
    const criterionAt = { ...at, criterionKey: key };
    const name = cellText(col(row, 'criterion_name')) ?? key;
    const maxMark = parseDecimalCell(col(row, 'max_mark'), {
      maxDecimals: 3,
      min: '0',
      minExclusive: true,
      max: '99999.999',
    });
    if (!maxMark.ok) {
      log.error(
        'COURSE',
        'INVALID_MAX_MARK',
        'max_mark must be greater than 0 with at most 3 decimal places.',
        {
          ...criterionAt,
          columnKey: 'max_mark',
          rawValue: rawValue(col(row, 'max_mark')),
        },
      );
      rejectCourse(keyUpper);
    }
    const weight = parseDecimalCell(col(row, 'weight'), {
      maxDecimals: 3,
      min: '0',
      minExclusive: true,
      max: '100',
    });
    if (!weight.ok) {
      log.error(
        'COURSE',
        'INVALID_WEIGHT',
        'weight must be greater than 0 and at most 100, with at most 3 decimal places.',
        {
          ...criterionAt,
          columnKey: 'weight',
          rawValue: rawValue(col(row, 'weight')),
        },
      );
      rejectCourse(keyUpper);
    }
    let category: CriterionCategory = 'OTHER';
    const rawCategory = cellText(col(row, 'category'));
    if (rawCategory) {
      const match = CRITERION_CATEGORIES.find((c) => c === rawCategory.toUpperCase());
      if (match) category = match;
      else {
        log.warn('UNKNOWN_CATEGORY', 'Unknown category; OTHER is used.', {
          ...criterionAt,
          columnKey: 'category',
          rawValue: rawValue(rawCategory),
        });
      }
    }
    let order = sequence;
    if (!isBlank(col(row, 'order'))) {
      const parsedOrder = parseIntegerCell(col(row, 'order'), 0, 10_000);
      if (parsedOrder === null) {
        log.warn('INVALID_ORDER', 'order must be a whole number; row order is used.', {
          ...criterionAt,
          columnKey: 'order',
          rawValue: rawValue(col(row, 'order')),
        });
      } else order = parsedOrder;
    }
    if (!maxMark.ok || !weight.ok) continue;

    const list = byCourse.get(keyUpper) ?? [];
    list.push({
      key,
      name,
      category,
      maxMark: maxMark.value,
      weight: weight.value,
      order,
      description: cellText(col(row, 'description')),
      rowNumber,
    });
    byCourse.set(keyUpper, list);
  }

  for (const [courseKeyUpper, list] of byCourse) {
    const counts = new Map<string, number>();
    for (const c of list) counts.set(upper(c.key), (counts.get(upper(c.key)) ?? 0) + 1);
    for (const c of list) {
      if ((counts.get(upper(c.key)) ?? 0) > 1) {
        log.error(
          'COURSE',
          'DUPLICATE_CRITERION',
          `criterion_key "${c.key}" is defined more than once for this course.`,
          {
            sheetTab: tab,
            rowNumber: c.rowNumber,
            courseKey: courses.find((x) => x.keyUpper === courseKeyUpper)?.courseKey,
            criterionKey: c.key,
          },
        );
        rejectedCourses.add(courseKeyUpper);
      }
    }
  }
  return { byCourse, rejectedCourses };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export interface StructureInput {
  /** Grids of the four fixed tabs. */
  meta: Grid;
  students: Grid;
  courses: Grid;
  criteria: Grid;
  /** Titles of every tab in the spreadsheet (for resolving worksheet names). */
  tabTitles: readonly string[];
}

/** Parses _meta, Students, Courses and Criteria. FILE errors make the result fatal. */
export function parseStructure(
  input: StructureInput,
  expectedGenerationCode: string,
  log: IssueLog,
): StructureResult {
  const meta = parseMeta(input.meta, expectedGenerationCode, log);
  const students = parseStudents(input.students, log);
  const { courses: candidates, allKeys } = parseCourses(input.courses, input.tabTitles, log);
  const { byCourse, rejectedCourses } = parseCriteria(input.criteria, candidates, allKeys, log);

  const courses: CourseDefinition[] = [];
  for (const candidate of candidates) {
    if (rejectedCourses.has(candidate.keyUpper)) continue;
    const criteria = (byCourse.get(candidate.keyUpper) ?? []).toSorted(
      (a, b) => a.order - b.order || a.rowNumber - b.rowNumber,
    );
    if (criteria.length === 0) {
      log.error('COURSE', 'NO_CRITERIA', 'This course has no criteria in the Criteria tab.', {
        sheetTab: TAB.courses,
        rowNumber: candidate.rowNumber,
        courseKey: candidate.courseKey,
      });
      continue;
    }
    const scheme = validateScheme(
      criteria.map((c) => ({ criterionId: upper(c.key), maxMark: c.maxMark, weight: c.weight })),
    );
    const weightsOk = !scheme.issues.some((i) => i.code === 'WEIGHTS_NOT_100');
    if (!weightsOk) {
      log.error(
        'COURSE',
        'WEIGHTS_NOT_100',
        `Weights total ${scheme.totalWeight}%, not 100%. Marks are imported but the grading scheme is not.`,
        {
          sheetTab: TAB.criteria,
          courseKey: candidate.courseKey,
        },
      );
    }
    const { keyUpper: _keyUpper, valid: _valid, ...definition } = candidate;
    courses.push({ ...definition, criteria, schemeValid: weightsOk });
  }

  return { fatal: log.hasFileError, meta, students, courses };
}

/**
 * Parses one course's mark tab. Returns null when the tab's structure is invalid (the course is
 * skipped). Row and cell problems are logged and only affect those rows/cells.
 */
export function parseMarkTab(
  course: CourseDefinition,
  grid: Grid,
  roster: ReadonlyMap<string, ParsedStudent>,
  log: IssueLog,
): ParsedMarkRow[] | null {
  const tab = course.worksheet;
  const at = { sheetTab: tab, courseKey: course.courseKey };
  if (!checkSize(grid, tab, log, 'COURSE', course.courseKey)) return null;

  const criteriaByUpper = new Map(course.criteria.map((c) => [upper(c.key), c]));
  const profileColumns = new Set<string>(MARK_TAB_PROFILE_COLUMNS);
  let studentColumn: number | undefined;
  let nameColumn: number | undefined;
  const criterionColumns = new Map<string, number>();
  const seen = new Set<string>();
  let structural = false;

  (grid[0] ?? []).forEach((cell, index) => {
    const header = cellText(cell);
    if (!header) return; // staff notes columns without a key are allowed
    const lower = header.toLowerCase();
    if (seen.has(lower)) {
      log.error(
        'COURSE',
        'DUPLICATE_COLUMN',
        `Column key "${header}" appears more than once in row 1.`,
        { ...at, rowNumber: 1, columnKey: header },
      );
      structural = true;
      return;
    }
    seen.add(lower);
    if (lower === MARK_TAB_STUDENT_COLUMN) studentColumn = index;
    else if (profileColumns.has(lower)) {
      if (lower === 'student_name') nameColumn = index;
    } else if (criteriaByUpper.has(upper(header))) criterionColumns.set(upper(header), index);
    else {
      log.error(
        'COURSE',
        'UNKNOWN_COLUMN',
        `Column key "${header}" in row 1 is not a criterion of this course. Fix the key or add it to the Criteria tab.`,
        {
          ...at,
          rowNumber: 1,
          columnKey: header,
        },
      );
      structural = true;
    }
  });

  if (studentColumn === undefined) {
    log.error('COURSE', 'MISSING_STUDENT_ID_COLUMN', 'Row 1 must contain the key "student_id".', {
      ...at,
      rowNumber: 1,
    });
    structural = true;
  }
  if (structural || studentColumn === undefined) return null;

  for (const criterion of course.criteria) {
    if (!criterionColumns.has(upper(criterion.key))) {
      log.warn(
        'MISSING_CRITERION_COLUMN',
        `No column for criterion "${criterion.key}"; its marks are left unchanged.`,
        {
          ...at,
          rowNumber: 1,
          criterionKey: criterion.key,
        },
      );
    }
  }

  const candidates: { studentCode: string; rowNumber: number; row: CellValue[] }[] = [];
  for (const { row, rowNumber } of dataRows(grid, MARK_TAB_FIRST_DATA_ROW)) {
    const rawId = row[studentColumn] ?? null;
    const id = normalizeStudentId(rawId);
    if (!id.ok) {
      log.error(
        'ROW',
        'INVALID_STUDENT_ID',
        'Student ID is missing or not in the allowed format.',
        {
          ...at,
          rowNumber,
          columnKey: MARK_TAB_STUDENT_COLUMN,
          rawValue: rawValue(rawId),
        },
      );
      continue;
    }
    if (!roster.has(id.value)) {
      log.error(
        'ROW',
        'UNKNOWN_STUDENT',
        `Student ${id.value} is not in the Students tab (or was rejected there).`,
        {
          ...at,
          rowNumber,
          studentCode: id.value,
        },
      );
      continue;
    }
    candidates.push({ studentCode: id.value, rowNumber, row });
  }

  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.studentCode, (counts.get(c.studentCode) ?? 0) + 1);

  const rows: ParsedMarkRow[] = [];
  for (const candidate of candidates) {
    const rowAt = { ...at, rowNumber: candidate.rowNumber, studentCode: candidate.studentCode };
    if ((counts.get(candidate.studentCode) ?? 0) > 1) {
      log.error(
        'ROW',
        'DUPLICATE_ROW',
        `Student ${candidate.studentCode} appears more than once in this tab; all copies are rejected.`,
        rowAt,
      );
      continue;
    }
    if (nameColumn !== undefined) {
      const sheetName = cellText(candidate.row[nameColumn]);
      const rosterName = roster.get(candidate.studentCode)?.fullName;
      if (sheetName && rosterName && sheetName.toLowerCase() !== rosterName.toLowerCase()) {
        log.warn(
          'PROFILE_MISMATCH',
          `Name "${sheetName}" differs from the roster ("${rosterName}"); the roster is used.`,
          {
            ...rowAt,
            columnKey: 'student_name',
          },
        );
      }
    }
    const marks = new Map<string, ParsedMark | 'BLANK'>();
    for (const [keyUpper, columnIndex] of criterionColumns) {
      const criterion = criteriaByUpper.get(keyUpper);
      if (!criterion) continue;
      const value = candidate.row[columnIndex];
      const cell = parseMarkCell(value, criterion.maxMark);
      if (cell.kind === 'blank') marks.set(keyUpper, 'BLANK');
      else if (cell.kind === 'mark') marks.set(keyUpper, { status: cell.status, mark: cell.mark });
      else {
        log.error('CELL', 'INVALID_MARK', cell.message, {
          ...rowAt,
          columnKey: criterion.key,
          criterionKey: criterion.key,
          rawValue: rawValue(value),
        });
      }
    }
    rows.push({ studentCode: candidate.studentCode, rowNumber: candidate.rowNumber, marks });
  }
  return rows;
}
