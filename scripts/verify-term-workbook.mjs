#!/usr/bin/env node
// Runs term-workbook detection on a real workbook and prints a report (docs/verify-sprint-1.md).
// Read-only: nothing reaches the database, and no names or marks are printed.
//
//   node scripts/verify-term-workbook.mjs --xlsx "<file.xlsx>" [--generation GEN2027] [--term 1]
//   node scripts/verify-term-workbook.mjs --sheet "<Google Sheets URL>" [--generation GEN2027] [--term 1]
//
// --xlsx needs Python with openpyxl. --sheet uses the Google credentials in .env and needs the
// workbook shared with the service account (Viewer). Build first: pnpm build.
// Exit code: 0 = usable (columns to review are listed), 1 = problems to fix, 2 = could not run.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createSheetsReaderFromEnv,
  detectTermWorkbook,
  parseSpreadsheetUrl,
} from '../packages/sheets/dist/index.js';
import { InMemorySheetsReader } from '../packages/sheets/dist/testing/index.js';
import { loadRootEnv } from '../packages/shared/dist/node/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({
  options: {
    xlsx: { type: 'string' },
    sheet: { type: 'string' },
    generation: { type: 'string', default: 'GEN2027' },
    term: { type: 'string', default: '1' },
    python: { type: 'string', default: 'python' },
  },
});

function stop(message) {
  console.error(message);
  process.exit(2);
}

async function open() {
  if (opts.xlsx) {
    const run = spawnSync(opts.python, [join(here, 'xlsx-to-grids.py'), opts.xlsx], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (run.status !== 0) stop(`Could not read the workbook: ${run.error ?? run.stderr}`);
    const id = 'local-file';
    return { reader: new InMemorySheetsReader().set(id, JSON.parse(run.stdout)), id };
  }
  if (opts.sheet) {
    const url = parseSpreadsheetUrl(opts.sheet);
    if (!url.ok) stop(url.message);
    loadRootEnv();
    return { reader: createSheetsReaderFromEnv(process.env), id: url.spreadsheetId };
  }
  return stop('Pass --xlsx <file> or --sheet <Google Sheets URL>.');
}

const { reader, id } = await open();
let result;
try {
  result = await detectTermWorkbook(reader, id, {
    generationCode: opts.generation,
    termNumber: Number(opts.term),
  });
} catch (err) {
  stop(`${err.code ?? 'ERROR'}: ${err.message}`);
}

console.log(`Workbook : ${result.spreadsheetTitle}`);
console.log(`_meta    : ${result.meta ? JSON.stringify(result.meta) : 'none'}`);
console.log(`Roster   : ${result.roster.length} students from "${result.rosterTab ?? 'none'}"\n`);

let problems = result.fatal ? 1 : 0;
const review = [];
for (const tab of result.tabs) {
  const layout = tab.layout;
  if (!layout) {
    console.log(`✗ ${tab.tabName}: no STUDENT ID header\n`);
    problems++;
    continue;
  }
  const criteria = layout.columns.filter((c) => c.criterion);
  const check = layout.crossCheck;
  console.log(`${tab.tabName}: header row ${layout.headerRow}, ${layout.studentRows} students`);
  console.log(
    `  columns (${criteria.length}): ` +
      criteria.map((c) => `${c.criterion.key}=${c.criterion.weight ?? '?'}`).join(', '),
  );
  console.log(`  total weight: ${layout.totalWeight ?? 'unknown'}`);
  console.log(
    check
      ? `  sheet total : ${check.comparableRows - check.mismatchedRows}/${check.comparableRows} complete rows match, ${check.blanksAsZeroRows} rows match only if blanks = 0`
      : '  sheet total : not compared',
  );
  if (tab.unknownStudents > 0) console.log(`  not in roster: ${tab.unknownStudents}`);
  console.log('');
  if (layout.totalWeight === null) review.push(`${tab.tabName}: enter the missing weights`);
  else if (layout.totalWeight !== '100') problems++;
  if (check?.mismatchedRows) problems++;
  if (tab.unknownStudents > 0) problems++;
}

const counts = new Map();
for (const issue of result.issues) {
  const key = `${issue.severity} ${issue.code}${issue.sheetTab ? ` (${issue.sheetTab})` : ''}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
if (counts.size > 0) console.log('Issues:');
for (const [key, count] of counts) console.log(`  ${count} × ${key}`);
if (review.length > 0) console.log(`\nTo review: ${review.join('; ')}`);
console.log(problems > 0 ? `\nRESULT: ${problems} problem(s) to fix` : '\nRESULT: OK');
process.exit(problems > 0 ? 1 : 0);
