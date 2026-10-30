import { createHash } from 'node:crypto';
import { normalizeStudentId } from '@ssrs/shared';
import type { CellValue, Grid } from '../reader.js';
import { cellText, parseMarkCell } from '../template/cells.js';
import type { CriterionCategory } from '../template/constants.js';
import type { IssueLog } from '../template/issues.js';
import {
  cleanLabel,
  guessCategory,
  isStudentIdLabel,
  keyFromName,
  parseLabelWeight,
  roleFromLabel,
  type ColumnRole,
} from './labels.js';

/** The header row is searched for in the first rows only. */
export const HEADER_SEARCH_ROWS = 10;
/** Every criterion in a term workbook is a mark out of 100 (delivery plan A3). */
export const TERM_WORKBOOK_MAX_MARK = '100';
/** Sheet total vs computed total differences above this are mismatches. */
const TOTAL_TOLERANCE = 0.5;
/** More than this share of mismatching rows raises WEIGHTS_DISAGREE_WITH_SHEET_TOTAL. */
const MISMATCH_SHARE = 0.05;
/** A text column (no marks) whose non-blank cells are mostly non-numeric is not a criterion. */
const TEXT_SHARE = 0.5;

export interface DetectedGroup {
  /** 1-based row of the group label. */
  rowNumber: number;
  label: string;
  name: string;
  weight: string | null;
}

export interface DetectedColumn {
  /** 0-based (A = 0). */
  columnIndex: number;
  label: string | null;
  group: DetectedGroup | null;
  role: ColumnRole;
  /** role = CRITERION only. */
  criterion?: {
    key: string;
    name: string;
    category: CriterionCategory;
    /** Resolved weight (own, or share of the group's), null when unknown. */
    weight: string | null;
    weightSource: 'LABEL' | 'GROUP_SHARE' | 'NONE';
  };
}

type CriterionColumn = DetectedColumn & { criterion: NonNullable<DetectedColumn['criterion']> };

const isCriterionColumn = (c: DetectedColumn): c is CriterionColumn => c.criterion !== undefined;

export interface CrossCheck {
  /** Rows with every mark and a numeric sheet total. */
  comparableRows: number;
  mismatchedRows: number;
  /** Rows with blanks whose sheet total equals the computed total with blanks counted as 0. */
  blanksAsZeroRows: number;
  examples: { rowNumber: number; sheetTotal: number; computed: number }[];
}

export interface TabLayout {
  /** 1-based row holding the leaf labels. */
  headerRow: number;
  columns: DetectedColumn[];
  /** SHA-256 hex of the normalized header rows; changes when a teacher edits headers. */
  headerSignature: string;
  /** Sum of resolved criterion weights (3 dp); null when some weight is unknown. */
  totalWeight: string | null;
  studentRows: number;
  crossCheck: CrossCheck | null;
}

const THOUSANDTHS = 1000;
const toThousandths = (weight: string) => Math.round(Number(weight) * THOUSANDTHS);
const fromThousandths = (n: number) => String(n / THOUSANDTHS);

/** Index of the leaf header row (0-based) or -1. */
export function findHeaderRow(grid: Grid): number {
  const limit = Math.min(grid.length, HEADER_SEARCH_ROWS);
  for (let r = 0; r < limit; r++) {
    if (
      (grid[r] ?? []).some((cell) => {
        const text = cellText(cell);
        return text !== null && isStudentIdLabel(text);
      })
    ) {
      return r;
    }
  }
  return -1;
}

export function headerSignature(grid: Grid, headerIndex: number): string {
  const rows = grid.slice(0, headerIndex + 1).map((row) => {
    const cells = row.map((c) => cellText(c)?.replace(/\s+/g, ' ').toUpperCase() ?? '');
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function studentIdColumn(header: readonly CellValue[]): number {
  return header.findIndex((cell) => {
    const text = cellText(cell);
    return text !== null && isStudentIdLabel(text);
  });
}

/** Data rows: below the header, with a non-blank student ID cell. */
function dataRows(grid: Grid, headerIndex: number, idColumn: number) {
  const rows: { rowNumber: number; cells: readonly CellValue[]; studentCode: string | null }[] = [];
  for (let r = headerIndex + 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const id = normalizeStudentId(cells[idColumn] ?? null);
    if (!id.ok && id.reason === 'EMPTY') continue;
    rows.push({ rowNumber: r + 1, cells, studentCode: id.ok ? id.value : null });
  }
  return rows;
}

function isNumericCell(value: CellValue | undefined): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return /^-?\d+(\.\d+)?$/.test(text) || text.toUpperCase() === 'ABS';
}

/**
 * Group spans for one row above the header: a label covers its own column and the following
 * criterion columns until the next label in that row (merged cells come back as top-left only).
 */
function groupSpans(
  row: readonly CellValue[],
  rowNumber: number,
  isCriterion: (column: number) => boolean,
  width: number,
): (DetectedGroup | null)[] {
  const spans: (DetectedGroup | null)[] = Array.from({ length: width }, () => null);
  let current: DetectedGroup | null = null;
  for (let c = 0; c < width; c++) {
    const text = cellText(row[c]);
    if (text !== null) {
      const parts = parseLabelWeight(text);
      current = { rowNumber, label: cleanLabel(text), name: parts.name, weight: parts.weight };
    }
    if (!isCriterion(c)) {
      current = null;
      continue;
    }
    spans[c] = current;
  }
  return spans;
}

/**
 * Detects the column layout of a subject (or roster) tab. Pure: reads the grid only and
 * reports problems in `log` (scope COURSE = this tab).
 */
export function detectTabLayout(grid: Grid, tab: string, log: IssueLog): TabLayout | null {
  const headerIndex = findHeaderRow(grid);
  if (headerIndex < 0) {
    log.error(
      'COURSE',
      'MISSING_STUDENT_ID_COLUMN',
      `No "STUDENT ID" header in the first ${HEADER_SEARCH_ROWS} rows of tab "${tab}".`,
      { sheetTab: tab },
    );
    return null;
  }
  const header = grid[headerIndex] ?? [];
  const width = Math.max(header.length, ...grid.slice(0, headerIndex).map((r) => r.length));
  const idColumn = studentIdColumn(header);
  const rows = dataRows(grid, headerIndex, idColumn);

  // 1. Role from the label, then demote text-only "criteria" (e.g. a mistyped name header).
  const roles: ColumnRole[] = [];
  const seen = new Set<ColumnRole>();
  for (let c = 0; c < width; c++) {
    const label = cellText(header[c]);
    let role: ColumnRole = label === null ? 'IGNORE' : roleFromLabel(label);
    const values = rows.map((r) => r.cells[c]).filter((v) => cellText(v) !== null);
    if (label === null && values.length > 0) {
      log.warn('UNRECOGNIZED_COLUMN', `Column ${c + 1} has data but no header; it is ignored.`, {
        sheetTab: tab,
        rowNumber: headerIndex + 1,
      });
    }
    if (role === 'CRITERION' && values.length > 0) {
      const textValues = values.filter((v) => !isNumericCell(v)).length;
      if (textValues / values.length > TEXT_SHARE) {
        role = 'IGNORE';
        log.warn(
          'UNRECOGNIZED_COLUMN',
          `Column "${label}" holds text, not marks; it is ignored. Fix the header if it is a profile column.`,
          { sheetTab: tab, rowNumber: headerIndex + 1, columnKey: label ?? undefined },
        );
      }
    }
    if (role !== 'CRITERION' && role !== 'IGNORE') {
      if (seen.has(role)) {
        if (role === 'STUDENT_ID') {
          log.error('COURSE', 'DUPLICATE_COLUMN', `Tab "${tab}" has two student ID columns.`, {
            sheetTab: tab,
            rowNumber: headerIndex + 1,
            columnKey: label ?? undefined,
          });
          return null;
        }
        role = 'IGNORE';
      } else {
        seen.add(role);
      }
    }
    roles.push(role);
  }

  // 2. Groups: the nearest labelled row above the header that covers the column.
  const isCriterion = (c: number) => roles[c] === 'CRITERION';
  const groupRows = grid
    .slice(0, headerIndex)
    .map((row, r) => groupSpans(row, r + 1, isCriterion, width));
  const groupOf = (c: number): DetectedGroup | null => {
    for (let r = groupRows.length - 1; r >= 0; r--) {
      const group = groupRows[r]?.[c];
      if (group) return group;
    }
    return null;
  };

  const columns: DetectedColumn[] = [];
  for (let c = 0; c < width; c++) {
    const label = cellText(header[c]);
    const role = roles[c] ?? 'IGNORE';
    const column: DetectedColumn = {
      columnIndex: c,
      label: label === null ? null : cleanLabel(label),
      group: role === 'CRITERION' ? groupOf(c) : null,
      role,
    };
    if (role === 'CRITERION' && label !== null) {
      const parts = parseLabelWeight(label);
      column.criterion = {
        key: '',
        name: parts.name || cleanLabel(label),
        category: guessCategory(parts.name, column.group?.name ?? null),
        weight: parts.weight,
        weightSource: parts.weight ? 'LABEL' : 'NONE',
      };
    }
    columns.push(column);
  }
  const criteria = columns.filter(isCriterionColumn);
  if (criteria.length === 0) {
    log.error('COURSE', 'NO_CRITERIA', `Tab "${tab}" has no mark columns.`, { sheetTab: tab });
  }

  resolveGroupWeights(criteria, tab, log);
  assignKeys(criteria);

  const unknownWeights = criteria.filter((c) => c.criterion.weight === null);
  for (const column of unknownWeights) {
    log.warn(
      'MISSING_WEIGHT',
      `Column "${column.label}" has no weight in its header; enter it before confirming.`,
      { sheetTab: tab, rowNumber: headerIndex + 1, columnKey: column.label ?? undefined },
    );
  }
  let totalWeight: string | null = null;
  if (criteria.length > 0 && unknownWeights.length === 0) {
    const total = criteria.reduce((sum, c) => sum + toThousandths(c.criterion.weight ?? '0'), 0);
    totalWeight = fromThousandths(total);
    if (total !== 100 * THOUSANDTHS) {
      log.warn('WEIGHTS_NOT_100', `Weights in tab "${tab}" total ${totalWeight}, not 100.`, {
        sheetTab: tab,
        rowNumber: headerIndex + 1,
      });
    }
  }

  const crossCheck = totalWeight === null ? null : crossCheckTotals(columns, rows);
  // Examples exist only when some complete row mismatched, so comparableRows > 0.
  const example = crossCheck?.examples[0];
  if (
    crossCheck &&
    example &&
    crossCheck.mismatchedRows / crossCheck.comparableRows > MISMATCH_SHARE
  ) {
    log.warn(
      'WEIGHTS_DISAGREE_WITH_SHEET_TOTAL',
      `${crossCheck.mismatchedRows} of ${crossCheck.comparableRows} complete rows in tab "${tab}" ` +
        `have a sheet total that differs from the weighted marks (row ${example.rowNumber}: ` +
        `sheet ${example.sheetTotal}, computed ${example.computed}). Check the weights.`,
      { sheetTab: tab, rowNumber: example.rowNumber },
    );
  }

  return {
    headerRow: headerIndex + 1,
    columns,
    headerSignature: headerSignature(grid, headerIndex),
    totalWeight,
    studentRows: rows.filter((r) => r.studentCode !== null).length,
    crossCheck,
  };
}

/**
 * Columns without their own weight share what is left of their group's weight equally, in
 * thousandths so the shares add up exactly ("Projects (15%)" over two columns → 7.5 + 7.5).
 */
function resolveGroupWeights(criteria: CriterionColumn[], tab: string, log: IssueLog): void {
  const byGroup = new Map<DetectedGroup, CriterionColumn[]>();
  for (const column of criteria) {
    if (!column.group?.weight) continue;
    const members = byGroup.get(column.group) ?? [];
    members.push(column);
    byGroup.set(column.group, members);
  }
  for (const [group, members] of byGroup) {
    if (group.weight === null) continue;
    const groupTotal = toThousandths(group.weight);
    const ownTotal = members.reduce(
      (sum, m) => sum + (m.criterion.weight === null ? 0 : toThousandths(m.criterion.weight)),
      0,
    );
    const open = members.filter((m) => m.criterion.weight === null);
    if (open.length === 0) {
      if (ownTotal !== groupTotal) {
        log.warn(
          'GROUP_WEIGHT_MISMATCH',
          `Columns under "${group.label}" add up to ${fromThousandths(ownTotal)}%, not ${group.weight}%.`,
          { sheetTab: tab, rowNumber: group.rowNumber },
        );
      }
      continue;
    }
    const remaining = groupTotal - ownTotal;
    if (remaining <= 0) continue; // reported as MISSING_WEIGHT
    const base = Math.floor(remaining / open.length);
    const extra = remaining - base * open.length;
    open.forEach((column, i) => {
      // The last columns absorb the rounding remainder (5% over 3 → 1.666, 1.667, 1.667).
      const share = base + (i >= open.length - extra ? 1 : 0);
      column.criterion.weight = fromThousandths(share);
      column.criterion.weightSource = 'GROUP_SHARE';
    });
  }
}

/** Unique keys per tab. Duplicate names get their group as prefix (Final › Speaking). */
function assignKeys(criteria: CriterionColumn[]): void {
  const nameCount = new Map<string, number>();
  for (const c of criteria) {
    const name = c.criterion.name.toUpperCase();
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }
  const used = new Set<string>();
  for (const column of criteria) {
    const criterion = column.criterion;
    if ((nameCount.get(criterion.name.toUpperCase()) ?? 0) > 1 && column.group?.name) {
      criterion.name = `${column.group.name} – ${criterion.name}`;
    }
    const base = keyFromName(criterion.name);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 29)}_${n}`;
    used.add(key);
    criterion.key = key;
  }
}

function crossCheckTotals(
  columns: DetectedColumn[],
  rows: ReturnType<typeof dataRows>,
): CrossCheck | null {
  const total = columns.find((c) => c.role === 'REFERENCE_TOTAL');
  if (!total) return null;
  const criteria = columns.filter(isCriterionColumn);
  const result: CrossCheck = {
    comparableRows: 0,
    mismatchedRows: 0,
    blanksAsZeroRows: 0,
    examples: [],
  };
  for (const row of rows) {
    if (row.studentCode === null) continue;
    const sheetTotal = row.cells[total.columnIndex];
    if (typeof sheetTotal !== 'number') continue;
    let computed = 0;
    let blanks = 0;
    let invalid = false;
    for (const column of criteria) {
      const cell = parseMarkCell(row.cells[column.columnIndex], TERM_WORKBOOK_MAX_MARK);
      if (cell.kind === 'blank') blanks++;
      else if (cell.kind === 'invalid') invalid = true;
      else computed += (Number(cell.mark) * Number(column.criterion.weight)) / 100;
    }
    if (invalid) continue;
    const rounded = Math.round(computed * 100) / 100;
    const matches = Math.abs(rounded - sheetTotal) <= TOTAL_TOLERANCE;
    if (blanks > 0) {
      if (matches) result.blanksAsZeroRows++;
      continue;
    }
    result.comparableRows++;
    if (!matches) {
      result.mismatchedRows++;
      if (result.examples.length < 3) {
        result.examples.push({ rowNumber: row.rowNumber, sheetTotal, computed: rounded });
      }
    }
  }
  return result;
}
