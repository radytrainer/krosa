import { IssueLog, type TemplateIssue } from '../template/issues.js';
import { InMemorySheetsReader, type FakeSpreadsheet } from '../testing/in-memory-reader.js';
import {
  TERM_FIXTURE_GENERATION_CODE,
  TERM_FIXTURE_SPREADSHEET_ID,
  TERM_FIXTURE_TERM,
  termWorkbookFixture,
} from '../testing/term-workbook-fixture.js';
import type { DetectedColumn } from './layout.js';
import { checkTermWorkbook, detectTermWorkbook, type TermWorkbookOptions } from './read.js';
import { parseRoster } from './roster.js';
import { parseSubjectRows, type SubjectTabMapping } from './subject-rows.js';

const ID = TERM_FIXTURE_SPREADSHEET_ID;
const OPTIONS: TermWorkbookOptions = {
  generationCode: TERM_FIXTURE_GENERATION_CODE,
  termNumber: TERM_FIXTURE_TERM,
};

async function detect(sheet: FakeSpreadsheet = termWorkbookFixture(), options = OPTIONS) {
  const reader = new InMemorySheetsReader().set(ID, sheet);
  const result = await detectTermWorkbook(reader, ID, options);
  return { result, reader };
}

const forTab = (issues: TemplateIssue[], tab: string) =>
  issues.filter((i) => i.sheetTab === tab).map((i) => i.code);

const criteria = (columns: DetectedColumn[]) =>
  columns
    .filter((c) => c.criterion)
    .map((c) => [c.criterion!.key, c.criterion!.weight, c.criterion!.category]);

describe('detectTermWorkbook – real header shapes', () => {
  it('reads every tab with one metadata and one batched values request', async () => {
    const { result, reader } = await detect();
    expect(result.fatal).toBe(false);
    expect(result.meta).toEqual({ generationCode: 'GEN2027', termNumber: 1 });
    expect(result.rosterTab).toBe('ALL');
    expect(result.tabs.map((t) => t.tabName)).toEqual(['Logic', 'ENG', 'PL', 'BCU', 'MsOffice']);
    expect(reader.calls.map((c) => c.method)).toEqual(['getMetadata', 'readTabs']);
    expect(reader.calls[1]!.tabs).toEqual([
      '_meta',
      'ALL',
      'Logic',
      'ENG',
      'PL',
      'BCU',
      'MsOffice',
    ]);
  });

  it('takes the roster from ALL, ignoring its empty score columns', async () => {
    const { result } = await detect();
    expect(result.roster).toEqual([
      {
        studentCode: 'PNC2027-001',
        firstName: 'DARA',
        lastName: 'SOK',
        fullName: 'DARA SOK',
        gender: 'MALE',
        className: 'A',
        rowNumber: 4,
      },
      expect.objectContaining({ studentCode: 'PNC2027-002', gender: 'FEMALE' }),
      expect.objectContaining({ studentCode: 'PNC2027-003', className: 'B' }),
    ]);
  });

  it('Logic: single header row, weights from labels, cross-check matches the sheet total', async () => {
    const { result } = await detect();
    const logic = result.tabs.find((t) => t.tabName === 'Logic')!.layout!;
    expect(logic.headerRow).toBe(1);
    expect(criteria(logic.columns)).toEqual([
      ['QUIZ_1', '10', 'QUIZ'],
      ['QUIZ_2', '10', 'QUIZ'],
      ['HOMEWORK', '10', 'HOMEWORK'],
      ['PARTICIPATION', '10', 'PARTICIPATION'],
      ['MIDTERM', '25', 'EXAM'],
      ['FINAL', '35', 'EXAM'],
    ]);
    expect(logic.totalWeight).toBe('100');
    expect(logic.crossCheck).toEqual({
      comparableRows: 3,
      mismatchedRows: 0,
      blanksAsZeroRows: 0,
      examples: [],
    });
    expect(logic.columns.find((c) => c.label === 'Total')!.role).toBe('REFERENCE_TOTAL');
    expect(logic.studentRows).toBe(3);
    expect(forTab(result.issues, 'Logic')).toEqual([]);
  });

  it('ENG: three header rows, group weights split equally, duplicate names prefixed', async () => {
    const { result } = await detect();
    const eng = result.tabs.find((t) => t.tabName === 'ENG')!.layout!;
    expect(eng.headerRow).toBe(3);
    expect(criteria(eng.columns)).toEqual([
      ['FINAL_SPEAKING', '10', 'EXAM'],
      ['WRITING', '30', 'EXAM'],
      ['MIDTERM', '25', 'EXAM'],
      ['MIDTERM_SPEAKING', '5', 'EXAM'],
      ['Q1', '5', 'QUIZ'],
      ['ROLE_PLAY', '7.5', 'PROJECT'],
      ['ENGLISH_FOR_IT', '7.5', 'PROJECT'],
      ['HW1', '1.25', 'HOMEWORK'],
      ['HW2', '1.25', 'HOMEWORK'],
      ['HW3', '1.25', 'HOMEWORK'],
      ['GYMGLISH', '1.25', 'HOMEWORK'],
      ['JAN', '1', 'PARTICIPATION'],
      ['FEB', '1', 'PARTICIPATION'],
      ['MAR', '1', 'PARTICIPATION'],
      ['APR', '1', 'PARTICIPATION'],
      ['MAY', '1', 'PARTICIPATION'],
    ]);
    expect(eng.totalWeight).toBe('100');
    const speaking = eng.columns.find((c) => c.criterion?.key === 'FINAL_SPEAKING')!;
    expect(speaking.group).toMatchObject({ rowNumber: 2, name: 'FINAL', weight: '40' });
    expect(speaking.criterion!.name).toBe('FINAL – Speaking');
    expect(eng.columns.find((c) => c.criterion?.key === 'ROLE_PLAY')!.criterion!.weightSource).toBe(
      'GROUP_SHARE',
    );
    // Student 001 has every mark at 80 and TOTAL 80; student 002 has no TOTAL yet.
    expect(eng.crossCheck).toMatchObject({ comparableRows: 1, mismatchedRows: 0 });
    expect(forTab(result.issues, 'ENG')).toEqual([]);
  });

  it('BCU: mistyped name header is ignored, blanks-as-zero totals are detected', async () => {
    const { result } = await detect();
    const bcu = result.tabs.find((t) => t.tabName === 'BCU')!.layout!;
    expect(bcu.columns[1]).toMatchObject({ label: 'f', role: 'IGNORE' });
    expect(criteria(bcu.columns).map(([key, weight]) => [key, weight])).toEqual([
      ['PARTICIPATION', '5'],
      ['QUIZ_1', '10'],
      ['QUIZ_2', '10'],
      ['QUIZ_3', '10'],
      ['MIDTERM', '30'],
      ['FINAL', '35'],
    ]);
    expect(bcu.crossCheck).toEqual({
      comparableRows: 0,
      mismatchedRows: 0,
      blanksAsZeroRows: 2,
      examples: [],
    });
    expect(forTab(result.issues, 'BCU')).toEqual(['UNRECOGNIZED_COLUMN']);
  });

  it('MsOffice: no weights in headers → MISSING_WEIGHT per column, no cross-check', async () => {
    const { result } = await detect();
    const office = result.tabs.find((t) => t.tabName === 'MsOffice')!.layout!;
    expect(criteria(office.columns).map(([key, weight]) => [key, weight])).toEqual([
      ['PARTICIPATIONS', null],
      ['MS_WORD', null],
      ['MS_POWERPOINT', null],
      ['MS_EXCEL', null],
    ]);
    expect(office.totalWeight).toBeNull();
    expect(office.crossCheck).toBeNull();
    expect(forTab(result.issues, 'MsOffice')).toEqual(Array(4).fill('MISSING_WEIGHT'));
  });

  it('PL: GRADE is ignored and COMMENTS is a comment column', async () => {
    const { result } = await detect();
    const pl = result.tabs.find((t) => t.tabName === 'PL')!.layout!;
    expect(pl.columns.slice(9).map((c) => [c.label, c.role])).toEqual([
      ['GRADE', 'IGNORE'],
      ['COMMENTS', 'COMMENT'],
    ]);
    expect(pl.totalWeight).toBe('100');
    expect(pl.crossCheck).toBeNull();
  });

  it('header signatures are stable and change when a teacher edits a header', async () => {
    const first = (await detect()).result.tabs[0]!.layout!.headerSignature;
    const again = (await detect()).result.tabs[0]!.layout!.headerSignature;
    const edited = termWorkbookFixture();
    edited.tabs['Logic']![0]![6] = 'Quiz 2 15%';
    const changed = (await detect(edited)).result.tabs[0]!.layout!.headerSignature;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe('detectTermWorkbook – problems', () => {
  it('warns when the weights disagree with the sheet total', async () => {
    const sheet = termWorkbookFixture();
    sheet.tabs['Logic']![0]![10] = 'FINAL 25%';
    sheet.tabs['Logic']![0]![9] = 'MIDTERM 35%';
    const { result } = await detect(sheet);
    const logic = result.tabs[0]!.layout!;
    expect(logic.crossCheck!.mismatchedRows).toBe(2);
    expect(logic.crossCheck!.examples[0]).toEqual({
      rowNumber: 2,
      sheetTotal: 78.9,
      computed: 77.1,
    });
    expect(forTab(result.issues, 'Logic')).toEqual(['WEIGHTS_DISAGREE_WITH_SHEET_TOTAL']);
  });

  it('warns when weights do not total 100 and when a group does not add up', async () => {
    const sheet = termWorkbookFixture();
    sheet.tabs['PL']![0]![8] = 'Oral communication capstone 40%';
    sheet.tabs['ENG']![2]![7] = 'Midterm (20%)';
    const { result } = await detect(sheet);
    expect(forTab(result.issues, 'PL')).toEqual(['WEIGHTS_NOT_100']);
    // 95% of 80 no longer matches the sheet TOTAL of 80 either.
    expect(forTab(result.issues, 'ENG')).toEqual([
      'GROUP_WEIGHT_MISMATCH',
      'WEIGHTS_NOT_100',
      'WEIGHTS_DISAGREE_WITH_SHEET_TOTAL',
    ]);
  });

  it('splits a group weight that does not divide evenly without losing any of it', async () => {
    const sheet = termWorkbookFixture();
    // Homework (5%) now covers three columns instead of four: 5 / 3 is not a 3-dp number.
    for (const row of sheet.tabs['ENG']!.slice(1)) row.splice(15, 1);
    const { result } = await detect(sheet);
    const eng = result.tabs.find((t) => t.tabName === 'ENG')!.layout!;
    const homework = eng.columns.filter((c) => c.criterion?.key.startsWith('HW'));
    expect(homework.map((c) => c.criterion!.weight)).toEqual(['1.666', '1.667', '1.667']);
    expect(eng.totalWeight).toBe('100');
  });

  it('rejects _meta for another generation or term (FILE)', async () => {
    const { result } = await detect(termWorkbookFixture(), { ...OPTIONS, termNumber: 2 });
    expect(result.fatal).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('TERM_MISMATCH');
    const other = await detect(termWorkbookFixture(), { ...OPTIONS, generationCode: 'GEN2026' });
    expect(other.result.issues.map((i) => i.code)).toContain('GENERATION_MISMATCH');
  });

  it('works without _meta', async () => {
    const sheet = termWorkbookFixture();
    delete sheet.tabs['_meta'];
    const { result } = await detect(sheet);
    expect(result.fatal).toBe(false);
    expect(result.meta).toBeNull();
  });

  it('is fatal without the roster tab but still proposes subject tabs', async () => {
    const sheet = termWorkbookFixture();
    delete sheet.tabs['ALL'];
    const { result } = await detect(sheet);
    expect(result.fatal).toBe(true);
    expect(result.issues[0]).toMatchObject({ code: 'ROSTER_TAB_MISSING', scope: 'FILE' });
    expect(result.tabs).toHaveLength(5);
  });

  it('honours ignored tabs and another roster tab name', async () => {
    const sheet = termWorkbookFixture();
    sheet.tabs['Roster'] = sheet.tabs['ALL']!;
    const { result } = await detect(sheet, {
      ...OPTIONS,
      rosterTab: 'roster',
      ignoredTabs: ['all', 'MsOffice'],
    });
    expect(result.rosterTab).toBe('Roster');
    expect(result.tabs.map((t) => t.tabName)).toEqual(['Logic', 'ENG', 'PL', 'BCU']);
  });

  it('reports a tab without a STUDENT ID header and counts students missing from the roster', async () => {
    const sheet = termWorkbookFixture();
    sheet.tabs['Notes'] = [['Teacher notes'], ['nothing here']];
    sheet.tabs['Logic']!.push(['PNC2027-099', 'NEW', 'STUDENT', 'F', 'A', 50]);
    const { result } = await detect(sheet);
    const notes = result.tabs.find((t) => t.tabName === 'Notes')!;
    expect(notes.layout).toBeNull();
    expect(forTab(result.issues, 'Notes')).toEqual(['MISSING_STUDENT_ID_COLUMN']);
    expect(result.tabs.find((t) => t.tabName === 'Logic')!.unknownStudents).toBe(1);
  });
});

describe('parseRoster', () => {
  it('rejects every copy of a duplicate ID and reports bad rows', () => {
    const log = new IssueLog();
    const roster = parseRoster(
      [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER'],
        ['PNC2027-001', 'A', 'One', 'M'],
        ['pnc2027-001', 'B', 'Two', 'F'],
        ['PNC 2027', 'C', 'Three'],
        [null, 'D', 'Four'],
        ['PNC2027-005', null, null],
        ['PNC2027-006', 'F', 'Six', 'X'],
        [],
      ],
      'ALL',
      log,
    );
    expect(roster!.map((s) => s.studentCode)).toEqual(['PNC2027-006']);
    expect(log.items.map((i) => i.code)).toEqual([
      'INVALID_STUDENT_ID',
      'MISSING_STUDENT_ID',
      'MISSING_STUDENT_NAME',
      'UNKNOWN_GENDER',
      'DUPLICATE_STUDENT',
      'DUPLICATE_STUDENT',
    ]);
  });

  it('needs name columns', () => {
    const log = new IssueLog();
    expect(parseRoster([['STUDENT ID', 'CLASS']], 'ALL', log)).toBeNull();
    expect(log.items[0]).toMatchObject({ scope: 'FILE', code: 'MISSING_COLUMN' });
  });
});

async function bcuMapping() {
  const { result } = await detect();
  const tab = result.tabs.find((t) => t.tabName === 'BCU')!;
  const mapping: SubjectTabMapping = {
    tabName: 'BCU',
    headerRow: tab.layout!.headerRow,
    columns: tab.layout!.columns.map((c) => ({
      columnIndex: c.columnIndex,
      role: c.role,
      criterionKey: c.criterion?.key ?? null,
    })),
  };
  return { mapping, roster: new Map(result.roster.map((s) => [s.studentCode, s])) };
}

describe('parseSubjectRows', () => {
  it('reads marks, blanks, totals and flags names that differ from the roster', async () => {
    const { mapping, roster } = await bcuMapping();
    const log = new IssueLog();
    const rows = parseSubjectRows(termWorkbookFixture().tabs['BCU']!, mapping, roster, log)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.marks.get('FINAL')).toEqual({ status: 'RECORDED', mark: '75' });
    expect(rows[0]!.marks.get('QUIZ_1')).toBe('BLANK');
    expect(rows[0]!.sheetTotal).toBe(26.25);
    // BCU's name column is ignored (mistyped header), but LAST NAME "BOPHA" ≠ roster "CHAN".
    expect(log.items.map((i) => [i.code, i.studentCode])).toEqual([
      ['PROFILE_MISMATCH', 'PNC2027-002'],
    ]);
  });

  it('rejects unknown students, duplicates and invalid marks', async () => {
    const { mapping, roster } = await bcuMapping();
    const grid = termWorkbookFixture().tabs['BCU']!;
    grid.push(['PNC2027-099', 'X', 'Y', 'F', 'A', 50]);
    grid.push(['PNC2027-001', 'DARA', 'SOK', 'M', 'A', 'abc', 120, 'ABS']);
    grid.push([null, null, null, null, null, 40]);
    const log = new IssueLog();
    const rows = parseSubjectRows(grid, mapping, roster, log)!;
    expect(rows.map((r) => r.studentCode)).toEqual(['PNC2027-002']);
    expect(log.items.map((i) => i.code)).toEqual([
      'PROFILE_MISMATCH',
      'UNKNOWN_STUDENT',
      'INVALID_MARK',
      'INVALID_MARK',
      'MISSING_STUDENT_ID',
      'DUPLICATE_ROW',
      'DUPLICATE_ROW',
    ]);
  });

  it('keeps teacher comments', async () => {
    const { result } = await detect();
    const pl = result.tabs.find((t) => t.tabName === 'PL')!.layout!;
    const rows = parseSubjectRows(
      termWorkbookFixture().tabs['PL']!,
      {
        tabName: 'PL',
        headerRow: pl.headerRow,
        columns: pl.columns.map((c) => ({
          columnIndex: c.columnIndex,
          role: c.role,
          criterionKey: c.criterion?.key ?? null,
        })),
      },
      new Map(result.roster.map((s) => [s.studentCode, s])),
      new IssueLog(),
    )!;
    expect(rows.map((r) => r.comment)).toEqual(['Works well in a team.', null, null]);
  });
});

describe('checkTermWorkbook', () => {
  it('reads only metadata and _meta', async () => {
    const reader = new InMemorySheetsReader().set(ID, termWorkbookFixture());
    const check = await checkTermWorkbook(reader, ID, OPTIONS);
    expect(check).toEqual({
      spreadsheetTitle: 'TERM1- GEN 2027 Scoring',
      tabs: ['_meta', 'ALL', 'Logic', 'ENG', 'PL', 'BCU', 'MsOffice'],
      ok: true,
      issues: [],
    });
    expect(reader.calls.map((c) => c.tabs ?? [])).toEqual([[], ['_meta']]);
  });

  it('fails without the roster tab or for another term', async () => {
    const sheet = termWorkbookFixture();
    delete sheet.tabs['ALL'];
    const reader = new InMemorySheetsReader().set(ID, sheet);
    const check = await checkTermWorkbook(reader, ID, { ...OPTIONS, termNumber: 3 });
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.code)).toEqual(['ROSTER_TAB_MISSING', 'TERM_MISMATCH']);
  });
});
