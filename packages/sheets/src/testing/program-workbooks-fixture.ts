import type { CellValue, Grid } from '../reader.js';
import type { FakeSpreadsheet } from './in-memory-reader.js';

/**
 * Two term workbooks shaped like the school's GEN2027 Term 1 and Term 2 files
 * (docs/qa/step3-check.md), with made-up people: names are FN001/LN001 and so on.
 *
 * Term 1 (General): 101 students, classes A 26, B 24, C 25, D 26. ALL's header is on row 3 and
 * carries ENG score columns. In ENG and PL, PNC2027-051 and -076 have another class than in ALL,
 * and one ENG row holds a name nobody has.
 *
 * Term 2: the same students except PNC2027-076. Classes are reshuffled: WEP A, B, C (25 each) and
 * SNAC D (25). ALL starts with a row-number column and has CLASS 2. Subject tabs carry MAJOR.
 * ENG and PL are shared; Algorithm and Web Design are WEP only; CCNA1 is SNAC only. ENG swaps
 * first and last name on 6 rows, CCNA1 on every row, and Web Design shifts the names one row down
 * (74 of 75 rows carry another student's name).
 */
export const PROGRAM_T1_SPREADSHEET_ID = '1ProgramTermOneWorkbook00000000000000000';
export const PROGRAM_T2_SPREADSHEET_ID = '1ProgramTermTwoWorkbook00000000000000000';

const pad = (i: number) => String(i).padStart(3, '0');
export const programStudentCode = (i: number) => `PNC2027-${pad(i)}`;
const first = (i: number) => `FN${pad(i)}`;
const last = (i: number) => `LN${pad(i)}`;
const gender = (i: number) => (i % 2 ? 'M' : 'F');
const mark = (i: number, salt: number) => 40 + ((i * 7 + salt * 13) % 60);

const T1_STUDENTS = Array.from({ length: 101 }, (_, k) => k + 1);
/** Term 1 class: A 1–26, B 27–50, C 51–75, D 76–101. */
export function programTerm1Class(i: number): string {
  return i <= 26 ? 'A' : i <= 50 ? 'B' : i <= 75 ? 'C' : 'D';
}

/** The one student who leaves after Term 1. */
export const PROGRAM_T1_ONLY = 76;
const T2_STUDENTS = T1_STUDENTS.filter((i) => i !== PROGRAM_T1_ONLY);
/** Term 2 order: a fixed reshuffle, so Term 1 classes do not predict Term 2 ones. */
const T2_ORDER = T2_STUDENTS.toSorted((a, b) => ((a * 37) % 101) - ((b * 37) % 101) || a - b);
/** Term 2 class: the first 25 of the reshuffle are A, then B, C, and D (SNAC). */
export function programTerm2Class(i: number): string | null {
  const at = T2_ORDER.indexOf(i);
  return at < 0 ? null : (['A', 'B', 'C', 'D'][Math.floor(at / 25)] ?? null);
}
export const programTerm2Program = (i: number) =>
  programTerm2Class(i) === 'D' ? 'SNAC' : programTerm2Class(i) === null ? null : 'WEP';
const WEP = T2_ORDER.filter((i) => programTerm2Program(i) === 'WEP').toSorted((a, b) => a - b);
const SNAC = T2_ORDER.filter((i) => programTerm2Program(i) === 'SNAC').toSorted((a, b) => a - b);
export const PROGRAM_WEP_STUDENTS: readonly number[] = WEP;
export const PROGRAM_SNAC_STUDENTS: readonly number[] = SNAC;

/** Rows of a subject tab: one per student, `cells(i, n)` builds the cells after the profile. */
function rows(students: readonly number[], build: (i: number, n: number) => CellValue[]): Grid {
  return students.map((i, k) => build(i, k + 1));
}

const meta = (term: number): Grid => [
  ['key', 'value'],
  ['template_version', 1],
  ['generation_code', 'GEN2027'],
  ['education_term', term],
];

/** Term 1 subject tabs give PNC2027-051 and -076 another class than ALL does. */
const tabClass = (i: number) => (i === 51 ? 'B' : i === 76 ? 'C' : programTerm1Class(i));
const profile = (i: number) => [programStudentCode(i), first(i), last(i), gender(i)];

/** A Term 2 student's class; throws for the student who left after Term 1. */
function t2Class(i: number): string {
  const c = programTerm2Class(i);
  if (!c) throw new Error(`${programStudentCode(i)} is not in Term 2`);
  return c;
}
const major = (i: number) => (t2Class(i) === 'D' ? 'SNAC' : 'WEP');
const class2 = (i: number) => (major(i) === 'SNAC' ? 'SNAC' : `WEP ${t2Class(i)}`);
const head = (...rest: string[]) => [
  '#N',
  'STUDENT ID',
  'FIRST NAME',
  'LAST NAME',
  'GENDER',
  'CLASS',
  'MAJOR',
  ...rest,
];

export function programTerm1Workbook(): FakeSpreadsheet {
  return {
    title: 'TERM1- GEN 2027 Scoring (fixture)',
    tabs: {
      _meta: meta(1),
      ALL: [
        ['GEN 2027 roster'],
        [null, null, null, null, null, 'EXAMS (60%)'],
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS', 'Speaking (10%)', 'TOTAL'],
        ...rows(T1_STUDENTS, (i) => [...profile(i), programTerm1Class(i), mark(i, 1), mark(i, 2)]),
      ],
      ENG: [
        ['ENGLISH'],
        [null, null, null, null, null, 'EXAMS (100%)'],
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS', 'Quiz (50%)', 'Final (50%)'],
        ...rows(T1_STUDENTS, (i) =>
          i === 10
            ? [programStudentCode(i), 'FN999', 'LN999', gender(i), tabClass(i), 70, 80]
            : [...profile(i), tabClass(i), mark(i, 3), mark(i, 4)],
        ),
      ],
      PL: [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS', 'Quiz 50%', 'Final 50%'],
        ...rows(T1_STUDENTS, (i) => [...profile(i), tabClass(i), mark(i, 5), mark(i, 6)]),
      ],
    },
  };
}

export function programTerm2Workbook(): FakeSpreadsheet {
  // ENG lists last name first; six students have the two swapped.
  const engSwapped = new Set(T2_STUDENTS.slice(0, 6));
  // Row k of Web Design carries the name of the WEP student one row up (row 1 keeps its own).
  const shifted = (k: number) => WEP[k === 0 ? 0 : k - 1] ?? WEP[0] ?? 0;
  return {
    title: 'TERM2- GEN 2027 Scoring (fixture)',
    tabs: {
      _meta: meta(2),
      ALL: [
        ['GEN 2027 roster, Term 2'],
        [],
        [
          '#N',
          'STUDENT ID',
          'FIRST NAME',
          'LAST NAME',
          'FULL NAME',
          'KH LAST NAME',
          'KH FIRST NAME',
          'FULL NAME 2',
          'GENDER',
          'CLASS',
          'CLASS 2',
        ],
        ...rows(T2_STUDENTS, (i, n) => [
          n,
          programStudentCode(i),
          first(i),
          last(i),
          `${first(i)} ${last(i)}`,
          `KL${pad(i)}`,
          `KF${pad(i)}`,
          `${last(i)} ${first(i)}`,
          gender(i),
          t2Class(i),
          class2(i),
        ]),
      ],
      ENG: [
        ['ENGLISH'],
        [null, null, null, null, null, null, null, 'EXAMS (100%)'],
        [
          '#N',
          'STUDENT ID',
          'LAST NAME',
          'FIRST NAME',
          'GENDER',
          'CLASS',
          'MAJOR',
          'Speaking (50%)',
          'Writing (50%)',
          'COMMENTS',
        ],
        ...rows(T2_STUDENTS, (i, n) => [
          n,
          programStudentCode(i),
          engSwapped.has(i) ? first(i) : last(i),
          engSwapped.has(i) ? last(i) : first(i),
          gender(i),
          t2Class(i),
          major(i),
          mark(i, 7),
          mark(i, 8),
        ]),
      ],
      PL: [
        [],
        [],
        head('QUIZ 50%', 'Final Report 50%', 'Total Score'),
        ...rows(T2_STUDENTS, (i, n) => [
          n,
          programStudentCode(i),
          first(i),
          last(i),
          gender(i),
          t2Class(i),
          major(i),
          mark(i, 9),
          mark(i, 10),
        ]),
      ],
      Algorithm: [
        [],
        [],
        head('Quiz 1 50%', 'Project 50%', 'Total'),
        ...rows(WEP, (i, n) => [
          n,
          programStudentCode(i),
          first(i),
          last(i),
          gender(i),
          t2Class(i),
          major(i),
          mark(i, 11),
          mark(i, 12),
        ]),
      ],
      'Web Design': [
        [],
        [],
        head('Midterm 50%', 'Project 50%'),
        ...rows(WEP, (i, n) => [
          n,
          programStudentCode(i),
          first(shifted(n - 1)),
          last(shifted(n - 1)),
          gender(i),
          t2Class(i),
          major(i),
          mark(i, 13),
          mark(i, 14),
        ]),
      ],
      CCNA1: [
        [],
        [],
        [
          'Column 1',
          'STUDENT ID',
          'FIRST NAME',
          'LAST NAME',
          'GENDER',
          'CLASS',
          'MAJOR',
          'ASSESSMENT 1 50%',
          'ASSESSMENT 2 50%',
        ],
        ...rows(SNAC, (i, n) => [
          n,
          programStudentCode(i),
          last(i),
          first(i),
          gender(i),
          t2Class(i),
          major(i),
          mark(i, 15),
          mark(i, 16),
        ]),
      ],
    },
  };
}
