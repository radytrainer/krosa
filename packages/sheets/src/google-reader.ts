import { readFileSync } from 'node:fs';
import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { GoogleAuth } from 'google-auth-library';
import {
  SheetsAccessError,
  wholeTabRange,
  type Grid,
  type SheetsReader,
  type SpreadsheetMetadata,
} from './reader.js';
import { withRetry } from './retry.js';

export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export type GoogleCredentialsConfig =
  | { kind: 'keyFile'; keyFile: string }
  | { kind: 'inline'; clientEmail: string; privateKey: string };

export interface GoogleSheetsReaderOptions {
  credentials: GoogleCredentialsConfig;
  /** Per-request timeout. */
  timeoutMs?: number;
  retryAttempts?: number;
}

interface ErrorShape {
  status?: number;
  code?: string | number;
  response?: { status?: number; headers?: unknown };
  message?: string;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'TimeoutError',
  'AbortError',
]);

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as ErrorShape;
  const status =
    e.status ?? e.response?.status ?? (typeof e.code === 'number' ? e.code : undefined);
  return typeof status === 'number' ? status : undefined;
}

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as ErrorShape | null)?.response?.headers;
  let value: unknown;
  if (headers && typeof (headers as Headers).get === 'function')
    value = (headers as Headers).get('retry-after');
  else if (headers && typeof headers === 'object')
    value = (headers as Record<string, unknown>)['retry-after'];
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function classifyGoogleError(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  const status = statusOf(err);
  if (status !== undefined)
    return { retryable: TRANSIENT_STATUS.has(status), retryAfterMs: retryAfterMs(err) };
  const code = (err as ErrorShape | null)?.code;
  const name = (err as Error | null)?.name;
  return {
    retryable:
      (typeof code === 'string' && TRANSIENT_CODES.has(code)) ||
      (name !== undefined && TRANSIENT_CODES.has(name)),
  };
}

/** Maps Google API failures to stable, user-actionable error codes (never leaks credentials). */
export function toSheetsAccessError(
  err: unknown,
  serviceAccountEmail: string | null,
): SheetsAccessError {
  if (err instanceof SheetsAccessError) return err;
  const status = statusOf(err);
  const share = serviceAccountEmail ? ` Share it with ${serviceAccountEmail} (Viewer).` : '';
  switch (status) {
    case 401:
      return new SheetsAccessError(
        'GOOGLE_AUTH_FAILED',
        'Google rejected the service-account credentials.',
        false,
        status,
      );
    case 403:
      return new SheetsAccessError(
        'SHEET_NOT_SHARED',
        `The service account cannot open this spreadsheet.${share}`,
        false,
        status,
      );
    case 404:
      return new SheetsAccessError(
        'SHEET_NOT_FOUND',
        'Spreadsheet not found. Check the URL.',
        false,
        status,
      );
    case 429:
      return new SheetsAccessError(
        'RATE_LIMITED',
        'Google Sheets API quota exceeded. Try again later.',
        true,
        status,
      );
    default:
      if (status !== undefined && status >= 500) {
        return new SheetsAccessError(
          'GOOGLE_UNAVAILABLE',
          'Google Sheets is temporarily unavailable.',
          true,
          status,
        );
      }
      if (classifyGoogleError(err).retryable) {
        return new SheetsAccessError('GOOGLE_UNAVAILABLE', 'Could not reach Google Sheets.', true);
      }
      return new SheetsAccessError(
        'GOOGLE_ERROR',
        'Unexpected error from Google Sheets.',
        false,
        status,
      );
  }
}

function readClientEmail(credentials: GoogleCredentialsConfig): string | null {
  if (credentials.kind === 'inline') return credentials.clientEmail;
  try {
    const parsed = JSON.parse(readFileSync(credentials.keyFile, 'utf8')) as {
      client_email?: unknown;
    };
    return typeof parsed.client_email === 'string' ? parsed.client_email : null;
  } catch {
    return null;
  }
}

/** Google Sheets API implementation with read-only scope, batched reads and retries. */
export class GoogleSheetsReader implements SheetsReader {
  readonly serviceAccountEmail: string | null;
  private readonly api: sheets_v4.Sheets;
  private readonly attempts: number;

  constructor(options: GoogleSheetsReaderOptions) {
    const { credentials } = options;
    const auth =
      credentials.kind === 'keyFile'
        ? new GoogleAuth({ keyFile: credentials.keyFile, scopes: [SHEETS_READONLY_SCOPE] })
        : new GoogleAuth({
            credentials: {
              client_email: credentials.clientEmail,
              private_key: credentials.privateKey,
            },
            scopes: [SHEETS_READONLY_SCOPE],
          });
    this.serviceAccountEmail = readClientEmail(credentials);
    this.api = sheets({ version: 'v4', auth, timeout: options.timeoutMs ?? 30_000, retry: false });
    this.attempts = options.retryAttempts ?? 5;
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { attempts: this.attempts, classify: classifyGoogleError }).catch(
      (err: unknown) => {
        throw toSheetsAccessError(err, this.serviceAccountEmail);
      },
    );
  }

  async getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    const res = await this.call(() =>
      this.api.spreadsheets.get({
        spreadsheetId,
        fields:
          'spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
      }),
    );
    return {
      spreadsheetId: res.data.spreadsheetId ?? spreadsheetId,
      title: res.data.properties?.title ?? '',
      tabs: (res.data.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? '',
        rowCount: s.properties?.gridProperties?.rowCount ?? 0,
        columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      })),
    };
  }

  async readTabs(spreadsheetId: string, tabTitles: readonly string[]): Promise<Grid[]> {
    if (tabTitles.length === 0) return [];
    const res = await this.call(() =>
      this.api.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: tabTitles.map(wholeTabRange),
        majorDimension: 'ROWS',
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      }),
    );
    const ranges = res.data.valueRanges ?? [];
    return tabTitles.map((_, i) => (ranges[i]?.values ?? []) as Grid);
  }
}
