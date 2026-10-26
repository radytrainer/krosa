import { normalizeStudentId } from './student-id.js';

describe('normalizeStudentId', () => {
  it.each([
    ['ST001', 'ST001'],
    ['  st001 ', 'ST001'],
    [' gen26-0001​', 'GEN26-0001'],
    ['a_b-1', 'A_B-1'],
    [1001, '1001'],
    [0, '0'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeStudentId(input)).toEqual({ ok: true, value: expected });
  });

  it.each([[''], ['   '], [null], [undefined]])('rejects empty value %j', (input) => {
    expect(normalizeStudentId(input)).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it.each([
    ['ST 001'],
    ['-ST001'],
    ['ST001!'],
    ['ÉT001'],
    ['A'.repeat(33)],
    [12.5],
    [-3],
    [Number.MAX_SAFE_INTEGER + 2],
  ])('rejects malformed value %j', (input) => {
    expect(normalizeStudentId(input)).toEqual({ ok: false, reason: 'INVALID_FORMAT' });
  });

  it('rejects non-string, non-number input', () => {
    expect(normalizeStudentId({ id: 'ST001' })).toEqual({ ok: false, reason: 'INVALID_TYPE' });
    expect(normalizeStudentId(true)).toEqual({ ok: false, reason: 'INVALID_TYPE' });
  });

  it('accepts the maximum length of 32 characters', () => {
    const id = 'A'.repeat(32);
    expect(normalizeStudentId(id)).toEqual({ ok: true, value: id });
  });
});
