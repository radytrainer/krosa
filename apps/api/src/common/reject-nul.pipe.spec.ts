import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { RejectNulPipe } from './reject-nul.pipe.js';

describe('RejectNulPipe', () => {
  const pipe = new RejectNulPipe();
  const body: ArgumentMetadata = { type: 'body' };

  it.each([
    ['a string', 'a\u0000b'],
    ['a nested value', { a: [{ b: 'x\u0000' }] }],
    ['a key', { 'a\u0000': 1 }],
  ])('refuses %s', (_, value) => {
    expect(() => pipe.transform(value, body)).toThrow(BadRequestException);
  });

  it('passes other values, and skips values from decorators', () => {
    const value = { a: ['fine'], n: 1, none: null };
    expect(pipe.transform(value, body)).toBe(value);
    expect(pipe.transform('a\u0000b', { type: 'custom' })).toBe('a\u0000b');
  });
});
