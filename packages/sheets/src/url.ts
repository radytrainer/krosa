/**
 * Extracts the spreadsheet ID from a Google Sheets URL (docs/requirements.md GS-02).
 * Only https://docs.google.com/spreadsheets/d/<id>… is accepted. "Published to the web" URLs
 * (/d/e/2PACX-…) are rejected because they are not spreadsheet IDs and cannot be read with
 * the Sheets API.
 */
export type SpreadsheetUrlResult =
  | { ok: true; spreadsheetId: string }
  | {
      ok: false;
      code: 'INVALID_URL' | 'UNSUPPORTED_HOST' | 'NOT_A_SPREADSHEET_URL';
      message: string;
    };

export const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const PATH_PATTERN = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([^/]+)(?:\/.*)?$/;

export function parseSpreadsheetUrl(input: string): SpreadsheetUrlResult {
  const text = input.trim();
  if (text.length === 0 || text.length > 2048) {
    return { ok: false, code: 'INVALID_URL', message: 'Enter the full Google Sheets URL.' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'This is not a valid URL.' };
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'docs.google.com' ||
    url.port !== '' ||
    url.username ||
    url.password
  ) {
    return {
      ok: false,
      code: 'UNSUPPORTED_HOST',
      message: 'Only https://docs.google.com/spreadsheets/… URLs are supported.',
    };
  }
  const match = PATH_PATTERN.exec(url.pathname);
  const id = match?.[1];
  if (!id || id === 'e' || !SPREADSHEET_ID_PATTERN.test(id)) {
    return {
      ok: false,
      code: 'NOT_A_SPREADSHEET_URL',
      message:
        'Open the spreadsheet in Google Sheets and copy the URL from the address bar (…/spreadsheets/d/<id>/edit).',
    };
  }
  return { ok: true, spreadsheetId: id };
}
