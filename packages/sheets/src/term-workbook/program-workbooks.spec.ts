import { InMemorySheetsReader } from '../testing/in-memory-reader.js';
import {
  PROGRAM_T1_SPREADSHEET_ID as T1,
  PROGRAM_T2_SPREADSHEET_ID as T2,
  programTerm1Workbook,
  programTerm2Workbook,
} from '../testing/program-workbooks-fixture.js';
import { keyFromName } from './labels.js';
import { isRowNumbering } from './layout.js';
import { detectTermWorkbook, readTermWorkbook, type ConfirmedTab } from './read.js';

const reader = () =>
  new InMemorySheetsReader().set(T1, programTerm1Workbook()).set(T2, programTerm2Workbook());

const options = (termNumber: number) => ({ generationCode: 'GEN2027', termNumber });

/** Every subject tab confirmed exactly as detected. */
async function readAll(r: InMemorySheetsReader, id: string, termNumber: number) {
  const detection = await detectTermWorkbook(r, id, options(termNumber));
  const confirmed: ConfirmedTab[] = detection.tabs.flatMap((tab) => {
    const layout = tab.layout;
    if (!layout) return [];
    let order = 0;
    return [
      {
        offeringId: `offering-${tab.tabName}`,
        courseKey: keyFromName(tab.tabName),
        title: tab.tabName,
        tabName: tab.tabName,
        sheetTabId: tab.sheetTabId,
        headerRow: layout.headerRow,
        headerSignature: layout.headerSignature,
        columns: layout.columns.map((c) => ({
          columnIndex: c.columnIndex,
          role: c.role,
          criterion: c.criterion
            ? { ...c.criterion, weight: c.criterion.weight ?? '0', order: ++order }
            : null,
        })),
      },
    ];
  });
  return { detection, read: await readTermWorkbook(r, id, options(termNumber), confirmed) };
}

const codes = (issues: { code: string; sheetTab?: string }[], tab?: string) => {
  const out: Record<string, number> = {};
  for (const i of issues.filter((x) => !tab || x.sheetTab === tab)) {
    out[i.code] = (out[i.code] ?? 0) + 1;
  }
  return out;
};

describe('program workbooks: detection', () => {
  it('recognises MAJOR as the program and #N / "Column 1" as row numbers, with no warning', async () => {
    const { detection } = await readAll(reader(), T2, 2);
    expect(codes(detection.issues)).toEqual({});
    const roles = (tab: string) =>
      Object.fromEntries(
        detection.tabs
          .find((t) => t.tabName === tab)!
          .layout!.columns.map((c) => [c.label ?? `(${c.columnIndex})`, c.role]),
      );
    expect(roles('PL')).toMatchObject({ '#N': 'ROW_NUMBER', MAJOR: 'PROGRAM', CLASS: 'CLASS' });
    expect(roles('CCNA1')).toMatchObject({ 'Column 1': 'ROW_NUMBER', MAJOR: 'PROGRAM' });
  });

  it('counts the roster classes of the students in each tab, to propose an audience', async () => {
    const { detection } = await readAll(reader(), T2, 2);
    const classes = Object.fromEntries(detection.tabs.map((t) => [t.tabName, t.rosterClasses]));
    expect(classes['CCNA1']).toEqual({ D: 25 });
    expect(classes['Algorithm']).toEqual({ A: 25, B: 25, C: 25 });
    expect(classes['ENG']).toEqual({ A: 25, B: 25, C: 25, D: 25 });
  });

  it('a generic header over real marks stays a mark column', async () => {
    const sheet = programTerm2Workbook();
    const pl = sheet.tabs['PL']!;
    pl[2]![0] = 'Column 1';
    pl.slice(3).forEach((row, k) => (row[0] = k % 2 ? 70 : 80));
    const r = new InMemorySheetsReader().set(T2, sheet);
    const { detection } = await readAll(r, T2, 2);
    const col = detection.tabs.find((t) => t.tabName === 'PL')!.layout!.columns[0]!;
    expect(col.role).toBe('CRITERION');
  });
});

describe('program workbooks: sync read', () => {
  it('Term 2: swapped names are silent, Web Design is blocked by the 20% rule', async () => {
    const { read } = await readAll(reader(), T2, 2);
    expect(read.roster).toHaveLength(100);
    expect(read.roster.find((s) => s.studentCode === 'PNC2027-001')?.programText).toMatch(
      /^(WEP [ABC]|SNAC)$/,
    );
    expect(codes(read.issues)).toEqual({ IDENTITY_MISMATCH_TAB: 1 });
    expect(read.issues[0]).toMatchObject({
      severity: 'ERROR',
      scope: 'COURSE',
      sheetTab: 'Web Design',
    });
    expect(read.issues[0]!.message).toMatch(/^74 of 75 rows/);
    const rows = Object.fromEntries(read.courses.map((c) => [c.worksheet, c.rows.length]));
    expect(rows).toEqual({ ENG: 100, PL: 100, Algorithm: 75, CCNA1: 25 });
    const eng = read.courses.find((c) => c.worksheet === 'ENG')!;
    expect(new Set(eng.rows.map((r) => r.programText))).toEqual(new Set(['WEP', 'SNAC']));
  });

  it("Term 2: a few rows with another student's name are rejected, the rest import", async () => {
    const sheet = programTerm2Workbook();
    const algo = sheet.tabs['Algorithm']!;
    const [a, b] = [algo[3]!, algo[4]!];
    [a[2], a[3], b[2], b[3]] = [b[2]!, b[3]!, a[2]!, a[3]!]; // two rows trade names
    const { read } = await readAll(new InMemorySheetsReader().set(T2, sheet), T2, 2);
    const errors = read.issues.filter((i) => i.code === 'IDENTITY_MISMATCH');
    expect(errors.map((e) => [e.rowNumber, e.studentCode])).toEqual([
      [4, a[1]],
      [5, b[1]],
    ]);
    expect(errors[0]!.message).toContain(String(b[1]));
    expect(read.courses.find((c) => c.worksheet === 'Algorithm')!.rows).toHaveLength(73);
  });

  it('Term 1: a class differing from ALL warns and imports; a name nobody has warns', async () => {
    const { read } = await readAll(reader(), T1, 1);
    expect(read.roster).toHaveLength(101);
    const mismatches = read.issues.filter((i) => i.code === 'PROFILE_MISMATCH');
    expect(
      mismatches
        .filter((i) => i.columnKey === 'CLASS')
        .map((i) => `${i.sheetTab} ${i.studentCode}`),
    ).toEqual(['ENG PNC2027-051', 'ENG PNC2027-076', 'PL PNC2027-051', 'PL PNC2027-076']);
    expect(mismatches.filter((i) => i.columnKey !== 'CLASS').map((i) => i.studentCode)).toEqual([
      'PNC2027-010',
    ]);
    expect(read.issues).toHaveLength(5);
    const rows = Object.fromEntries(read.courses.map((c) => [c.worksheet, c.rows.length]));
    expect(rows).toEqual({ ENG: 101, PL: 101 });
  });

  it('keeps every copy of a duplicated roster ID, with its values, for the admin', async () => {
    const sheet = programTerm2Workbook();
    const copy = [...sheet.tabs['ALL']![3]!];
    copy[9] = 'Z';
    sheet.tabs['ALL']!.push(copy);
    const { read } = await readAll(new InMemorySheetsReader().set(T2, sheet), T2, 2);
    expect(read.roster).toHaveLength(99);
    expect(read.rosterDuplicates).toHaveLength(1);
    expect(read.rosterDuplicates[0]!.map((s) => s.className)).toEqual([
      sheet.tabs['ALL']![3]![9],
      'Z',
    ]);
  });
});

describe('isRowNumbering', () => {
  it('needs consecutive whole numbers on every row', () => {
    expect(isRowNumbering([1, 2, 3])).toBe(true);
    expect(isRowNumbering([5, 6, '7'])).toBe(true);
    expect(isRowNumbering([1, 3])).toBe(false);
    expect(isRowNumbering([1, null, 3])).toBe(false);
    expect(isRowNumbering([1])).toBe(false);
    expect(isRowNumbering([1.5, 2.5])).toBe(false);
  });
});
