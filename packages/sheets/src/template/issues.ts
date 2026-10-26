import { LIMITS } from './constants.js';

export type IssueSeverity = 'ERROR' | 'WARNING';

/**
 * Blast radius of an issue:
 *  FILE   – the whole source is rejected, nothing is written.
 *  COURSE – that course offering is skipped (or, for scheme issues, stays unconfigured).
 *  ROW    – that row is skipped.
 *  CELL   – only that cell is skipped.
 */
export type IssueScope = 'FILE' | 'COURSE' | 'ROW' | 'CELL';

export type IssueCode =
  // file
  | 'TEMPLATE_TAB_MISSING'
  | 'UNSUPPORTED_TEMPLATE_VERSION'
  | 'GENERATION_CODE_MISSING'
  | 'GENERATION_MISMATCH'
  | 'MISSING_COLUMN'
  | 'TAB_TOO_LARGE'
  | 'TOO_MANY_COURSES'
  // course
  | 'INVALID_COURSE_KEY'
  | 'INVALID_TERM'
  | 'INVALID_COURSE_CODE'
  | 'MISSING_COURSE_NAME'
  | 'INVALID_CREDITS'
  | 'DUPLICATE_COURSE'
  | 'DUPLICATE_WORKSHEET'
  | 'WORKSHEET_NOT_FOUND'
  | 'NO_CRITERIA'
  | 'INVALID_CRITERION_KEY'
  | 'DUPLICATE_CRITERION'
  | 'INVALID_MAX_MARK'
  | 'INVALID_WEIGHT'
  | 'WEIGHTS_NOT_100'
  | 'MISSING_STUDENT_ID_COLUMN'
  | 'UNKNOWN_COLUMN'
  | 'DUPLICATE_COLUMN'
  // row
  | 'UNKNOWN_COURSE'
  | 'INVALID_STUDENT_ID'
  | 'MISSING_STUDENT_NAME'
  | 'DUPLICATE_STUDENT'
  | 'UNKNOWN_STUDENT'
  | 'DUPLICATE_ROW'
  // cell
  | 'INVALID_MARK'
  // warnings
  | 'UNKNOWN_GENDER'
  | 'UNKNOWN_CATEGORY'
  | 'INVALID_VISIBLE'
  | 'INVALID_ORDER'
  | 'MISSING_CRITERION_COLUMN'
  | 'PROFILE_MISMATCH'
  | 'IGNORED_COLUMN'
  | 'IGNORED_TAB';

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
