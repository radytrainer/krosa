import { describe, expect, it } from 'vitest';
import { GRADED_LEVELS, levelFor, MONITORING_LEVELS, type GradeBandLevelInput } from './levels.js';

/** The official scale of 2026-11 with the levels of migration 20261114090000_grade_levels. */
const OFFICIAL: GradeBandLevelInput[] = [
  { letter: 'A', level: 'VERY_GOOD' },
  { letter: 'B+', level: 'VERY_GOOD' },
  { letter: 'B', level: 'GOOD' },
  { letter: 'C+', level: 'GOOD' },
  { letter: 'C', level: 'FAIR' },
  { letter: 'D', level: 'FAIR' },
  { letter: 'E', level: 'FAIL' },
];

describe('levelFor', () => {
  it('maps every official letter of a COMPLETE result to its band level', () => {
    expect(OFFICIAL.map((b) => [b.letter, levelFor('COMPLETE', b.letter, OFFICIAL)])).toEqual([
      ['A', 'VERY_GOOD'],
      ['B+', 'VERY_GOOD'],
      ['B', 'GOOD'],
      ['C+', 'GOOD'],
      ['C', 'FAIR'],
      ['D', 'FAIR'],
      ['E', 'FAIL'],
    ]);
  });

  it('gives INCOMPLETE for every non-COMPLETE status, whatever the letter, never FAIL', () => {
    for (const status of ['INCOMPLETE', 'NEEDS_REVIEW', 'NOT_CONFIGURED'] as const) {
      expect(levelFor(status, null, OFFICIAL)).toBe('INCOMPLETE');
      expect(levelFor(status, 'E', OFFICIAL)).toBe('INCOMPLETE');
      expect(levelFor(status, 'A', null)).toBe('INCOMPLETE');
    }
  });

  it('gives no level without a usable scale or without a letter', () => {
    expect(levelFor('COMPLETE', 'A', null)).toBeNull();
    expect(levelFor('COMPLETE', null, OFFICIAL)).toBeNull();
    expect(levelFor('COMPLETE', 'Z', OFFICIAL)).toBeNull();
    expect(levelFor('COMPLETE', 'A', [])).toBeNull();
  });

  it('compares letters ignoring surrounding spaces, but not case', () => {
    expect(levelFor('COMPLETE', ' B+ ', OFFICIAL)).toBe('VERY_GOOD');
    expect(levelFor('COMPLETE', 'B+', [{ letter: ' B+', level: 'GOOD' }])).toBe('GOOD');
    expect(levelFor('COMPLETE', 'b+', OFFICIAL)).toBeNull();
  });

  it('reads the mapping from the bands: a changed scale changes the level', () => {
    const changed = OFFICIAL.map((b) => (b.letter === 'B' ? { ...b, level: 'FAIR' as const } : b));
    expect(levelFor('COMPLETE', 'B', OFFICIAL)).toBe('GOOD');
    expect(levelFor('COMPLETE', 'B', changed)).toBe('FAIR');
  });

  it('lists the levels in display order, INCOMPLETE last', () => {
    expect(GRADED_LEVELS).toEqual(['VERY_GOOD', 'GOOD', 'FAIR', 'FAIL']);
    expect(MONITORING_LEVELS).toEqual(['VERY_GOOD', 'GOOD', 'FAIR', 'FAIL', 'INCOMPLETE']);
  });
});
