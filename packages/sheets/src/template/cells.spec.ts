import {
  cellText,
  parseBooleanCell,
  parseDecimalCell,
  parseGenderCell,
  parseIntegerCell,
  parseMarkCell,
} from './cells.js';

describe('cellText', () => {
  it('trims and maps empties to null', () => {
    expect(cellText('  ST001 ')).toBe('ST001');
    expect(cellText('   ')).toBeNull();
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
    expect(cellText(1001)).toBe('1001');
    expect(cellText(true)).toBe('TRUE');
  });
});

describe('parseMarkCell', () => {
  it.each([
    [8, '8'],
    [41.5, '41.5'],
    ['  7.25 ', '7.25'],
    [0, '0'],
    [50, '50'],
    [12.125, '12.125'],
  ])('accepts %j as a recorded mark', (input, mark) => {
    expect(parseMarkCell(input, '50')).toEqual({ kind: 'mark', status: 'RECORDED', mark });
  });

  it('treats blanks as "not entered", never zero', () => {
    expect(parseMarkCell(null, '10')).toEqual({ kind: 'blank' });
    expect(parseMarkCell('  ', '10')).toEqual({ kind: 'blank' });
    expect(parseMarkCell(undefined, '10')).toEqual({ kind: 'blank' });
  });

  it('accepts ABS (case-insensitive) as an explicit absent zero', () => {
    expect(parseMarkCell('abs', '10')).toEqual({ kind: 'mark', status: 'ABSENT', mark: '0' });
    expect(parseMarkCell(' ABS ', '10')).toEqual({ kind: 'mark', status: 'ABSENT', mark: '0' });
  });

  it.each([
    [-1, 'between 0 and 10'],
    [10.5, 'between 0 and 10'],
    ['8,5', 'dot as the decimal separator'],
    [0.1 + 0.2, 'at most 3 decimal places'],
    [1 / 3, 'at most 3 decimal places'],
    ['EX', 'Expected a number'],
    ['8 marks', 'Expected a number'],
    [true, 'Expected a number'],
    [Number.NaN, 'Expected a number'],
    [1e21, 'between 0 and 10'],
  ])('rejects %j', (input, message) => {
    const result = parseMarkCell(input, '10');
    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.message).toContain(message);
  });
});

describe('parseDecimalCell', () => {
  it('supports exclusive minimums (weights, max marks)', () => {
    const rules = { maxDecimals: 3, min: '0', minExclusive: true, max: '100' };
    expect(parseDecimalCell(0, rules)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(parseDecimalCell('0.001', rules)).toEqual({ ok: true, value: '0.001' });
    expect(parseDecimalCell(100, rules)).toEqual({ ok: true, value: '100' });
    expect(parseDecimalCell(100.001, rules)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
  });
});

describe('other cells', () => {
  it('parses booleans from checkboxes and text', () => {
    expect(parseBooleanCell(true)).toBe(true);
    expect(parseBooleanCell('FALSE')).toBe(false);
    expect(parseBooleanCell('yes')).toBe(true);
    expect(parseBooleanCell(null)).toBeNull();
    expect(parseBooleanCell('maybe')).toBeUndefined();
  });

  it('maps genders and flags unknown values', () => {
    expect(parseGenderCell('F')).toEqual({ gender: 'FEMALE', recognized: true });
    expect(parseGenderCell('male')).toEqual({ gender: 'MALE', recognized: true });
    expect(parseGenderCell('')).toEqual({ gender: 'UNSPECIFIED', recognized: true });
    expect(parseGenderCell('x')).toEqual({ gender: 'UNSPECIFIED', recognized: false });
  });

  it('parses bounded integers', () => {
    expect(parseIntegerCell(3, 1, 5)).toBe(3);
    expect(parseIntegerCell(' 5 ', 1, 5)).toBe(5);
    expect(parseIntegerCell(6, 1, 5)).toBeNull();
    expect(parseIntegerCell(2.5, 1, 5)).toBeNull();
    expect(parseIntegerCell('T1', 1, 5)).toBeNull();
  });
});
