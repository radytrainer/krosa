import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SheetsAccessError } from '@ssrs/sheets';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Google keeps a tab's id when it moves, so derive it from the title. */
const tabId = (title) =>
  createHash('sha256').update(title).digest().readUInt32BE(0) % 2_000_000_000;

/**
 * Stands in for Google in the manual-case browser suite: each spreadsheet is a JSON file that the
 * test edits, as a teacher edits a sheet. Same contract as InMemorySheetsReader. Never contacts
 * Google.
 */
export class FileSheetsReader {
  serviceAccountEmail = 'qa-sync@example-project.iam.gserviceaccount.com';

  constructor(dir) {
    this.dir = dir;
  }

  load(spreadsheetId) {
    const file = path.join(this.dir, `${spreadsheetId}.json`);
    if (!existsSync(file)) {
      throw new SheetsAccessError(
        'SHEET_NOT_FOUND',
        'Spreadsheet not found. Check the URL.',
        false,
        404,
      );
    }
    const sheet = JSON.parse(readFileSync(file, 'utf8'));
    if (sheet.fail === 'SHEET_NOT_SHARED') {
      throw new SheetsAccessError(
        'SHEET_NOT_SHARED',
        `The service account cannot open this spreadsheet. Share it with ${this.serviceAccountEmail} (Viewer).`,
      );
    }
    if (sheet.fail) throw new SheetsAccessError(sheet.fail, `Simulated failure: ${sheet.fail}`);
    return sheet;
  }

  async getMetadata(spreadsheetId) {
    const sheet = this.load(spreadsheetId);
    return {
      spreadsheetId,
      title: sheet.title,
      tabs: Object.entries(sheet.tabs).map(([title, grid]) => ({
        sheetId: tabId(title),
        title,
        rowCount: Math.max(grid.length, 1000),
        columnCount: Math.max(...grid.map((r) => r.length), 26),
      })),
    };
  }

  async readTabs(spreadsheetId, tabTitles) {
    const sheet = this.load(spreadsheetId);
    if (sheet.delayMs) await sleep(sheet.delayMs);
    return tabTitles.map((title) => {
      const grid = sheet.tabs[title];
      if (!grid) {
        throw new SheetsAccessError(
          'GOOGLE_ERROR',
          `Unable to parse range: '${title}'`,
          false,
          400,
        );
      }
      return grid;
    });
  }
}
