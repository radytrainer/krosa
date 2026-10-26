import type { SheetsReader } from '../reader.js';
import { REQUIRED_TABS } from './constants.js';
import { IssueLog, type TemplateIssue } from './issues.js';
import {
  normalizeTitle,
  parseMarkTab,
  parseMeta,
  parseStructure,
  type ParsedCourse,
  type ParsedMeta,
  type ParsedStudent,
} from './parse.js';

export interface WorkbookStats {
  students: number;
  courses: number;
  coursesWithValidScheme: number;
  markRows: number;
  marks: number;
  blankMarks: number;
  errors: number;
  warnings: number;
}

export interface WorkbookReadResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  /** True when a FILE-level error means nothing from this source may be applied. */
  fatal: boolean;
  meta: ParsedMeta | null;
  students: ParsedStudent[];
  courses: ParsedCourse[];
  issues: TemplateIssue[];
  stats: WorkbookStats;
}

function computeStats(
  students: ParsedStudent[],
  courses: ParsedCourse[],
  issues: TemplateIssue[],
): WorkbookStats {
  let markRows = 0;
  let marks = 0;
  let blankMarks = 0;
  for (const course of courses) {
    markRows += course.rows.length;
    for (const row of course.rows) {
      for (const value of row.marks.values()) {
        if (value === 'BLANK') blankMarks++;
        else marks++;
      }
    }
  }
  return {
    students: students.length,
    courses: courses.length,
    coursesWithValidScheme: courses.filter((c) => c.schemeValid).length,
    markRows,
    marks,
    blankMarks,
    errors: issues.filter((i) => i.severity === 'ERROR').length,
    warnings: issues.filter((i) => i.severity === 'WARNING').length,
  };
}

export interface TemplateCheckResult {
  spreadsheetTitle: string;
  ok: boolean;
  issues: TemplateIssue[];
}

/**
 * Quick check used when a spreadsheet is registered: the service account can read it, the
 * template tabs exist, and `_meta` declares the expected generation (GS-03). Two requests.
 */
export async function checkTemplate(
  reader: SheetsReader,
  spreadsheetId: string,
  expectedGenerationCode: string,
): Promise<TemplateCheckResult> {
  const log = new IssueLog();
  const metadata = await reader.getMetadata(spreadsheetId);
  const byNormalized = new Map(metadata.tabs.map((t) => [normalizeTitle(t.title), t.title]));
  for (const name of REQUIRED_TABS) {
    if (!byNormalized.has(normalizeTitle(name))) {
      log.error('FILE', 'TEMPLATE_TAB_MISSING', `The required tab "${name}" is missing.`, {
        sheetTab: name,
      });
    }
  }
  const metaTitle = byNormalized.get(normalizeTitle(REQUIRED_TABS[0]));
  if (metaTitle) {
    const [grid] = await reader.readTabs(spreadsheetId, [metaTitle]);
    parseMeta(grid ?? [], expectedGenerationCode, log);
  }
  return { spreadsheetTitle: metadata.title, ok: !log.hasFileError, issues: log.items };
}

/**
 * Reads and validates a whole spreadsheet with two batched value requests (fixed tabs, then all
 * course tabs) plus one metadata request. Nothing is written anywhere; the caller decides what
 * to apply based on `fatal` and the issue scopes.
 */
export async function readWorkbook(
  reader: SheetsReader,
  spreadsheetId: string,
  expectedGenerationCode: string,
): Promise<WorkbookReadResult> {
  const log = new IssueLog();
  const metadata = await reader.getMetadata(spreadsheetId);
  const titles = metadata.tabs.map((t) => t.title);
  const byNormalized = new Map(titles.map((t) => [normalizeTitle(t), t]));

  const fixed = REQUIRED_TABS.map((name) => byNormalized.get(normalizeTitle(name)));
  REQUIRED_TABS.forEach((name, i) => {
    if (!fixed[i]) {
      log.error('FILE', 'TEMPLATE_TAB_MISSING', `The required tab "${name}" is missing.`, {
        sheetTab: name,
      });
    }
  });
  const result = (
    fatal: boolean,
    meta: ParsedMeta | null,
    students: ParsedStudent[],
    courses: ParsedCourse[],
  ) => ({
    spreadsheetId,
    spreadsheetTitle: metadata.title,
    fatal,
    meta,
    students,
    courses,
    issues: log.items,
    stats: computeStats(students, courses, log.items),
  });
  if (fixed.some((t) => !t)) return result(true, null, [], []);

  const [meta, students, courses, criteria] = await reader.readTabs(
    spreadsheetId,
    fixed as string[],
  );
  const structure = parseStructure(
    {
      meta: meta ?? [],
      students: students ?? [],
      courses: courses ?? [],
      criteria: criteria ?? [],
      tabTitles: titles,
    },
    expectedGenerationCode,
    log,
  );
  if (structure.fatal) return result(true, structure.meta, [], []);

  const referenced = new Set(
    [...REQUIRED_TABS, ...structure.courses.map((c) => c.worksheet)].map(normalizeTitle),
  );
  for (const title of titles) {
    if (!referenced.has(normalizeTitle(title))) {
      log.warn(
        'IGNORED_TAB',
        `Tab "${title}" is not referenced by the Courses tab and is ignored.`,
        { sheetTab: title },
      );
    }
  }

  const grids = await reader.readTabs(
    spreadsheetId,
    structure.courses.map((c) => c.worksheet),
  );
  const roster = new Map(structure.students.map((s) => [s.studentCode, s]));
  const parsedCourses: ParsedCourse[] = [];
  structure.courses.forEach((course, i) => {
    const rows = parseMarkTab(course, grids[i] ?? [], roster, log);
    if (rows) parsedCourses.push({ ...course, rows });
  });

  return result(false, structure.meta, structure.students, parsedCourses);
}
