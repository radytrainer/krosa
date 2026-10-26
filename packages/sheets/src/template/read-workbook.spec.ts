import type { CellValue } from '../reader.js';
import { InMemorySheetsReader, type FakeSpreadsheet } from '../testing/in-memory-reader.js';
import {
  cloneSpreadsheet,
  FIXTURE_GENERATION_CODE,
  FIXTURE_SPREADSHEET_ID,
  workbookFixture,
} from '../testing/fixtures.js';
import type { TemplateIssue } from './issues.js';
import { checkTemplate, readWorkbook } from './read-workbook.js';

const ID = FIXTURE_SPREADSHEET_ID;

async function read(sheet: FakeSpreadsheet, generationCode = FIXTURE_GENERATION_CODE) {
  const reader = new InMemorySheetsReader().set(ID, sheet);
  const result = await readWorkbook(reader, ID, generationCode);
  return { result, reader };
}

function edit(mutate: (tabs: FakeSpreadsheet['tabs']) => void): FakeSpreadsheet {
  const sheet = cloneSpreadsheet(workbookFixture());
  mutate(sheet.tabs);
  return sheet;
}

const codes = (issues: TemplateIssue[], severity?: 'ERROR' | 'WARNING') =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

function setCell(
  tabs: FakeSpreadsheet['tabs'],
  tab: string,
  row: number,
  col: number,
  value: CellValue,
) {
  const grid = tabs[tab]!;
  while (grid.length < row) grid.push([]);
  const r = grid[row - 1]!;
  while (r.length < col) r.push(null);
  r[col - 1] = value;
}

describe('readWorkbook – valid fixture', () => {
  it('parses everything with three requests and no issues', async () => {
    const { result, reader } = await read(workbookFixture());
    expect(result.fatal).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.meta).toEqual({ templateVersion: 1, generationCode: 'GEN2026' });
    expect(result.stats).toEqual({
      students: 3,
      courses: 2,
      coursesWithValidScheme: 2,
      markRows: 6,
      marks: 29,
      blankMarks: 1,
      errors: 0,
      warnings: 0,
    });
    expect(reader.calls.map((c) => c.method)).toEqual(['getMetadata', 'readTabs', 'readTabs']);
    expect(reader.calls[2]!.tabs).toEqual(['T1 Math', 'T2 English']);
  });

  it('maps marks, ABS and blanks without inventing zeros', async () => {
    const { result } = await read(workbookFixture());
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    expect(math).toMatchObject({
      termNumber: 1,
      courseCode: 'MATH101',
      credits: '3',
      visible: true,
      schemeValid: true,
    });
    expect(math.criteria.map((c) => [c.key, c.maxMark, c.weight])).toEqual([
      ['Q1', '10', '5'],
      ['Q2', '10', '5'],
      ['MID', '50', '30'],
      ['FINAL', '100', '40'],
      ['HW', '10', '10'],
      ['PART', '10', '10'],
    ]);
    const b = math.rows.find((r) => r.studentCode === 'GEN26-0002')!;
    expect(b.rowNumber).toBe(4);
    expect(b.marks.get('Q2')).toEqual({ status: 'ABSENT', mark: '0' });
    expect(b.marks.get('MID')).toEqual({ status: 'RECORDED', mark: '38' });

    const eng = result.courses.find((c) => c.courseKey === 'T2-ENG101')!;
    expect(eng.visible).toBe(false);
    expect(eng.rows.find((r) => r.studentCode === 'GEN26-0003')!.marks.get('FINAL')).toBe('BLANK');
    expect(eng.rows.find((r) => r.studentCode === 'GEN26-0002')!.marks.get('PROJECT')).toEqual({
      status: 'RECORDED',
      mark: '70.25',
    });
    expect(result.students.find((s) => s.studentCode === 'GEN26-0003')).toMatchObject({
      gender: 'UNSPECIFIED',
      className: 'B',
    });
  });

  it('tolerates whitespace, case, reordered columns and blank rows', async () => {
    const sheet = edit((tabs) => {
      tabs['Students'] = [
        ['  CLASS ', 'Student_Name', 'STUDENT_ID'],
        ['A', ' Example Student A ', ' gen26-0001 '],
        [],
        [null, '', '   '],
        ['A', 'Example Student B', 'GEN26-0002'],
        ['B', 'Example Student C', 'GEN26-0003'],
      ];
      tabs['T1 Math']![0] = ['part', 'hw', 'final', 'mid', 'q2', 'q1', 'STUDENT_ID'];
      tabs['T1 Math']!.splice(
        2,
        3,
        [10, 9, 72, 41.5, 9, 8, ' GEN26-0001'],
        [],
        [10, 10, 100, 50, 10, 10, 'GEN26-0003'],
      );
      tabs['  t1 MATH '] = tabs['T1 Math']!;
      delete tabs['T1 Math'];
      tabs['Courses']![1]![5] = 't1 math';
    });
    const { result } = await read(sheet);
    expect(codes(result.issues, 'ERROR')).toEqual([]);
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    expect(math.worksheet).toBe('  t1 MATH ');
    const a = math.rows.find((r) => r.studentCode === 'GEN26-0001')!;
    expect(a.marks.get('Q1')).toEqual({ status: 'RECORDED', mark: '8' });
    expect(a.marks.get('PART')).toEqual({ status: 'RECORDED', mark: '10' });
    expect(math.rows).toHaveLength(2);
  });
});

describe('checkTemplate', () => {
  it('passes a valid workbook with two requests', async () => {
    const reader = new InMemorySheetsReader().set(ID, workbookFixture());
    const result = await checkTemplate(reader, ID, 'GEN2026');
    expect(result).toEqual({ spreadsheetTitle: 'Scores GEN2026 (fixture)', ok: true, issues: [] });
    expect(reader.calls.map((c) => c.method)).toEqual(['getMetadata', 'readTabs']);
  });

  it('reports missing tabs and generation mismatches', async () => {
    const reader = new InMemorySheetsReader().set(
      ID,
      edit((tabs) => delete tabs['Courses']),
    );
    const result = await checkTemplate(reader, ID, 'GEN2030');
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toEqual(['TEMPLATE_TAB_MISSING', 'GENERATION_MISMATCH']);
  });
});

describe('readWorkbook – file-level errors abort everything', () => {
  it('requires every template tab', async () => {
    const { result, reader } = await read(edit((tabs) => delete tabs['Criteria']));
    expect(result.fatal).toBe(true);
    expect(codes(result.issues)).toEqual(['TEMPLATE_TAB_MISSING']);
    expect(result.courses).toEqual([]);
    expect(reader.calls.filter((c) => c.method === 'readTabs')).toHaveLength(0);
  });

  it('rejects a spreadsheet that belongs to another generation', async () => {
    const { result } = await read(workbookFixture(), 'GEN2027');
    expect(result.fatal).toBe(true);
    expect(codes(result.issues)).toEqual(['GENERATION_MISMATCH']);
    expect(result.students).toEqual([]);
  });

  it('compares generation codes case-insensitively', async () => {
    const { result } = await read(workbookFixture(), 'gen2026');
    expect(result.fatal).toBe(false);
  });

  it('rejects unsupported template versions and missing generation codes', async () => {
    const { result } = await read(
      edit((tabs) => {
        tabs['_meta'] = [['template_version', 2]];
      }),
    );
    expect(result.fatal).toBe(true);
    expect(codes(result.issues)).toEqual([
      'UNSUPPORTED_TEMPLATE_VERSION',
      'GENERATION_CODE_MISSING',
    ]);
  });

  it('requires mandatory columns in fixed tabs', async () => {
    const { result } = await read(edit((tabs) => (tabs['Criteria']![0]![5] = 'weighting')));
    expect(result.fatal).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_COLUMN',
        sheetTab: 'Criteria',
        columnKey: 'weight',
      }),
    );
  });
});

describe('readWorkbook – roster', () => {
  it('rejects every copy of a duplicated student and their mark rows', async () => {
    const { result } = await read(
      edit((tabs) => tabs['Students']!.push(['gen26-0002', 'Someone Else', 'M', 'C'])),
    );
    expect(result.fatal).toBe(false);
    expect(result.students.map((s) => s.studentCode)).toEqual(['GEN26-0001', 'GEN26-0003']);
    expect(codes(result.issues).filter((c) => c === 'DUPLICATE_STUDENT')).toHaveLength(2);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_STUDENT', studentCode: 'GEN26-0002' }),
    );
    expect(result.courses[0]!.rows.map((r) => r.studentCode)).not.toContain('GEN26-0002');
  });

  it('reports invalid IDs, missing names and unknown genders', async () => {
    const { result } = await read(
      edit((tabs) => {
        tabs['Students']!.push(
          ['ST 004', 'Spaced Id', 'F', 'A'],
          ['GEN26-0005', '', 'F', 'A'],
          ['GEN26-0006', 'Example Student F', 'unknown', 'A'],
        );
      }),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_STUDENT_ID', rowNumber: 5, rawValue: 'ST 004' }),
        expect.objectContaining({
          code: 'MISSING_STUDENT_NAME',
          rowNumber: 6,
          studentCode: 'GEN26-0005',
        }),
        expect.objectContaining({ code: 'UNKNOWN_GENDER', severity: 'WARNING', rowNumber: 7 }),
      ]),
    );
    expect(result.students.map((s) => s.studentCode)).toContain('GEN26-0006');
  });
});

describe('readWorkbook – courses & criteria', () => {
  it('rejects only the affected course for course-level errors', async () => {
    const { result } = await read(edit((tabs) => (tabs['Courses']![2]![1] = 6)));
    expect(result.fatal).toBe(false);
    expect(result.courses.map((c) => c.courseKey)).toEqual(['T1-MATH101']);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_TERM', courseKey: 'T2-ENG101', rowNumber: 3 }),
    );
  });

  it('rejects duplicated course keys, term+course pairs and shared worksheets', async () => {
    const dupKey = await read(
      edit((tabs) =>
        tabs['Courses']!.push(['t1-math101', 3, 'MATH201', 'Other', 1, 'T2 English', true]),
      ),
    );
    expect(dupKey.result.courses.map((c) => c.courseKey)).toEqual([]);
    expect(codes(dupKey.result.issues)).toEqual(
      expect.arrayContaining(['DUPLICATE_COURSE', 'DUPLICATE_WORKSHEET']),
    );

    const dupTerm = await read(
      edit(
        (tabs) =>
          (tabs['Courses']![2] = ['T1-OTHER', 1, 'MATH101', 'Again', 1, 'T2 English', true]),
      ),
    );
    expect(dupTerm.result.courses).toEqual([]);
  });

  it('requires worksheets to exist and not be template tabs', async () => {
    const missing = await read(edit((tabs) => (tabs['Courses']![1]![5] = 'No Such Tab')));
    expect(missing.result.issues).toContainEqual(
      expect.objectContaining({ code: 'WORKSHEET_NOT_FOUND', courseKey: 'T1-MATH101' }),
    );
    const reserved = await read(edit((tabs) => (tabs['Courses']![1]![5] = 'Students')));
    expect(reserved.result.courses.map((c) => c.courseKey)).toEqual(['T2-ENG101']);
  });

  it('validates credits and treats unrecognized visibility as hidden with a warning', async () => {
    const credits = await read(edit((tabs) => (tabs['Courses']![1]![4] = 0)));
    expect(credits.result.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_CREDITS' }),
    );
    const visible = await read(edit((tabs) => (tabs['Courses']![1]![6] = 'sometimes')));
    expect(visible.result.courses[0]!.visible).toBeNull();
    expect(visible.result.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_VISIBLE', severity: 'WARNING' }),
    );
  });

  it('imports marks but not the scheme when weights do not total 100', async () => {
    const { result } = await read(edit((tabs) => (tabs['Criteria']![1]![5] = 6)));
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    expect(math.schemeValid).toBe(false);
    expect(math.rows).toHaveLength(3);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'WEIGHTS_NOT_100',
        scope: 'COURSE',
        courseKey: 'T1-MATH101',
      }),
    );
    expect(result.issues.find((i) => i.code === 'WEIGHTS_NOT_100')!.message).toContain('101.000');
  });

  it('rejects a course with invalid or duplicate criteria', async () => {
    const badMax = await read(edit((tabs) => (tabs['Criteria']![1]![4] = 0)));
    expect(badMax.result.courses.map((c) => c.courseKey)).toEqual(['T2-ENG101']);
    expect(codes(badMax.result.issues)).toContain('INVALID_MAX_MARK');

    const badWeight = await read(edit((tabs) => (tabs['Criteria']![1]![5] = '5,5')));
    expect(codes(badWeight.result.issues)).toContain('INVALID_WEIGHT');

    const dup = await read(
      edit((tabs) =>
        tabs['Criteria']!.push(['T1-MATH101', 'q1', 'Quiz 1 again', 'QUIZ', 10, 1, 7, '']),
      ),
    );
    expect(dup.result.courses.map((c) => c.courseKey)).toEqual(['T2-ENG101']);
    expect(codes(dup.result.issues).filter((c) => c === 'DUPLICATE_CRITERION')).toHaveLength(2);

    const badKey = await read(edit((tabs) => (tabs['Criteria']![1]![1] = '1Q')));
    expect(codes(badKey.result.issues)).toContain('INVALID_CRITERION_KEY');
  });

  it('reports criteria for unknown courses and courses without criteria', async () => {
    const { result } = await read(
      edit((tabs) => {
        tabs['Criteria']!.push(['T9-NOPE', 'Q1', 'Quiz', 'QUIZ', 10, 100, 1, '']);
        tabs['Criteria'] = tabs['Criteria']!.filter((r) => r[0] !== 'T2-ENG101');
      }),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_COURSE', rawValue: 'T9-NOPE' }),
        expect.objectContaining({ code: 'NO_CRITERIA', courseKey: 'T2-ENG101' }),
      ]),
    );
  });

  it('orders criteria by the order column and defaults unknown categories', async () => {
    const { result } = await read(
      edit((tabs) => {
        tabs['Criteria']![1]![6] = 99;
        tabs['Criteria']![2]![3] = 'POP QUIZ';
      }),
    );
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    expect(math.criteria.at(-1)!.key).toBe('Q1');
    expect(math.criteria.find((c) => c.key === 'Q2')!.category).toBe('OTHER');
    expect(codes(result.issues, 'WARNING')).toContain('UNKNOWN_CATEGORY');
  });
});

describe('readWorkbook – mark tabs', () => {
  it('rejects the course when row 1 has an unknown or duplicated key (no guessing)', async () => {
    const unknown = await read(edit((tabs) => (tabs['T1 Math']![0]![4] = 'MIDTERM')));
    expect(unknown.result.courses.map((c) => c.courseKey)).toEqual(['T2-ENG101']);
    expect(unknown.result.issues).toContainEqual(
      expect.objectContaining({
        code: 'UNKNOWN_COLUMN',
        columnKey: 'MIDTERM',
        sheetTab: 'T1 Math',
        rowNumber: 1,
      }),
    );
    const dup = await read(edit((tabs) => (tabs['T1 Math']![0]![3] = 'q1')));
    expect(codes(dup.result.issues)).toContain('DUPLICATE_COLUMN');
  });

  it('requires a student_id column', async () => {
    const { result } = await read(edit((tabs) => (tabs['T2 English']![0]![0] = 'id')));
    expect(codes(result.issues)).toEqual(
      expect.arrayContaining(['UNKNOWN_COLUMN', 'MISSING_STUDENT_ID_COLUMN']),
    );
  });

  it('allows unlabeled note columns and warns about criteria without a column', async () => {
    const { result } = await read(
      edit((tabs) => {
        // Drop the PART column; add a notes column whose row-1 key is empty (label in row 2).
        tabs['T2 English'] = tabs['T2 English']!.map((r, i) => [
          r[0]!,
          r[1]!,
          r[2]!,
          r[3]!,
          i === 0 ? null : i === 1 ? 'Teacher notes' : 'keep practising',
        ]);
      }),
    );
    const eng = result.courses.find((c) => c.courseKey === 'T2-ENG101')!;
    expect(eng.rows[0]!.marks.has('PART')).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_CRITERION_COLUMN',
        severity: 'WARNING',
        criterionKey: 'PART',
      }),
    );
  });

  it('skips invalid cells but keeps the rest of the row', async () => {
    const { result } = await read(
      edit((tabs) => {
        setCell(tabs, 'T1 Math', 3, 3, 11); // Q1 > max 10
        setCell(tabs, 'T1 Math', 3, 5, '41,5'); // comma decimal
        setCell(tabs, 'T1 Math', 4, 4, 'EX'); // excused is not supported (A7)
      }),
    );
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    const a = math.rows.find((r) => r.studentCode === 'GEN26-0001')!;
    expect(a.marks.has('Q1')).toBe(false);
    expect(a.marks.has('MID')).toBe(false);
    expect(a.marks.get('FINAL')).toEqual({ status: 'RECORDED', mark: '72' });
    expect(
      result.issues
        .filter((i) => i.code === 'INVALID_MARK')
        .map((i) => [i.rowNumber, i.criterionKey, i.rawValue]),
    ).toEqual([
      [3, 'Q1', '11'],
      [3, 'MID', '41,5'],
      [4, 'Q2', 'EX'],
    ]);
  });

  it('rejects unknown students, invalid IDs and duplicated rows', async () => {
    const { result } = await read(
      edit((tabs) => {
        tabs['T1 Math']!.push(
          ['GEN26-0099', 'Nobody', 1, 1, 1, 1, 1, 1],
          ['', 'No id', 1],
          ['gen26-0003', 'Example Student C', 1, 1, 1, 1, 1, 1],
        );
      }),
    );
    const math = result.courses.find((c) => c.courseKey === 'T1-MATH101')!;
    expect(math.rows.map((r) => r.studentCode)).toEqual(['GEN26-0001', 'GEN26-0002']);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNKNOWN_STUDENT',
          studentCode: 'GEN26-0099',
          rowNumber: 6,
        }),
        expect.objectContaining({ code: 'INVALID_STUDENT_ID', rowNumber: 7 }),
        expect.objectContaining({ code: 'DUPLICATE_ROW', rowNumber: 5 }),
        expect.objectContaining({ code: 'DUPLICATE_ROW', rowNumber: 8 }),
      ]),
    );
  });

  it('warns when a mark tab name disagrees with the roster', async () => {
    const { result } = await read(edit((tabs) => setCell(tabs, 'T1 Math', 3, 2, 'Somebody Else')));
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'PROFILE_MISMATCH',
        severity: 'WARNING',
        studentCode: 'GEN26-0001',
      }),
    );
  });

  it('warns about tabs that are not referenced', async () => {
    const { result } = await read(edit((tabs) => (tabs['Scratch'] = [['x']])));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'IGNORED_TAB', sheetTab: 'Scratch', severity: 'WARNING' }),
    ]);
  });

  it('propagates access errors from the reader', async () => {
    const reader = new InMemorySheetsReader().fail(ID, 'SHEET_NOT_SHARED');
    await expect(readWorkbook(reader, ID, 'GEN2026')).rejects.toMatchObject({
      code: 'SHEET_NOT_SHARED',
    });
  });
});
