import { GoogleSheetsReader } from './google-reader.js';
import {
  SheetsAccessError,
  type Grid,
  type SheetsReader,
  type SpreadsheetMetadata,
} from './reader.js';

/** Used when no Google credentials are configured: every call explains what is missing. */
export class NotConfiguredSheetsReader implements SheetsReader {
  readonly serviceAccountEmail = null;

  private fail(): never {
    throw new SheetsAccessError(
      'GOOGLE_NOT_CONFIGURED',
      'Google Sheets access is not configured on the server (see docs/google-sheets-template.md §7).',
    );
  }

  async getMetadata(): Promise<SpreadsheetMetadata> {
    this.fail();
  }

  async readTabs(): Promise<Grid[]> {
    this.fail();
  }
}

export interface GoogleEnv {
  GOOGLE_APPLICATION_CREDENTIALS?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
}

/**
 * Builds the reader from environment settings (shared by API and worker). Exactly one
 * mechanism may be configured; none yields a reader that reports GOOGLE_NOT_CONFIGURED.
 */
export function createSheetsReaderFromEnv(env: GoogleEnv): SheetsReader {
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS || undefined;
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL || undefined;
  const key = env.GOOGLE_PRIVATE_KEY || undefined;
  if ((email && !key) || (!email && key)) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set together');
  }
  if (keyFile && email) {
    throw new Error(
      'Configure either GOOGLE_APPLICATION_CREDENTIALS or the inline email/key, not both',
    );
  }
  if (keyFile) return new GoogleSheetsReader({ credentials: { kind: 'keyFile', keyFile } });
  if (email && key) {
    return new GoogleSheetsReader({
      credentials: { kind: 'inline', clientEmail: email, privateKey: key.replace(/\\n/g, '\n') },
    });
  }
  return new NotConfiguredSheetsReader();
}

export interface SheetsReaderEnv extends GoogleEnv {
  NODE_ENV?: string;
  /** `fixtures`: end-to-end test mode with the bundled fixture workbook. Never in production. */
  SHEETS_TEST_MODE?: 'fixtures';
}

/**
 * The reader the API and worker use. In end-to-end test mode it serves the fixture workbook
 * under `TERM_FIXTURE_SPREADSHEET_ID`, so tests exercise the real
 * services without Google. Test mode is refused with NODE_ENV=production, and the fake is loaded
 * lazily from `./testing`, which production images delete (see docker/), so it cannot be enabled
 * there at all.
 */
export async function createSheetsReader(env: SheetsReaderEnv): Promise<SheetsReader> {
  if (env.SHEETS_TEST_MODE !== 'fixtures') return createSheetsReaderFromEnv(env);
  if (env.NODE_ENV === 'production') {
    throw new Error('SHEETS_TEST_MODE cannot be used with NODE_ENV=production');
  }
  const testing = await import('./testing/index.js');
  return new testing.InMemorySheetsReader()
    .set(testing.TERM_FIXTURE_SPREADSHEET_ID, testing.termWorkbookFixture())
    .set(testing.TERM_FIXTURE_REPLACEMENT_ID, testing.replacementWorkbookFixture());
}
