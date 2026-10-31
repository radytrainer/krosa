/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { describe, expect, it } from 'vitest';
import { computeCourseResult, computeTermSummary, validateScheme } from './grading.js';

/** QA suite, area C. Expected values never come from the code under test. */

const scheme = (...weights: string[]) =>
  weights.map((weight, i) => ({ criterionId: `c${i}`, maxMark: '100', weight }));
const marks = (...values: (string | null)[]) =>
  values.flatMap((mark, i) =>
    mark === null ? [] : [{ criterionId: `c${i}`, status: 'RECORDED' as const, mark }],
  );

/** Independent calculator: integers only. Marks and weights are thousandths, max mark 100. */
function exactTotal(items: { mark: bigint; weight: bigint }[]): string {
  // sum(mark × weight) has 6 implied decimals; dividing by 100 gives 8. Half-up to 2 places.
  const numerator = items.reduce((sum, i) => sum + i.mark * i.weight, 0n);
  const hundredths = (numerator * 2n + 1_000_000n) / 2_000_000n;
  const whole = hundredths / 100n;
  return `${whole}.${String(hundredths % 100n).padStart(2, '0')}`;
}

const thousandths = (n: number) => `${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, '0')}`;

/** Small seeded generator so a failure can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (max: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % max) | 0;
  };
}

describe('QA C-01 total = sum(mark x weight / 100), hand-worked', () => {
  it.each([
    // Worked on paper. Logic row 1 is the worked example in delivery-plan-2027.md B.1.
    [['10', '10', '10', '10', '25', '35'], ['90', '89', '90', '97', '60', '78'], '78.90'],
    [['10', '10', '10', '10', '25', '35'], ['80', '70', '80', '80', '50', '60'], '64.50'],
    [['50', '50'], ['100', '100'], '100.00'],
    [['50', '50'], ['0', '0'], '0.00'],
    [['20', '30', '50'], ['75', '60', '90'], '78.00'],
    [['33.333', '33.333', '33.334'], ['90', '90', '90'], '90.00'],
    [['7.5', '7.5', '85'], ['70', '80', '90'], '87.75'],
    [['10', '90'], ['99.999', '99.999'], '100.00'],
    [['25', '25', '25', '25'], ['12.5', '37.5', '62.5', '87.5'], '50.00'],
    [['1', '99'], ['1', '1'], '1.00'],
  ])('%j with %j gives %s', (weights, values, expected) => {
    const result = computeCourseResult(scheme(...weights), marks(...values));
    expect(result.status).toBe('COMPLETE');
    expect(result.finalScore).toBe(expected);
  });
});

describe('QA C-02 half-up on exact ties', () => {
  it.each([
    ['33.335', '33.34'],
    ['33.334', '33.33'],
    ['0.005', '0.01'],
    ['0.004', '0.00'],
    ['99.995', '100.00'],
    ['99.994', '99.99'],
    ['100', '100.00'],
    ['0', '0.00'],
    ['12.345', '12.35'],
    ['1.005', '1.01'], // 100.49999… in binary floating point
    ['8.325', '8.33'],
  ])('mark %s out of 100, weight 100, gives %s', (mark, expected) => {
    expect(computeCourseResult(scheme('100'), marks(mark)).finalScore).toBe(expected);
  });

  it('a tie made by several parts still rounds up', () => {
    // 10.05 × 50% + 10.06 × 50% = 10.055 exactly
    expect(computeCourseResult(scheme('50', '50'), marks('10.05', '10.06')).finalScore).toBe(
      '10.06',
    );
  });
});

describe('QA C-03 the total is the rounded exact sum, not a sum of rounded parts', () => {
  it('three parts that each round down', () => {
    // 0.34 × 33.333% etc: exact sum differs from the sum of rounded contributions.
    const result = computeCourseResult(
      scheme('33.333', '33.333', '33.334'),
      marks('1.34', '1.34', '1.34'),
    );
    const parts = result.criteria.reduce((sum, c) => sum + Number(c.contribution), 0);
    expect(result.finalScore).toBe('1.34');
    expect(parts.toFixed(2)).toBe('1.35');
  });
});

describe('QA C-04 property test against an integer calculator', () => {
  it('10,000 random schemes agree to the cent', () => {
    const next = rng(20261031);
    for (let run = 0; run < 10_000; run++) {
      const count = 1 + next(16);
      const weights: number[] = [];
      let left = 100_000;
      for (let i = 0; i < count - 1; i++) {
        const w = 1 + next(Math.max(1, left - (count - i)));
        weights.push(w);
        left -= w;
      }
      weights.push(left);
      const values = weights.map(() => next(100_001));
      const result = computeCourseResult(
        scheme(...weights.map(thousandths)),
        marks(...values.map(thousandths)),
      );
      const expected = exactTotal(
        weights.map((w, i) => ({ weight: BigInt(w), mark: BigInt(values[i]!) })),
      );
      if (result.finalScore !== expected) {
        throw new Error(
          `run ${run}: weights ${weights} marks ${values}: ${result.finalScore} != ${expected}`,
        );
      }
    }
  });
});

describe('QA C-05 / C-08 blank is not zero', () => {
  it.each([0, 1, 2, 3, 4, 5])('blank at position %i gives INCOMPLETE and no total', (blank) => {
    const values: (string | null)[] = ['90', '90', '90', '90', '90', '90'];
    values[blank] = null;
    const result = computeCourseResult(
      scheme('10', '10', '10', '10', '25', '35'),
      marks(...values),
    );
    expect(result.status).toBe('INCOMPLETE');
    expect(result.finalScore).toBeNull();
    expect(result.finalScoreExact).toBeNull();
    expect(result.criteria[blank]!.score).toBeNull();
    expect(result.criteria[blank]!.contribution).toBeNull();
  });

  it('every component blank gives INCOMPLETE', () => {
    const result = computeCourseResult(scheme('50', '50'), []);
    expect(result).toMatchObject({ status: 'INCOMPLETE', finalScore: null, earnedSoFar: '0.00' });
  });

  it('a real 0 is a complete mark', () => {
    const result = computeCourseResult(scheme('50', '50'), marks('0', '0'));
    expect(result).toMatchObject({ status: 'COMPLETE', finalScore: '0.00' });
    expect(result.criteria[0]!.score).toEqual({ status: 'RECORDED', mark: '0.000' });
  });
});

describe('QA C-07 ABS', () => {
  it('counts as 0, is complete, stays visible as absent', () => {
    const result = computeCourseResult(scheme('50', '50'), [
      { criterionId: 'c0', status: 'ABSENT', mark: '0' },
      { criterionId: 'c1', status: 'RECORDED', mark: '80' },
    ]);
    expect(result).toMatchObject({ status: 'COMPLETE', finalScore: '40.00' });
    expect(result.criteria[0]!.score).toEqual({ status: 'ABSENT', mark: '0.000' });
    expect(result.criteria[0]!.contribution).toBe('0.00');
  });
});

describe('QA C-13 an offering whose weights do not total 100 is rejected', () => {
  it.each([
    [['99.999', '0.0005']],
    [['60', '39.999']],
    [['60', '40.001']],
    [['100', '0']],
    [['100.001']],
    [['-10', '110']],
    [['99']],
    [['50.0001', '49.9999']],
  ])('%j', (weights) => {
    expect(validateScheme(scheme(...weights)).valid).toBe(false);
  });

  it('exactly 100 passes, including 1.666 + 1.667 + 1.667 + 95', () => {
    expect(validateScheme(scheme('1.666', '1.667', '1.667', '95')).valid).toBe(true);
    expect(validateScheme([]).valid).toBe(false);
  });
});

describe('QA C-15 term average', () => {
  const course = (credits: string, finalScore: string) => {
    const result = computeCourseResult(scheme('100'), marks(finalScore));
    return { credits, result };
  };

  it('is credit-weighted, on exact scores, rounded once', () => {
    // (80 × 3 + 70.555 × 1) / 4 = 77.63875
    const summary = computeTermSummary([course('3', '80'), course('1', '70.555')]);
    expect(summary).toMatchObject({ status: 'COMPLETE', average: '77.64' });
  });

  it('has no average while any course is incomplete', () => {
    const incomplete = {
      credits: '1',
      result: computeCourseResult(scheme('50', '50'), marks('90', null)),
    };
    const summary = computeTermSummary([course('1', '80'), incomplete]);
    expect(summary).toMatchObject({
      status: 'INCOMPLETE',
      average: null,
      provisionalAverage: '80.00',
    });
  });
});

describe('QA C-02b exactness with a maximum other than 100', () => {
  it('mark 1 of 3, weight 0.015, is an exact tie at 0.005 and rounds up', () => {
    // Not reachable from term workbooks (always out of 100). The engine divides first, so
    // 1/3 is truncated at 40 digits before it is multiplied.
    const result = computeCourseResult(
      [
        { criterionId: 'c0', maxMark: '3', weight: '0.015' },
        { criterionId: 'c1', maxMark: '100', weight: '99.985' },
      ],
      marks('1', '0'),
    );
    expect(result.finalScore).toBe('0.01');
  });
});
