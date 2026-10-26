import type { Grid } from '../reader.js';
import type { FakeSpreadsheet } from './in-memory-reader.js';

/** A syntactically valid spreadsheet ID for fixtures. */
export const FIXTURE_SPREADSHEET_ID = '1FixtureSpreadsheetId0000000000000000000000';
export const FIXTURE_GENERATION_CODE = 'GEN2026';

/**
 * A complete, valid workbook following docs/google-sheets-template.md, with synthetic people
 * only. Tests copy it and break specific parts.
 *
 * - 3 students; 2 courses in terms 1 and 2.
 * - T1-MATH101: Q1 Q2 MID FINAL HW PART (5/5/30/40/10/10), visible.
 * - T2-ENG101: PROJECT MID FINAL PART (30/30/30/10), hidden; GEN26-0003 has a blank FINAL.
 */
export function workbookFixture(generationCode = FIXTURE_GENERATION_CODE): FakeSpreadsheet {
  const tabs: Record<string, Grid> = {
    _meta: [
      ['key', 'value'],
      ['template_version', 1],
      ['generation_code', generationCode],
    ],
    Students: [
      ['student_id', 'student_name', 'gender', 'class'],
      ['GEN26-0001', 'Example Student A', 'F', 'A'],
      ['GEN26-0002', 'Example Student B', 'M', 'A'],
      ['GEN26-0003', 'Example Student C', '', 'B'],
    ],
    Courses: [
      ['course_key', 'term', 'course_code', 'course_name', 'credits', 'worksheet', 'visible'],
      ['T1-MATH101', 1, 'MATH101', 'Mathematics I', 3, 'T1 Math', true],
      ['T2-ENG101', 2, 'ENG101', 'English I', 2, 'T2 English', false],
    ],
    Criteria: [
      [
        'course_key',
        'criterion_key',
        'criterion_name',
        'category',
        'max_mark',
        'weight',
        'order',
        'description',
      ],
      ['T1-MATH101', 'Q1', 'Quiz 1', 'QUIZ', 10, 5, 1, ''],
      ['T1-MATH101', 'Q2', 'Quiz 2', 'QUIZ', 10, 5, 2, ''],
      ['T1-MATH101', 'MID', 'Midterm Exam', 'EXAM', 50, 30, 3, ''],
      ['T1-MATH101', 'FINAL', 'Final Exam', 'EXAM', 100, 40, 4, ''],
      ['T1-MATH101', 'HW', 'Homework', 'HOMEWORK', 10, 10, 5, ''],
      ['T1-MATH101', 'PART', 'Participation', 'PARTICIPATION', 10, 10, 6, ''],
      ['T2-ENG101', 'PROJECT', 'Project', 'PROJECT', 100, 30, 1, ''],
      ['T2-ENG101', 'MID', 'Midterm Exam', 'EXAM', 50, 30, 2, ''],
      ['T2-ENG101', 'FINAL', 'Final Exam', 'EXAM', 50, 30, 3, ''],
      ['T2-ENG101', 'PART', 'Participation', 'PARTICIPATION', 10, 10, 4, ''],
    ],
    'T1 Math': [
      ['student_id', 'student_name', 'Q1', 'Q2', 'MID', 'FINAL', 'HW', 'PART'],
      ['Student ID', 'Name', 'Quiz 1', 'Quiz 2', 'Midterm', 'Final', 'Homework', 'Participation'],
      ['GEN26-0001', 'Example Student A', 8, 9, 41.5, 72, 9, 10],
      ['GEN26-0002', 'Example Student B', 7, 'ABS', 38, 80, 8, 9],
      ['GEN26-0003', 'Example Student C', 10, 10, 50, 100, 10, 10],
    ],
    'T2 English': [
      ['student_id', 'PROJECT', 'MID', 'FINAL', 'PART'],
      ['Student ID', 'Project', 'Midterm', 'Final', 'Participation'],
      ['GEN26-0001', 85, 40, 45, 9],
      ['GEN26-0002', 70.25, 35, 40, 8],
      ['GEN26-0003', 90, 44, null, 10],
    ],
  };
  return { title: `Scores ${generationCode} (fixture)`, tabs };
}

/** Deep copy so tests can modify a fixture freely. */
export function cloneSpreadsheet(sheet: FakeSpreadsheet): FakeSpreadsheet {
  return {
    title: sheet.title,
    tabs: Object.fromEntries(
      Object.entries(sheet.tabs).map(([k, grid]) => [k, grid.map((r) => [...r])]),
    ),
  };
}
