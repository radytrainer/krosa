import { GradeDecimal, toDecimal, formatFixed } from './decimal.js';
import {
  computeCourseResult,
  computeTermSummary,
  validateScheme,
  type SchemeItemInput,
  type ScoreInput,
} from './grading.js';

// Example scheme from the requirements: 5/5/30/40/10/10.
const scheme: SchemeItemInput[] = [
  { criterionId: 'q1', maxMark: 10, weight: 5 },
  { criterionId: 'q2', maxMark: 10, weight: 5 },
  { criterionId: 'mid', maxMark: 50, weight: 30 },
  { criterionId: 'final', maxMark: 100, weight: 40 },
  { criterionId: 'hw', maxMark: 10, weight: 10 },
  { criterionId: 'part', maxMark: 10, weight: 10 },
];

const recorded = (criterionId: string, mark: string | number): ScoreInput => ({
  criterionId,
  status: 'RECORDED',
  mark,
});

describe('toDecimal', () => {
  it('parses strict decimal strings and finite numbers', () => {
    expect(toDecimal('41.125').toString()).toBe('41.125');
    expect(toDecimal(' 8 ').toString()).toBe('8');
    expect(toDecimal(0.1).plus(toDecimal(0.2)).toString()).toBe('0.3');
  });

  it.each(['8,5', '1e3', '', 'abc', '--1', '.5'])('rejects %j', (value) => {
    expect(() => toDecimal(value)).toThrow(RangeError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rounds half up', () => {
    expect(formatFixed(new GradeDecimal('2.345'), 2)).toBe('2.35');
    expect(formatFixed(new GradeDecimal('2.344999'), 2)).toBe('2.34');
    expect(formatFixed(new GradeDecimal('-2.345'), 2)).toBe('-2.35');
  });
});

describe('validateScheme', () => {
  it('accepts schemes totalling exactly 100', () => {
    expect(validateScheme(scheme)).toEqual({ valid: true, totalWeight: '100.000', issues: [] });
    expect(
      validateScheme([
        { criterionId: 'a', maxMark: '20', weight: '33.333' },
        { criterionId: 'b', maxMark: '20', weight: '33.333' },
        { criterionId: 'c', maxMark: '20', weight: '33.334' },
      ]).valid,
    ).toBe(true);
  });

  it('rejects totals other than 100 without float drift', () => {
    const result = validateScheme([
      { criterionId: 'a', maxMark: 10, weight: '33.33' },
      { criterionId: 'b', maxMark: 10, weight: '33.33' },
      { criterionId: 'c', maxMark: 10, weight: '33.33' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.totalWeight).toBe('99.990');
    expect(result.issues.map((i) => i.code)).toEqual(['WEIGHTS_NOT_100']);
  });

  it('rejects empty schemes, duplicates, bad weights and bad max marks', () => {
    expect(validateScheme([]).issues.map((i) => i.code)).toEqual(['EMPTY_SCHEME']);
    const codes = validateScheme([
      { criterionId: 'a', maxMark: 10, weight: 50 },
      { criterionId: 'a', maxMark: 10, weight: 50 },
      { criterionId: 'b', maxMark: 0, weight: 0 },
      { criterionId: 'c', maxMark: -5, weight: 101 },
      { criterionId: 'd', maxMark: 'ten', weight: 'NaN' },
      { criterionId: 'e', maxMark: '10.0001', weight: '1.0005' },
    ]).issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'DUPLICATE_CRITERION',
        'INVALID_WEIGHT',
        'INVALID_MAX_MARK',
        'TOO_MANY_DECIMALS',
      ]),
    );
    // Totals are only meaningful once every item is valid.
    expect(codes).not.toContain('WEIGHTS_NOT_100');
  });
});

describe('computeCourseResult', () => {
  it('computes contributions and the final score for a complete course', () => {
    const result = computeCourseResult(scheme, [
      recorded('q1', 8),
      recorded('q2', 9),
      recorded('mid', 41.5),
      recorded('final', 72),
      recorded('hw', 9),
      recorded('part', 10),
    ]);
    // 4 + 4.5 + 24.9 + 28.8 + 9 + 10 = 81.2
    expect(result.status).toBe('COMPLETE');
    expect(result.finalScore).toBe('81.20');
    expect(result.criteria.map((c) => c.contribution)).toEqual([
      '4.00',
      '4.50',
      '24.90',
      '28.80',
      '9.00',
      '10.00',
    ]);
    expect(result.attemptedWeight).toBe('100.000');
  });

  it('rounds the exact sum, not the sum of rounded contributions', () => {
    // Each contribution is 100/3 = 33.333…; rounded parts would sum to 99.99.
    const thirds: SchemeItemInput[] = [
      { criterionId: 'a', maxMark: 3, weight: '33.333' },
      { criterionId: 'b', maxMark: 3, weight: '33.333' },
      { criterionId: 'c', maxMark: 3, weight: '33.334' },
    ];
    const result = computeCourseResult(thirds, [
      recorded('a', 1),
      recorded('b', 1),
      recorded('c', 1),
    ]);
    // Exact: (33.333 + 33.333 + 33.334) / 3 = 33.3333…
    expect(result.criteria.map((c) => c.contribution)).toEqual(['11.11', '11.11', '11.11']);
    expect(result.finalScore).toBe('33.33');

    const tricky: SchemeItemInput[] = [
      { criterionId: 'a', maxMark: 3, weight: 50 },
      { criterionId: 'b', maxMark: 3, weight: 50 },
    ];
    // Each: 1/3 × 50 = 16.666… → rounds to 16.67; rounded sum would be 33.34, exact sum is 33.333… → 33.33.
    const r2 = computeCourseResult(tricky, [recorded('a', 1), recorded('b', 1)]);
    expect(r2.criteria.map((c) => c.contribution)).toEqual(['16.67', '16.67']);
    expect(r2.finalScore).toBe('33.33');
  });

  it('never treats a missing mark as zero', () => {
    const result = computeCourseResult(scheme, [recorded('q1', 10), recorded('mid', 50)]);
    expect(result.status).toBe('INCOMPLETE');
    expect(result.finalScore).toBeNull();
    expect(result.finalScoreExact).toBeNull();
    expect(result.attemptedWeight).toBe('35.000');
    expect(result.earnedSoFar).toBe('35.00');
    expect(result.criteria.find((c) => c.criterionId === 'q2')).toMatchObject({
      score: null,
      contribution: null,
    });
  });

  it('counts ABSENT as an explicit zero', () => {
    const scores = scheme.map((s) =>
      s.criterionId === 'final'
        ? ({ criterionId: 'final', status: 'ABSENT', mark: 0 } as const)
        : recorded(s.criterionId, s.maxMark as number),
    );
    const result = computeCourseResult(scheme, scores);
    expect(result.status).toBe('COMPLETE');
    expect(result.finalScore).toBe('60.00');
    expect(result.criteria.find((c) => c.criterionId === 'final')).toMatchObject({
      score: { status: 'ABSENT', mark: '0.000' },
      contribution: '0.00',
    });
  });

  it('handles decimal marks and decimal max marks exactly', () => {
    const result = computeCourseResult(
      [
        { criterionId: 'a', maxMark: '7.5', weight: '62.5' },
        { criterionId: 'b', maxMark: '0.3', weight: '37.5' },
      ],
      [recorded('a', '7.125'), recorded('b', '0.1')],
    );
    // 7.125/7.5×62.5 = 59.375 ; 0.1/0.3×37.5 = 12.5 → 71.875 → 71.88
    expect(result.criteria.map((c) => c.contribution)).toEqual(['59.38', '12.50']);
    expect(result.finalScore).toBe('71.88');
  });

  it('flags out-of-range marks for review instead of producing a score', () => {
    const result = computeCourseResult(
      [{ criterionId: 'a', maxMark: 10, weight: 100 }],
      [recorded('a', 11)],
    );
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.finalScore).toBeNull();
    expect(result.criteria[0]).toMatchObject({ invalidMark: true, contribution: null });
  });

  it('ignores scores for criteria outside the scheme', () => {
    const result = computeCourseResult(
      [{ criterionId: 'a', maxMark: 10, weight: 100 }],
      [recorded('a', 5), recorded('retired', 10)],
    );
    expect(result.finalScore).toBe('50.00');
    expect(result.criteria).toHaveLength(1);
  });

  it('reports NOT_CONFIGURED without a published scheme', () => {
    expect(computeCourseResult(null, [recorded('a', 5)])).toMatchObject({
      status: 'NOT_CONFIGURED',
      criteria: [],
      finalScore: null,
    });
  });

  it('gives full marks exactly 100', () => {
    const scores = scheme.map((s) => recorded(s.criterionId, s.maxMark as number));
    expect(computeCourseResult(scheme, scores).finalScore).toBe('100.00');
  });
});

const complete = (score: string) => ({
  status: 'COMPLETE' as const,
  finalScoreExact: new GradeDecimal(score),
});

describe('computeTermSummary', () => {
  it('averages complete courses weighted by credits', () => {
    const summary = computeTermSummary([
      { credits: 3, result: complete('80') },
      { credits: 1, result: complete('60') },
    ]);
    expect(summary).toMatchObject({
      status: 'COMPLETE',
      average: '75.00',
      provisionalAverage: '75.00',
      completedCourses: 2,
      totalCourses: 2,
      creditsCompleted: '4.0',
      creditsTotal: '4.0',
    });
  });

  it('withholds the final average while any course is incomplete', () => {
    const summary = computeTermSummary([
      { credits: 2, result: complete('90') },
      { credits: 2, result: { status: 'INCOMPLETE', finalScoreExact: null } },
    ]);
    expect(summary.status).toBe('INCOMPLETE');
    expect(summary.average).toBeNull();
    expect(summary.provisionalAverage).toBe('90.00');
    expect(summary.completedCourses).toBe(1);
  });

  it('uses exact course scores, not rounded ones', () => {
    const summary = computeTermSummary([
      { credits: 1, result: complete('33.335') },
      { credits: 1, result: complete('33.335') },
    ]);
    expect(summary.average).toBe('33.34');
  });

  it('reports an empty term', () => {
    expect(computeTermSummary([])).toMatchObject({
      status: 'EMPTY',
      average: null,
      totalCourses: 0,
    });
  });
});
