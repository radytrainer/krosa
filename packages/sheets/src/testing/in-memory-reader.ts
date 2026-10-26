import {
  SheetsAccessError,
  type Grid,
  type SheetsErrorCode,
  type SheetsReader,
  type SpreadsheetMetadata,
} from '../reader.js';

export interface FakeSpreadsheet {
  title: string;
  /** Tab title → cell values (rows of cells), in tab order. */
  tabs: Record<string, Grid>;
}

/**
 * In-memory SheetsReader for tests and local demos. It mirrors the Google contract: exact tab
 * titles, whole-tab reads, and access failures surfaced as SheetsAccessError. Every call is
 * recorded so tests can assert that reads are batched.
 */
export class InMemorySheetsReader implements SheetsReader {
  readonly calls: { method: 'getMetadata' | 'readTabs'; spreadsheetId: string; tabs?: string[] }[] =
    [];
  private readonly failures = new Map<string, SheetsErrorCode>();

  constructor(
    private readonly spreadsheets: Map<string, FakeSpreadsheet> = new Map(),
    readonly serviceAccountEmail:
      string | null = 'ssrs-sync@example-project.iam.gserviceaccount.com',
  ) {}

  set(spreadsheetId: string, spreadsheet: FakeSpreadsheet): this {
    this.spreadsheets.set(spreadsheetId, spreadsheet);
    this.failures.delete(spreadsheetId);
    return this;
  }

  /** Forgets recorded calls (for readers shared between tests). */
  clearCalls(): this {
    this.calls.length = 0;
    return this;
  }

  /** Makes every call for this spreadsheet fail (e.g. SHEET_NOT_SHARED). */
  fail(spreadsheetId: string, code: SheetsErrorCode): this {
    this.failures.set(spreadsheetId, code);
    return this;
  }

  private lookup(spreadsheetId: string): FakeSpreadsheet {
    const failure = this.failures.get(spreadsheetId);
    if (failure) {
      // Same wording as GoogleSheetsReader for the access error admins see most.
      const message =
        failure === 'SHEET_NOT_SHARED' && this.serviceAccountEmail
          ? `The service account cannot open this spreadsheet. Share it with ${this.serviceAccountEmail} (Viewer).`
          : `Simulated failure: ${failure}`;
      throw new SheetsAccessError(
        failure,
        message,
        failure === 'RATE_LIMITED' || failure === 'GOOGLE_UNAVAILABLE',
      );
    }
    const sheet = this.spreadsheets.get(spreadsheetId);
    if (!sheet)
      throw new SheetsAccessError(
        'SHEET_NOT_FOUND',
        'Spreadsheet not found. Check the URL.',
        false,
        404,
      );
    return sheet;
  }

  async getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    this.calls.push({ method: 'getMetadata', spreadsheetId });
    const sheet = this.lookup(spreadsheetId);
    return {
      spreadsheetId,
      title: sheet.title,
      tabs: Object.entries(sheet.tabs).map(([title, grid], i) => ({
        sheetId: i,
        title,
        rowCount: Math.max(grid.length, 1000),
        columnCount: Math.max(...grid.map((r) => r.length), 26),
      })),
    };
  }

  async readTabs(spreadsheetId: string, tabTitles: readonly string[]): Promise<Grid[]> {
    this.calls.push({ method: 'readTabs', spreadsheetId, tabs: [...tabTitles] });
    const sheet = this.lookup(spreadsheetId);
    return tabTitles.map((title) => {
      const grid = sheet.tabs[title];
      if (!grid)
        throw new SheetsAccessError(
          'GOOGLE_ERROR',
          `Unable to parse range: '${title}'`,
          false,
          400,
        );
      // Google omits trailing empty cells and rows; copy so tests can't mutate fixtures.
      return grid.map((row) => [...row]);
    });
  }
}
