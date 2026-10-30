import { normalizeStudentId } from '@ssrs/shared';
import type { Grid } from '../reader.js';
import { cellText, parseGenderCell } from '../template/cells.js';
import type { Gender } from '../template/constants.js';
import { rawValue, type IssueLog } from '../template/issues.js';
import { cleanLabel, roleFromLabel, type ColumnRole } from './labels.js';
import { findHeaderRow } from './layout.js';

export interface RosterStudent {
  studentCode: string;
  firstName: string | null;
  lastName: string | null;
  /** "FIRST LAST", or the single name column. */
  fullName: string;
  gender: Gender;
  className: string | null;
  rowNumber: number;
}

const PROFILE_ROLES: readonly ColumnRole[] = [
  'STUDENT_ID',
  'FIRST_NAME',
  'LAST_NAME',
  'FULL_NAME',
  'GENDER',
  'CLASS',
];

/**
 * Parses the master roster tab (`ALL` by default, decision D9). Only profile columns are read;
 * score columns in the roster tab are ignored. Problems are FILE scope when the tab is unusable
 * and ROW scope for individual students. Duplicate IDs reject every copy, as in template v1.
 */
export function parseRoster(grid: Grid, tab: string, log: IssueLog): RosterStudent[] | null {
  const headerIndex = findHeaderRow(grid);
  if (headerIndex < 0) {
    log.error('FILE', 'MISSING_COLUMN', `The roster tab "${tab}" has no "STUDENT ID" header.`, {
      sheetTab: tab,
    });
    return null;
  }
  const columns = new Map<ColumnRole, number>();
  (grid[headerIndex] ?? []).forEach((cell, index) => {
    const label = cellText(cell);
    if (label === null) return;
    const role = roleFromLabel(cleanLabel(label));
    if (PROFILE_ROLES.includes(role) && !columns.has(role)) columns.set(role, index);
  });
  const idIndex = columns.get('STUDENT_ID');
  const hasNames =
    columns.has('FULL_NAME') || (columns.has('FIRST_NAME') && columns.has('LAST_NAME'));
  if (idIndex === undefined || !hasNames) {
    log.error(
      'FILE',
      'MISSING_COLUMN',
      `The roster tab "${tab}" needs FIRST NAME and LAST NAME columns (or one NAME column).`,
      { sheetTab: tab, rowNumber: headerIndex + 1 },
    );
    return null;
  }

  const text = (row: Grid[number], role: ColumnRole) => {
    const index = columns.get(role);
    return index === undefined ? null : cellText(row[index]);
  };
  const students: RosterStudent[] = [];
  for (let r = headerIndex + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rowNumber = r + 1;
    const id = normalizeStudentId(row[idIndex] ?? null);
    const firstName = text(row, 'FIRST_NAME');
    const lastName = text(row, 'LAST_NAME');
    const singleName = text(row, 'FULL_NAME');
    if (!id.ok) {
      if (id.reason === 'EMPTY') {
        if (firstName || lastName || singleName) {
          log.error('ROW', 'MISSING_STUDENT_ID', `Row ${rowNumber} has a name but no student ID.`, {
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
        rawValue: rawValue(row[idIndex]),
      });
      continue;
    }
    const fullName = singleName ?? [firstName, lastName].filter(Boolean).join(' ');
    if (!fullName) {
      log.error('ROW', 'MISSING_STUDENT_NAME', `Student ${id.value} has no name.`, {
        sheetTab: tab,
        rowNumber,
        studentCode: id.value,
      });
      continue;
    }
    const genderIndex = columns.get('GENDER');
    const genderCell = genderIndex === undefined ? null : row[genderIndex];
    const gender = parseGenderCell(genderCell);
    if (!gender.recognized) {
      log.warn('UNKNOWN_GENDER', `Unrecognized gender for ${id.value}; stored as unspecified.`, {
        sheetTab: tab,
        rowNumber,
        studentCode: id.value,
        rawValue: rawValue(genderCell),
      });
    }
    students.push({
      studentCode: id.value,
      firstName,
      lastName,
      fullName,
      gender: gender.gender,
      className: text(row, 'CLASS'),
      rowNumber,
    });
  }

  const counts = new Map<string, number>();
  for (const s of students) counts.set(s.studentCode, (counts.get(s.studentCode) ?? 0) + 1);
  return students.filter((s) => {
    if (counts.get(s.studentCode) === 1) return true;
    log.error(
      'ROW',
      'DUPLICATE_STUDENT',
      `Student ID ${s.studentCode} appears more than once in "${tab}"; every copy is rejected.`,
      { sheetTab: tab, rowNumber: s.rowNumber, studentCode: s.studentCode },
    );
    return false;
  });
}
