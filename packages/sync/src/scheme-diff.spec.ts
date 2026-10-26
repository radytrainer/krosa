import { sameSchemeItems } from './scheme-diff.js';
import { addCounts, emptyCounts } from './types.js';

describe('sameSchemeItems', () => {
  const base = [
    { criterionId: 'a', maxMark: '10.000', weight: '40.000' },
    { criterionId: 'b', maxMark: '50', weight: '60' },
  ];

  it('compares numerically and ignores order', () => {
    expect(
      sameSchemeItems(base, [
        { criterionId: 'b', maxMark: '50.000', weight: '60.0' },
        { criterionId: 'a', maxMark: '10', weight: '40' },
      ]),
    ).toBe(true);
  });

  it('detects changed weights, max marks and criterion sets', () => {
    expect(sameSchemeItems(base, [{ ...base[0]!, weight: '45' }, base[1]!])).toBe(false);
    expect(sameSchemeItems(base, [{ ...base[0]!, maxMark: '20' }, base[1]!])).toBe(false);
    expect(sameSchemeItems(base, [base[0]!])).toBe(false);
    expect(sameSchemeItems(base, [base[0]!, { ...base[1]!, criterionId: 'c' }])).toBe(false);
  });
});

describe('counts', () => {
  it('adds nested counters', () => {
    const total = emptyCounts();
    addCounts(total, { students: { created: 2, updated: 1, unchanged: 0, rejected: 0 } });
    addCounts(total, { students: { created: 1, updated: 0, unchanged: 4, rejected: 1 } });
    expect(total.students).toEqual({ created: 3, updated: 1, unchanged: 4, rejected: 1 });
    expect(total.scores.created).toBe(0);
  });
});
