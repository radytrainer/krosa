import { normalizeStudentId } from '@ssrs/shared';
import type { Grid } from '../reader.js';
import { cellText, isBlank, parseMarkCell } from '../template/cells.js';
import { rawValue, type IssueLog } from '../template/issues.js';
import type { ColumnRole } from './labels.js';
import { TERM_WORKBOOK_MAX_MARK } from './layout.js';
import type { RosterStudent } from './roster.js';
import type { ParsedMark, SubjectRow } from './types.js';

/** Matches the database constraint on enrollments.teacher_comment. */
const MAX_COMMENT_LENGTH = 4000;

/** Both names present and different (case-insensitive). */
const differs = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toUpperCase() !== b.toUpperCase();

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
    const sheetFirst = firstIndex === undefined ? null : cellText(cells[firstIndex]);
    const sheetLast = lastIndex === undefined ? null : cellText(cells[lastIndex]);
    if (differs(sheetFirst, student.firstName) || differs(sheetLast, student.lastName)) {
      log.warn(
        'PROFILE_MISMATCH',
        `Name in "${tab}" (${sheetFirst ?? ''} ${sheetLast ?? ''}) differs from the roster (${student.fullName}).`,
        { sheetTab: tab, rowNumber, studentCode },
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
    rows.push({
      studentCode,
      rowNumber,
      marks,
      comment:
        commentIndex === undefined
          ? null
          : (cellText(cells[commentIndex])?.slice(0, MAX_COMMENT_LENGTH) ?? null),
      sheetTotal: typeof total === 'number' && Number.isFinite(total) ? total : null,
    });
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
    return false;
  });
}
