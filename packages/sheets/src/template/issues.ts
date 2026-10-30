import { LIMITS } from './constants.js';

export type IssueSeverity = 'ERROR' | 'WARNING';

/**
 * Blast radius of an issue:
 *  FILE   – the whole source is rejected, nothing is written.
 *  COURSE – that subject tab is skipped.
 *  ROW    – that row is skipped.
 *  CELL   – only that cell is skipped.
 */
export type IssueScope = 'FILE' | 'COURSE' | 'ROW' | 'CELL';

export type IssueCode =
  // file
  | 'ROSTER_TAB_MISSING'
  | 'GENERATION_MISMATCH'
  | 'TERM_MISMATCH'
  | 'MISSING_COLUMN'
  | 'TAB_TOO_LARGE'
  | 'NO_CONFIRMED_TABS'
  // tab (scope COURSE)
  | 'MISSING_STUDENT_ID_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'NO_CRITERIA'
  | 'WORKSHEET_NOT_FOUND'
  | 'NEEDS_REMAP'
  // row
  | 'INVALID_STUDENT_ID'
  | 'MISSING_STUDENT_ID'
  | 'MISSING_STUDENT_NAME'
  | 'DUPLICATE_STUDENT'
  | 'UNKNOWN_STUDENT'
  | 'DUPLICATE_ROW'
  // cell
  | 'INVALID_MARK'
  // warnings
  | 'UNKNOWN_GENDER'
  | 'PROFILE_MISMATCH'
  | 'MISSING_WEIGHT'
  | 'WEIGHTS_NOT_100'
  | 'GROUP_WEIGHT_MISMATCH'
  | 'WEIGHTS_DISAGREE_WITH_SHEET_TOTAL'
  | 'UNRECOGNIZED_COLUMN'
  | 'UNMAPPED_TAB';

export interface TemplateIssue {
  severity: IssueSeverity;
  scope: IssueScope;
  code: IssueCode;
  message: string;
  sheetTab?: string;
  /** 1-based row number as shown in Google Sheets. */
  rowNumber?: number;
  columnKey?: string;
  studentCode?: string;
  courseKey?: string;
  criterionKey?: string;
  rawValue?: string;
}

export function rawValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.length > LIMITS.maxRawValueLength
    ? `${text.slice(0, LIMITS.maxRawValueLength)}…`
    : text;
}

/** Collects issues; `error`/`warn` helpers keep call sites short. */
export class IssueLog {
  readonly items: TemplateIssue[] = [];

  error(
    scope: IssueScope,
    code: IssueCode,
    message: string,
    at: Omit<TemplateIssue, 'severity' | 'scope' | 'code' | 'message'> = {},
  ): void {
    this.items.push({ severity: 'ERROR', scope, code, message, ...at });
  }

  warn(
    code: IssueCode,
    message: string,
    at: Omit<TemplateIssue, 'severity' | 'scope' | 'code' | 'message'> = {},
  ): void {
    this.items.push({ severity: 'WARNING', scope: 'CELL', code, message, ...at });
  }

  get hasFileError(): boolean {
    return this.items.some((i) => i.severity === 'ERROR' && i.scope === 'FILE');
  }
}
