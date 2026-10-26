import { lockedUntilAfterFailure } from './lockout.js';

describe('lockedUntilAfterFailure', () => {
  const now = new Date('2026-10-26T00:00:00Z');
  const minutesLocked = (count: number) => {
    const until = lockedUntilAfterFailure(count, now);
    return until ? (until.getTime() - now.getTime()) / 60_000 : null;
  };

  it('does not lock below the threshold', () => {
    expect(minutesLocked(1)).toBeNull();
    expect(minutesLocked(4)).toBeNull();
  });

  it('locks progressively and caps at 15 minutes', () => {
    expect(minutesLocked(5)).toBe(1);
    expect(minutesLocked(6)).toBe(2);
    expect(minutesLocked(7)).toBe(4);
    expect(minutesLocked(8)).toBe(8);
    expect(minutesLocked(9)).toBe(15);
    expect(minutesLocked(50)).toBe(15);
  });
});
