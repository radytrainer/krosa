import type { CellValue, Grid } from '../reader.js';
import { cellText } from '../template/cells.js';
import { rawValue, type IssueLog } from '../template/issues.js';

/**
 * `_meta` identifies the workbook's generation and term. It is checked when connecting and
 * syncing, and never imported. Layout: key in column A, value in column B, one key per row.
 */
export const TERM_META_TAB = '_meta';
export const META_GENERATION_KEY = 'generation_code';
export const META_TERM_KEY = 'education_term';
/** Older workbooks wrote `term` instead of `education_term`. */
export const META_TERM_ALIAS = 'term';

/** The `_meta` codes that block a workbook. */
export const META_ISSUE_CODES = ['META_MISSING', 'WORKBOOK_MISMATCH'] as const;
export type MetaIssueCode = (typeof META_ISSUE_CODES)[number];

export function isMetaIssueCode(code: string): code is MetaIssueCode {
  return (META_ISSUE_CODES as readonly string[]).includes(code);
}

/** What `_meta` holds, as found (trimmed text, original case); null when absent or blank. */
export interface MetaFound {
  generationCode: string | null;
  term: string | null;
}

export interface MetaExpected {
  generationCode: string;
  termNumber: number;
}

export interface MetaCheck {
  /** False when the workbook has no `_meta` tab. */
  present: boolean;
  found: MetaFound;
  /** The term number read from `found.term`, or null when it cannot be read. */
  termNumber: number | null;
}

/** Longest `_meta` value shown in a message or stored in the audit; longer ones end in "…". */
export const META_VALUE_MAX = 100;

/** A `_meta` value as shown to people: at most META_VALUE_MAX characters, then "…". */
export function capMetaValue<T extends string | null>(value: T): T {
  return (
    value !== null && value.length > META_VALUE_MAX ? `${value.slice(0, META_VALUE_MAX)}…` : value
  ) as T;
}

/** Same generation: trimmed and case-insensitive, otherwise exact ("GEN 2027" is not GEN2027). */
export function sameGeneration(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const TERM_TEXT = /^(?:term|t)?\s*(\d{1,2})$/i;

/** A term number from a cell: 1, "1", "Term 1", "T1" (1–99). Anything else is null. */
export function parseMetaTerm(value: CellValue | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = TERM_TEXT.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= 99 ? n : null;
}

/** Key/value rows of `_meta`: keys trimmed and lower-cased; the last row of a key wins. */
function metaValues(grid: Grid): Map<string, CellValue | undefined> {
  const values = new Map<string, CellValue | undefined>();
  for (const row of grid) {
    const key = cellText(row[0])?.toLowerCase();
    if (key) values.set(key, row[1]);
  }
  return values;
}

/** Reads `_meta` (null grid: the tab is missing) without judging it. */
export function readTermMeta(grid: Grid | null): MetaCheck {
  if (!grid)
    return { present: false, found: { generationCode: null, term: null }, termNumber: null };
  const values = metaValues(grid);
  const termCell =
    cellText(values.get(META_TERM_KEY)) !== null
      ? values.get(META_TERM_KEY)
      : values.get(META_TERM_ALIAS);
  const term = cellText(termCell);
  return {
    present: true,
    found: { generationCode: cellText(values.get(META_GENERATION_KEY)), term },
    termNumber: term === null ? null : parseMetaTerm(termCell),
  };
}

const at = (value: unknown) => ({ sheetTab: TERM_META_TAB, rawValue: rawValue(value) });

/**
 * Checks `_meta` against the generation and term the admin selected. A missing tab, or a blank or
 * unreadable value, is META_MISSING; a value that differs is WORKBOOK_MISMATCH. Both are FILE
 * errors: nothing from the workbook may be connected or applied.
 */
export function checkTermMeta(grid: Grid | null, expected: MetaExpected, log: IssueLog): MetaCheck {
  const meta = readTermMeta(grid);
  if (!meta.present) {
    log.error(
      'FILE',
      'META_MISSING',
      `The workbook has no ${TERM_META_TAB} tab. Add one with ${META_GENERATION_KEY} and ${META_TERM_KEY}.`,
      { sheetTab: TERM_META_TAB },
    );
    return meta;
  }
  const { generationCode, term } = meta.found;
  let readable = true;
  if (generationCode === null) {
    readable = false;
    log.error('FILE', 'META_MISSING', `${TERM_META_TAB} has no ${META_GENERATION_KEY}.`, {
      sheetTab: TERM_META_TAB,
    });
  }
  if (term === null) {
    readable = false;
    log.error('FILE', 'META_MISSING', `${TERM_META_TAB} has no ${META_TERM_KEY}.`, {
      sheetTab: TERM_META_TAB,
    });
  } else if (meta.termNumber === null) {
    readable = false;
    log.error(
      'FILE',
      'META_MISSING',
      `${TERM_META_TAB} ${META_TERM_KEY} "${capMetaValue(term)}" cannot be read as a term number.`,
      at(term),
    );
  }
  if (!readable || generationCode === null || meta.termNumber === null) return meta;

  if (
    !sameGeneration(generationCode, expected.generationCode) ||
    meta.termNumber !== expected.termNumber
  ) {
    log.error(
      'FILE',
      'WORKBOOK_MISMATCH',
      `This workbook is for ${capMetaValue(generationCode)}, Term ${meta.termNumber}. ` +
        `You selected ${expected.generationCode}, Term ${expected.termNumber}. ` +
        'Choose the matching term or check the workbook.',
      at(`${generationCode} / ${term}`),
    );
  }
  return meta;
}
