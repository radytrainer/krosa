/** Raw cell values as returned with valueRenderOption=UNFORMATTED_VALUE. */
export type CellValue = string | number | boolean | null;
export type Grid = CellValue[][];

export interface SheetTabInfo {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  tabs: SheetTabInfo[];
}

/**
 * Read-only access to spreadsheets. The production implementation talks to the Google Sheets
 * API; tests use an in-memory implementation with the same contract.
 */
export interface SheetsReader {
  /** Email to share spreadsheets with, when known. */
  readonly serviceAccountEmail: string | null;
  getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata>;
  /** Reads whole tabs by exact title, one batched request. Results are in request order. */
  readTabs(spreadsheetId: string, tabTitles: readonly string[]): Promise<Grid[]>;
}

export type SheetsErrorCode =
  | 'SHEET_NOT_SHARED'
  | 'SHEET_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'GOOGLE_UNAVAILABLE'
  | 'GOOGLE_NOT_CONFIGURED'
  | 'GOOGLE_AUTH_FAILED'
  | 'GOOGLE_ERROR';

export class SheetsAccessError extends Error {
  constructor(
    public readonly code: SheetsErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SheetsAccessError';
  }
}

/** A1-notation range covering a whole tab: the title in single quotes, quotes doubled. */
export function wholeTabRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}
