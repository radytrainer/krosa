import type { Event } from '@sentry/node';
import { initSentry, reportError, scrubEvent } from './sentry.js';

describe('scrubEvent', () => {
  it('keeps only the request method and path', () => {
    const event: Event = {
      request: {
        method: 'POST',
        url: 'https://scores.example.edu/api/v1/auth/login?next=/admin&token=abc',
        headers: { cookie: 'ssrs_at=secret', 'x-csrf-token': 'tok' },
        cookies: { ssrs_rt: 'secret' },
        data: { identifier: 'admin', password: 'Correct-Horse-2026' },
        query_string: 'token=abc',
      },
      user: { id: 'u1', ip_address: '203.0.113.9', username: 'admin' },
      breadcrumbs: [{ category: 'console', message: 'ok', data: { password: 'x' } }],
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request).toEqual({
      method: 'POST',
      url: 'https://scores.example.edu/api/v1/auth/login',
    });
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.breadcrumbs).toEqual([{ category: 'console', message: 'ok' }]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/secret|Correct-Horse|tok|abc|203\.0\.113/);
  });

  it('leaves events without request data alone', () => {
    expect(scrubEvent({ message: 'boom' })).toEqual({ message: 'boom' });
  });
});

describe('initSentry', () => {
  it('stays disabled without a DSN, and reporting is then a no-op', () => {
    expect(initSentry({ dsn: undefined, environment: 'test', service: 'api' })).toBe(false);
    expect(() => reportError(new Error('ignored'))).not.toThrow();
  });
});
