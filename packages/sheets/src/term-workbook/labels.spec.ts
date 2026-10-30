import { guessCategory, keyFromName, parseLabelWeight, roleFromLabel } from './labels.js';

describe('parseLabelWeight', () => {
  // Every label variant seen in the real GEN2027 / GEN2026 Term 1 workbooks.
  it.each([
    ['Quiz 1 10%', 'Quiz 1', '10'],
    ['MIDTERM 25%', 'MIDTERM', '25'],
    ['Speaking (10%)', 'Speaking', '10'],
    ['Class participation (5%)', 'Class participation', '5'],
    ['Quiz 3- 10%', 'Quiz 3', '10'],
    ['Participation - 5%', 'Participation', '5'],
    ['PARTICIPATION\n10%', 'PARTICIPATION', '10'],
    ['Oral communication capstone 50%', 'Oral communication capstone', '50'],
    ['CLASS PARTICIPATION - 15%', 'CLASS PARTICIPATION', '15'],
    ['Writing (15%)', 'Writing', '15'],
    ['Weight 7.5%', 'Weight', '7.5'],
  ])('%j → %s / %s', (label, name, weight) => {
    expect(parseLabelWeight(label)).toEqual({ name, weight });
  });

  it.each(['Q1', 'MS WORD', 'Gymglish ', 'HW1', 'Role Play'])('%j has no weight', (label) => {
    expect(parseLabelWeight(label)).toEqual({ name: label.trim(), weight: null });
  });

  it('rejects impossible weights instead of guessing', () => {
    expect(parseLabelWeight('Bonus 0%').weight).toBeNull();
    expect(parseLabelWeight('Total 150%').weight).toBeNull();
  });
});

describe('roleFromLabel', () => {
  it.each([
    ['STUDENT ID', 'STUDENT_ID'],
    ['student id', 'STUDENT_ID'],
    ['FIRST NAME', 'FIRST_NAME'],
    ['First name', 'FIRST_NAME'],
    ['LAST NAME', 'LAST_NAME'],
    ['GENDER', 'GENDER'],
    ['Class', 'CLASS'],
    ['TOTAL', 'REFERENCE_TOTAL'],
    ['Total', 'REFERENCE_TOTAL'],
    ['COMMENTS', 'COMMENT'],
    ['COMMENT', 'COMMENT'],
    ['GRADE', 'IGNORE'],
    ['Global Grade', 'IGNORE'],
    ['TOTAL 1', 'IGNORE'],
    ['AVERAGE HW', 'IGNORE'],
    ['Quiz 1 10%', 'CRITERION'],
    ['f', 'CRITERION'],
  ])('%j → %s', (label, role) => {
    expect(roleFromLabel(label)).toBe(role);
  });
});

describe('guessCategory', () => {
  it('prefers the group, then the column name', () => {
    expect(guessCategory('Speaking', 'FINAL')).toBe('EXAM');
    expect(guessCategory('Role Play', 'Projects')).toBe('PROJECT');
    expect(guessCategory('JAN', 'Class participation')).toBe('PARTICIPATION');
    expect(guessCategory('Q1', 'Quizzes')).toBe('QUIZ');
    expect(guessCategory('HW2', null)).toBe('HOMEWORK');
    expect(guessCategory('MS WORD', null)).toBe('OTHER');
  });
});

describe('keyFromName', () => {
  it('builds valid criterion keys', () => {
    expect(keyFromName('Quiz 1')).toBe('QUIZ_1');
    expect(keyFromName('MS POWERPOINT')).toBe('MS_POWERPOINT');
    expect(keyFromName('FINAL – Speaking')).toBe('FINAL_SPEAKING');
    expect(keyFromName('2nd test')).toBe('C_2ND_TEST');
    expect(keyFromName('***')).toBe('CRITERION');
    expect(keyFromName('x'.repeat(50))).toHaveLength(32);
  });
});
