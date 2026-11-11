import { computeCourseResult } from './grading.js';
import { gradeFor, isUsableGradeScale, OFFICIAL_GRADE_BANDS } from './letters.js';

const grade = (score: string | null) => gradeFor(OFFICIAL_GRADE_BANDS, score);

describe('gradeFor (official scale)', () => {
  it.each([
    ['100', 'A'],
    ['100.00', 'A'],
    ['90', 'A'],
    ['90.00', 'A'],
    ['89.99', 'B'],
    ['80.00', 'B'],
    ['79.99', 'C'],
    ['70.00', 'C'],
    ['69.99', 'D'],
    ['60.00', 'D'],
    ['59.99', 'E'],
    ['50.00', 'E'],
    ['49.99', 'F'],
    ['0.00', 'F'],
    ['0', 'F'],
  ])('%s is %s', (score, letter) => {
    expect(grade(score)).toBe(letter);
  });

  it('uses the displayed score: a raw 89.995 shows 90.00 and A, 89.99 stays B', () => {
    // One criterion out of 1000, weight 100: mark 899.95 contributes exactly 89.995.
    const scheme = [{ criterionId: 'c', maxMark: '1000', weight: '100' }];
    const high = computeCourseResult(scheme, [
      { criterionId: 'c', status: 'RECORDED', mark: '899.95' },
    ]);
    expect(high.finalScoreExact?.toFixed()).toBe('89.995');
    expect(high.finalScore).toBe('90.00');
    expect(grade(high.finalScore)).toBe('A');
    expect(grade('89.995')).toBe('A');

    const low = computeCourseResult(scheme, [
      { criterionId: 'c', status: 'RECORDED', mark: '899.9' },
    ]);
    expect(low.finalScore).toBe('89.99');
    expect(grade(low.finalScore)).toBe('B');
    expect(grade('89.994')).toBe('B');
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

  it('gives no grade, never a default F, when the scale is missing or unusable', () => {
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
          { letter: 'F', minTotal: '0' },
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
          { letter: 'F', minTotal: '0' },
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
    expect(gradeFor(shuffled, '89.99')).toBe('B');
    expect(gradeFor(shuffled, '90.00')).toBe('A');
  });

  it('has six bands A–F with no gaps', () => {
    expect(OFFICIAL_GRADE_BANDS.map((b) => `${b.letter}${b.minTotal}`)).toEqual([
      'A90',
      'B80',
      'C70',
      'D60',
      'E50',
      'F0',
    ]);
  });
});
