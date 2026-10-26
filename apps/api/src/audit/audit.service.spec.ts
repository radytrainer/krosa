import { scrubMetadata } from './audit.service.js';

describe('scrubMetadata', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(
      scrubMetadata({
        username: 'admin',
        password: 'hunter2',
        nested: { refreshToken: 'abc', apiSecret: 'x', privateKey: 'k', ok: 1 },
        list: [{ passwordHash: '$argon2id$...' }],
      }),
    ).toEqual({
      username: 'admin',
      password: '[REDACTED]',
      nested: {
        refreshToken: '[REDACTED]',
        apiSecret: '[REDACTED]',
        privateKey: '[REDACTED]',
        ok: 1,
      },
      list: [{ passwordHash: '[REDACTED]' }],
    });
  });

  it('bounds string length and depth', () => {
    const out = scrubMetadata({ long: 'x'.repeat(600), a: { b: { c: { d: { e: 1 } } } } }) as {
      long: string;
      a: { b: { c: { d: unknown } } };
    };
    expect(out.long.length).toBe(501);
    expect(out.a.b.c.d).toBe('[TRUNCATED]');
  });

  it('serializes dates', () => {
    expect(scrubMetadata({ at: new Date('2026-10-26T00:00:00Z') })).toEqual({
      at: '2026-10-26T00:00:00.000Z',
    });
  });
});
