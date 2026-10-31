/**
 * Synthetic workbook for the fault tests: 300 students, 5 tabs, 6 marks each. Every mark depends on
 * `version`, so a second version changes every score, and which tabs have landed can be counted.
 */
export const STUDENTS = 300;
export const TABS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const HEADER = [
  'STUDENT ID',
  'FIRST NAME',
  'LAST NAME',
  'GENDER',
  'CLASS',
  'Quiz 1 10%',
  'Quiz 2 10%',
  'Homework 10%',
  'Participation 10%',
  'MIDTERM 25%',
  'FINAL 35%',
];

export const code = (i) => `QA2027-${String(i + 1).padStart(4, '0')}`;
export const mark = (student, tab, column, version) =>
  (student * 7 + tab * 13 + column * 3 + version * 17) % 101;

export function bigWorkbook(version, students = STUDENTS) {
  const rows = Array.from({ length: students }, (_, i) => [
    code(i),
    `First${i}`,
    `Last${i}`,
    'F',
    'A',
  ]);
  const tabs = { ALL: [HEADER.slice(0, 5), ...rows] };
  TABS.forEach((name, t) => {
    tabs[name] = [
      HEADER,
      ...rows.map((row, i) => [...row, ...[0, 1, 2, 3, 4, 5].map((c) => mark(i, t, c, version))]),
    ];
  });
  return { title: `QA workbook v${version}`, tabs };
}
