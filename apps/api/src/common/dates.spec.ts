import { formatDateOnly, parseDateOnly } from './dates.js';

describe('date-only helpers', () => {
  it('round-trips calendar dates as UTC midnight', () => {
    const d = parseDateOnly('2026-09-01');
    expect(d.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(formatDateOnly(d)).toBe('2026-09-01');
    expect(formatDateOnly(null)).toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '26-09-01', '2026-09-01T00:00:00Z', ''])(
    'rejects %j',
    (value) => {
      expect(() => parseDateOnly(value)).toThrow(RangeError);
    },
  );

  it('accepts leap days only in leap years', () => {
    expect(formatDateOnly(parseDateOnly('2028-02-29'))).toBe('2028-02-29');
    expect(() => parseDateOnly('2027-02-29')).toThrow(RangeError);
  });
});
