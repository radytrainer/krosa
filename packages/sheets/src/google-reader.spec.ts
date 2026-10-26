import { classifyGoogleError, toSheetsAccessError } from './google-reader.js';
import { wholeTabRange } from './reader.js';

const httpError = (status: number, headers?: Record<string, string>) =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, headers: new Headers(headers) },
  });

describe('Google error handling', () => {
  it('classifies transient statuses and network errors as retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyGoogleError(httpError(status)).retryable).toBe(true);
    }
    for (const status of [400, 401, 403, 404]) {
      expect(classifyGoogleError(httpError(status)).retryable).toBe(false);
    }
    expect(
      classifyGoogleError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).retryable,
    ).toBe(true);
    expect(classifyGoogleError(new Error('bug')).retryable).toBe(false);
  });

  it('reads Retry-After', () => {
    expect(classifyGoogleError(httpError(429, { 'retry-after': '7' })).retryAfterMs).toBe(7000);
  });

  it('maps statuses to actionable codes and mentions the service account to share with', () => {
    const notShared = toSheetsAccessError(
      httpError(403),
      'sync@example-project.iam.gserviceaccount.com',
    );
    expect(notShared.code).toBe('SHEET_NOT_SHARED');
    expect(notShared.message).toContain('sync@example-project.iam.gserviceaccount.com');
    expect(toSheetsAccessError(httpError(404), null).code).toBe('SHEET_NOT_FOUND');
    expect(toSheetsAccessError(httpError(401), null).code).toBe('GOOGLE_AUTH_FAILED');
    expect(toSheetsAccessError(httpError(429), null)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(toSheetsAccessError(httpError(503), null)).toMatchObject({
      code: 'GOOGLE_UNAVAILABLE',
      retryable: true,
    });
    expect(toSheetsAccessError(new Error('private_key=-----BEGIN'), null).message).not.toContain(
      'BEGIN',
    );
  });
});

describe('wholeTabRange', () => {
  it('quotes titles and escapes single quotes', () => {
    expect(wholeTabRange('T1 Math')).toBe("'T1 Math'");
    expect(wholeTabRange("Teacher's tab")).toBe("'Teacher''s tab'");
  });
});
