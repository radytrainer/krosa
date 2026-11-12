import { computeCourseResult } from './grading.js';
import { gradeFor, gradeTone, isUsableGradeScale, OFFICIAL_GRADE_BANDS } from './letters.js';

const grade = (score: string | null) => gradeFor(OFFICIAL_GRADE_BANDS, score);
const toneOf = (score: string) => gradeTone(grade(score));

describe('gradeFor (official scale, decisions.md G5)', () => {
  // The approved boundary values: lower bound inclusive, upper bound exclusive (except 100).
  it.each([
    ['100', 'A'],
    ['100.00', 'A'],
    ['85', 'A'],
    ['85.00', 'A'],
    ['84.995', 'A'],
    ['84.99', 'B+'],
    ['80', 'B+'],
    ['79.99', 'B'],
    ['70', 'B'],
    ['69.99', 'C+'],
    ['65', 'C+'],
    ['64.99', 'C'],
    ['60', 'C'],
    ['59.99', 'D'],
    ['50', 'D'],
    ['49.99', 'E'],
    ['0', 'E'],
    ['0.00', 'E'],
  ])('%s is %s', (score, letter) => {
    expect(grade(score)).toBe(letter);
  });

  it('uses the displayed score: a raw 84.995 shows 85.00 and A, 84.99 stays B+', () => {
    // One criterion out of 1000, weight 100: mark 849.95 contributes exactly 84.995.
    const scheme = [{ criterionId: 'c', maxMark: '1000', weight: '100' }];
    const high = computeCourseResult(scheme, [
      { criterionId: 'c', status: 'RECORDED', mark: '849.95' },
    ]);
    expect(high.finalScoreExact?.toFixed()).toBe('84.995');
    expect(high.finalScore).toBe('85.00');
    expect(grade(high.finalScore)).toBe('A');
    expect(grade('84.995')).toBe('A');

    const low = computeCourseResult(scheme, [
      { criterionId: 'c', status: 'RECORDED', mark: '849.9' },
    ]);
    expect(low.finalScore).toBe('84.99');
    expect(grade(low.finalScore)).toBe('B+');
    expect(grade('84.994')).toBe('B+');
    // The same at the fail line: 49.995 shows 50.00 and D; 49.99 is E.
    expect(grade('49.995')).toBe('D');
    expect(grade('49.994')).toBe('E');
  });

  it('gives no grade without a final score', () => {
    expect(grade(null)).toBeNull();
    const incomplete = computeCourseResult(
      [
        { criterionId: 'a', maxMark: '10', weight: '50' },
        { criterionId: 'b', maxMark: '10', weight: '50' },
      ],
      [{ criterionId: 'a', status: 'RECORDED', mark: '10' }],
    );
    expect(incomplete.status).toBe('INCOMPLETE');
    expect(grade(incomplete.finalScore)).toBeNull();
  });

  it('gives no grade, never a default letter, when the scale is missing or unusable', () => {
    expect(gradeFor(null, '95.00')).toBeNull();
    expect(gradeFor([], '95.00')).toBeNull();
    expect(gradeFor([], '10.00')).toBeNull();
    // No band starting at 0.
    expect(gradeFor([{ letter: 'A', minTotal: '90' }], '95.00')).toBeNull();
    // Repeated threshold or letter, out-of-range threshold.
    expect(
      gradeFor(
        [
          { letter: 'A', minTotal: '50' },
          { letter: 'B', minTotal: '50.00' },
          { letter: 'E', minTotal: '0' },
        ],
        '60',
      ),
    ).toBeNull();
    expect(
      gradeFor(
        [
          { letter: 'A', minTotal: '50' },
          { letter: 'A', minTotal: '0' },
        ],
        '60',
      ),
    ).toBeNull();
    expect(
      gradeFor(
        [
          { letter: 'A', minTotal: '101' },
          { letter: 'E', minTotal: '0' },
        ],
        '60',
      ),
    ).toBeNull();
    expect(grade('not a number')).toBeNull();
  });

  it('reads bands in any order and from database decimals', () => {
    const shuffled = OFFICIAL_GRADE_BANDS.toReversed().map((b) => ({
      letter: b.letter,
      minTotal: { toString: () => `${b.minTotal}.00` },
    }));
    expect(isUsableGradeScale(shuffled)).toBe(true);
    expect(gradeFor(shuffled, '84.99')).toBe('B+');
    expect(gradeFor(shuffled, '85.00')).toBe('A');
  });

  it('has seven bands, A to E with B+ and C+, no gaps, and no F', () => {
    expect(OFFICIAL_GRADE_BANDS.map((b) => `${b.letter}${b.minTotal}`)).toEqual([
      'A85',
      'B+80',
      'B70',
      'C+65',
      'C60',
      'D50',
      'E0',
    ]);
    expect(OFFICIAL_GRADE_BANDS.some((b) => b.letter === 'F')).toBe(false);
  });

  it('E is the only fail', () => {
    expect(OFFICIAL_GRADE_BANDS.filter((b) => !b.isPass).map((b) => b.letter)).toEqual(['E']);
  });
});

describe('gradeTone (decisions.md G7)', () => {
  it.each([
    ['A', 'good'],
    ['B+', 'good'],
    ['B', 'good'],
    ['C+', 'good'],
    ['C', 'caution'],
    ['D', 'caution'],
    ['E', 'fail'],
  ])('%s is %s', (letter, tone) => {
    expect(gradeTone(letter)).toBe(tone);
  });

  it('gives no tone without a letter, or for a letter outside the scale', () => {
    expect(gradeTone(null)).toBeNull();
    expect(gradeTone(undefined)).toBeNull();
    expect(gradeTone('')).toBeNull();
    expect(gradeTone('F')).toBeNull();
    expect(gradeTone('a')).toBeNull();
  });

  it('every band of the scale has a tone, and only the fail band is fail', () => {
    for (const band of OFFICIAL_GRADE_BANDS) {
      expect(band.tone).toBe(gradeTone(band.letter));
      expect(band.tone === 'fail').toBe(!band.isPass);
    }
  });

  it('follows the score through the letter: 49.99 is fail, 50.00 caution, 65.00 good', () => {
    expect(toneOf('49.99')).toBe('fail');
    expect(toneOf('50.00')).toBe('caution');
    expect(toneOf('64.99')).toBe('caution');
    expect(toneOf('65.00')).toBe('good');
    expect(toneOf('100.00')).toBe('good');
  });
});
