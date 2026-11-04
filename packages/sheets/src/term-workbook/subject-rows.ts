import { normalizeStudentId } from '@ssrs/shared';
import type { Grid } from '../reader.js';
import { cellText, isBlank, parseMarkCell } from '../template/cells.js';
import { rawValue, type IssueLog } from '../template/issues.js';
import type { ColumnRole } from './labels.js';
import { TERM_WORKBOOK_MAX_MARK } from './layout.js';
import type { RosterStudent } from './roster.js';
import type { ParsedMark, SubjectRow } from './types.js';

/** Matches the database constraint on enrollments.teacher_comment, in characters (code points). */
export const MAX_COMMENT_LENGTH = 4000;

/**
 * A comment cell as text. Blank or whitespace only (zero-width spaces included) is null, which
 * clears the stored comment. NUL is dropped: PostgreSQL text cannot hold it.
 */
function commentText(value: Grid[number][number] | undefined): string | null {
  const text = cellText(value)
    ?.replace(/\0/g, '')
    .replace(/^[\s\u200B]+|[\s\u200B]+$/g, '');
  return text ? text : null;
}

/** More than this share of a tab's rows naming another student blocks the whole tab. */
export const IDENTITY_MISMATCH_SHARE = 0.2;

/**
 * A name as a comparison key: upper case, words sorted, so case, extra spaces and first/last
 * order do not matter ("SOK  Dara" = "DARA SOK"). Null when there is no name.
 */
export function nameKey(...parts: (string | null)[]): string | null {
  const words = parts.join(' ').toUpperCase().split(/\s+/).filter(Boolean).toSorted();
  return words.length ? words.join(' ') : null;
}

const sameText = (a: string | null, b: string | null) =>
  (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();

/** A cell's text by column index; null for a column the tab does not have. */
const text = (cells: Grid[number], index: number | undefined) =>
  index === undefined ? null : cellText(cells[index]);

/** Roster students by name key, to tell a misspelt name from another student's name. */
function namesIndex(roster: ReadonlyMap<string, RosterStudent>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const s of roster.values()) {
    for (const key of new Set([nameKey(s.firstName, s.lastName), nameKey(s.fullName)])) {
      if (key) index.set(key, [...(index.get(key) ?? []), s.studentCode]);
    }
  }
  return index;
}

/** A confirmed tab mapping as stored in sheet_tab_mappings / sheet_column_mappings. */
export interface SubjectTabMapping {
  tabName: string;
  /** 1-based leaf header row. */
  headerRow: number;
  columns: { columnIndex: number; role: ColumnRole; criterionKey?: string | null }[];
}

/**
 * Reads the student rows of one subject tab with its confirmed mapping. Rows are checked
 * against the roster (decision D9): unknown students are rejected, name differences warned.
 * Returns null when the mapping cannot be applied (no student ID column).
 */
export function parseSubjectRows(
  grid: Grid,
  mapping: SubjectTabMapping,
  roster: ReadonlyMap<string, RosterStudent>,
  log: IssueLog,
  /** Collects the students rejected for appearing more than once. */
  duplicates?: Set<string>,
): SubjectRow[] | null {
  const tab = mapping.tabName;
  const column = (role: ColumnRole) => mapping.columns.find((c) => c.role === role)?.columnIndex;
  const idIndex = column('STUDENT_ID');
  if (idIndex === undefined) {
    log.error('COURSE', 'MISSING_STUDENT_ID_COLUMN', `Tab "${tab}" has no student ID column.`, {
      sheetTab: tab,
    });
    return null;
  }
  const criteria = mapping.columns.flatMap((c) =>
    c.role === 'CRITERION' && c.criterionKey
      ? [{ columnIndex: c.columnIndex, key: c.criterionKey }]
      : [],
  );
  const commentIndex = column('COMMENT');
  const totalIndex = column('REFERENCE_TOTAL');
  const firstIndex = column('FIRST_NAME');
  const lastIndex = column('LAST_NAME');
  const fullIndex = column('FULL_NAME');
  const classIndex = column('CLASS');
  const programIndex = column('PROGRAM');
  const names = namesIndex(roster);
  /** Rows naming another student: reported once it is known whether the whole tab is blocked. */
  const identity: { rowNumber: number; studentCode: string; others: string[] }[] = [];
  let known = 0;

  const rows: SubjectRow[] = [];
  for (let r = mapping.headerRow; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const rowNumber = r + 1;
    const id = normalizeStudentId(cells[idIndex] ?? null);
    if (!id.ok) {
      const hasMarks = criteria.some((c) => !isBlank(cells[c.columnIndex]));
      if (id.reason === 'EMPTY') {
        if (hasMarks) {
          log.error('ROW', 'MISSING_STUDENT_ID', `Row ${rowNumber} has marks but no student ID.`, {
            sheetTab: tab,
            rowNumber,
          });
        }
        continue;
      }
      log.error('ROW', 'INVALID_STUDENT_ID', `Invalid student ID in row ${rowNumber}.`, {
        sheetTab: tab,
        rowNumber,
        columnKey: 'STUDENT ID',
        rawValue: rawValue(cells[idIndex]),
      });
      continue;
    }
    const studentCode = id.value;
    const student = roster.get(studentCode);
    if (!student) {
      log.error(
        'ROW',
        'UNKNOWN_STUDENT',
        `Student ${studentCode} is not in the roster tab; add them there first.`,
        { sheetTab: tab, rowNumber, studentCode },
      );
      continue;
    }
    known++;
    // Names: the roster decides. A swapped first and last name is the same name.
    const full = text(cells, fullIndex);
    const first = text(cells, firstIndex);
    const last = text(cells, lastIndex);
    // A whole name (one column, or first and last) is checked against every roster name; a lone
    // first or last name only against this student's own two names.
    const whole = full ? nameKey(full) : first && last ? nameKey(first, last) : null;
    const part = whole ? null : nameKey(first ?? last);
    const own = new Set([nameKey(student.firstName, student.lastName), nameKey(student.fullName)]);
    const parts = new Set([nameKey(student.firstName), nameKey(student.lastName)]);
    if ((whole && !own.has(whole)) || (part && !parts.has(part))) {
      const others = whole ? (names.get(whole) ?? []).filter((c) => c !== studentCode) : [];
      if (others.length > 0) {
        // Never import marks under an ID whose name belongs to someone else.
        identity.push({ rowNumber, studentCode, others });
        continue;
      }
      log.warn(
        'PROFILE_MISMATCH',
        `Name in "${tab}" row ${rowNumber} does not match the roster for ${studentCode}; the roster's name is used.`,
        { sheetTab: tab, rowNumber, studentCode },
      );
    }
    const sheetClass = text(cells, classIndex);
    if (sheetClass && !sameText(sheetClass, student.className)) {
      log.warn(
        'PROFILE_MISMATCH',
        `Class in "${tab}" (${sheetClass}) differs from the roster (${student.className ?? 'none'}) for ${studentCode}; the roster's class is used.`,
        { sheetTab: tab, rowNumber, studentCode, columnKey: 'CLASS', rawValue: sheetClass },
      );
    }

    const marks = new Map<string, ParsedMark | 'BLANK'>();
    for (const criterion of criteria) {
      const value = cells[criterion.columnIndex];
      const parsed = parseMarkCell(value, TERM_WORKBOOK_MAX_MARK);
      const key = criterion.key.toUpperCase();
      if (parsed.kind === 'blank') marks.set(key, 'BLANK');
      else if (parsed.kind === 'mark') marks.set(key, { status: parsed.status, mark: parsed.mark });
      else {
        log.error('CELL', 'INVALID_MARK', parsed.message, {
          sheetTab: tab,
          rowNumber,
          studentCode,
          criterionKey: criterion.key,
          rawValue: rawValue(value),
        });
      }
    }
    const total = totalIndex === undefined ? undefined : cells[totalIndex];
    let comment = commentIndex === undefined ? null : commentText(cells[commentIndex]);
    let commentRejected = false;
    const commentLength = comment === null ? 0 : [...comment].length;
    if (commentLength > MAX_COMMENT_LENGTH) {
      log.warn(
        'COMMENT_TOO_LONG',
        `The comment in "${tab}" row ${rowNumber} is ${commentLength} characters, over the ` +
          `${MAX_COMMENT_LENGTH} limit. It was not imported; the previous comment is kept.`,
        { sheetTab: tab, rowNumber, studentCode, columnKey: 'COMMENTS' },
      );
      comment = null;
      commentRejected = true;
    }
    rows.push({
      studentCode,
      rowNumber,
      marks,
      comment,
      commentRejected,
      programText: text(cells, programIndex),
      sheetTotal: typeof total === 'number' && Number.isFinite(total) ? total : null,
    });
  }

  if (known > 0 && identity.length / known > IDENTITY_MISMATCH_SHARE) {
    const examples = identity
      .slice(0, 3)
      .map((i) => `row ${i.rowNumber}: ${i.studentCode} has the name of ${i.others.join('/')}`);
    log.error(
      'COURSE',
      'IDENTITY_MISMATCH_TAB',
      `${identity.length} of ${known} rows in "${tab}" carry another student's name under their ID ` +
        `(${examples.join('; ')}). The IDs and names look shifted; nothing from this tab was imported.`,
      { sheetTab: tab },
    );
    return null;
  }
  for (const i of identity) {
    log.error(
      'ROW',
      'IDENTITY_MISMATCH',
      `Row ${i.rowNumber} in "${tab}" has ID ${i.studentCode} but the name of ${i.others.join('/')} in the roster. The row was not imported.`,
      { sheetTab: tab, rowNumber: i.rowNumber, studentCode: i.studentCode },
    );
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.studentCode, (counts.get(row.studentCode) ?? 0) + 1);
  return rows.filter((row) => {
    if (counts.get(row.studentCode) === 1) return true;
    log.error(
      'ROW',
      'DUPLICATE_ROW',
      `Student ${row.studentCode} appears more than once in "${tab}"; every copy is rejected.`,
      { sheetTab: tab, rowNumber: row.rowNumber, studentCode: row.studentCode },
    );
    duplicates?.add(row.studentCode);
    return false;
  });
}
