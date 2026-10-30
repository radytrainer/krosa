import type { Grid } from '../reader.js';
import type { FakeSpreadsheet } from './in-memory-reader.js';

/**
 * A term workbook with the same header shapes as the school's real GEN2027 Term 1 file
 * (docs/delivery-plan-2027.md): weights inside labels, three header rows in ENG/ALL, a
 * mistyped "f" header in BCU, no weights in MsOffice. Names and marks are synthetic.
 */
export const TERM_FIXTURE_SPREADSHEET_ID = '1TermWorkbookFixture00000000000000000000';
export const TERM_FIXTURE_GENERATION_CODE = 'GEN2027';
export const TERM_FIXTURE_TERM = 1;
/** A replacement workbook for the same term, for changing a term's sheet. */
export const TERM_FIXTURE_REPLACEMENT_ID = '1TermWorkbookReplacement0000000000000000';

const STUDENTS = [
  ['PNC2027-001', 'DARA', 'SOK', 'M', 'A'],
  ['PNC2027-002', 'BOPHA', 'CHAN', 'F', 'A'],
  ['PNC2027-003', 'RITHY', 'KEO', 'M', 'B'],
] as const;
const profile = (i: number) => [...(STUDENTS[i] ?? [])];
const PROFILE_HEADER = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];

const ENG_GROUPS: Grid = [
  [null, '   ', null, null, null, 'EXAMS (60%)'],
  [
    null,
    null,
    null,
    null,
    null,
    'FINAL (40%)',
    null,
    'MIDTERM (30%)',
    null,
    'Quizzes (5%)',
    'Projects (15%)',
    null,
    'Homework (5%)',
    null,
    null,
    null,
    'Class participation (5%)',
  ],
];
const ENG_HEADER = [
  ...PROFILE_HEADER,
  'Speaking (10%)',
  'Writing (30%)',
  'Midterm (25%)',
  'Speaking (5%)',
  'Q1',
  'Role Play',
  'English for IT',
  'HW1',
  'HW2',
  'HW3',
  'Gymglish ',
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'TOTAL',
  'GRADE',
  'COMMENTS',
];

/** A fresh copy on every call: tests edit the grids, and ALL shares rows with ENG. */
export function termWorkbookFixture(): FakeSpreadsheet {
  return structuredClone({
    title: 'TERM1- GEN 2027 Scoring',
    tabs: {
      _meta: [
        ['key', 'value'],
        ['template_version', 1],
        ['generation_code', 'GEN2027'],
        ['education_term', 1],
      ],
      ALL: [...ENG_GROUPS, ENG_HEADER, profile(0), profile(1), profile(2)],
      Logic: [
        [
          ...PROFILE_HEADER,
          'Quiz 1 10%',
          'Quiz 2 10%',
          'Homework 10%',
          'Participation 10%',
          'MIDTERM 25%',
          'FINAL 35%',
          'Total',
          'COMMENTS',
        ],
        [...profile(0), 90, 89, 90, 97, 60, 78, 78.9],
        [...profile(1), 80, 70, 80, 80, 50, 60, 64.5],
        [...profile(2), 70, 70, 70, 70, 70, 70, 70],
      ],
      ENG: [
        ...ENG_GROUPS,
        ENG_HEADER,
        [...profile(0), 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80],
        [...profile(1), 46, 79, 45.5, 44, 56, 70, 70, 70, 50, 80, 98, 90, 90, 80, 75, 80],
      ],
      PL: [
        [
          ...PROFILE_HEADER,
          'Quiz 20%',
          'Computer notes 20%',
          'Homework 10%',
          'Oral communication capstone 50%',
          'GRADE',
          'COMMENTS',
        ],
        [...profile(0), 71, 62, 72, 86, null, 'Works well in a team.'],
        [...profile(1), 82, 62, 72, 73],
        [...profile(2), 70, 63, 73, 92],
      ],
      BCU: [
        [
          'STUDENT ID',
          'f',
          'LAST NAME',
          'GENDER',
          'CLASS',
          'Participation - 5%',
          'Quiz 1 - 10%',
          'Quiz 2 - 10%',
          'Quiz 3- 10%',
          'Midterm - 30%',
          'Final - 35%',
          'Total',
          'COMMENTS',
        ],
        [...profile(0), null, null, null, null, null, 75, 26.25],
        // First and last name swapped, as in the real file.
        ['PNC2027-002', 'CHAN', 'BOPHA', 'F', 'A', 70, 43, null, null, null, 56, 27.4],
      ],
      MsOffice: [
        [
          ...PROFILE_HEADER,
          'PARTICIPATIONS',
          'MS WORD',
          'MS POWERPOINT',
          'MS EXCEL',
          'TOTAL',
          'COMMENTS',
        ],
        [...profile(0), 90, 95, 90, 95, 93],
        [...profile(1), 80, 88, 87, 90, 87.5],
      ],
    },
  });
}

/** The same term with a corrected Logic mark: Quiz 1 of PNC2027-001 goes from 90 to 55. */
export function replacementWorkbookFixture(): FakeSpreadsheet {
  const sheet = termWorkbookFixture();
  sheet.title = 'TERM1- GEN 2027 Scoring (corrected)';
  const row = sheet.tabs['Logic']?.[1];
  if (row) row[5] = 55;
  return sheet;
}
