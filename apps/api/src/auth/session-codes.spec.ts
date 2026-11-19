import { liveReasonFor } from './live.service.js';
import { rejectCodeFor, toEndReason } from './session.service.js';

describe('session end codes', () => {
  it('maps revoke reasons to 401 codes', () => {
    expect(rejectCodeFor('SIGNED_IN_ELSEWHERE')).toBe('SESSION_REPLACED');
    expect(rejectCodeFor('IDLE_TIMEOUT')).toBe('SESSION_IDLE');
    for (const other of [
      'LOGOUT',
      'REUSE_DETECTED',
      'PASSWORD_RESET',
      'MISSING',
      'EXPIRED',
      null,
    ]) {
      expect(rejectCodeFor(other)).toBe('SESSION_REVOKED');
    }
  });

  it('reports only three reasons on the live stream', () => {
    expect(liveReasonFor('SIGNED_IN_ELSEWHERE')).toBe('SIGNED_IN_ELSEWHERE');
    expect(liveReasonFor('IDLE_TIMEOUT')).toBe('IDLE_TIMEOUT');
    for (const other of ['LOGOUT', 'ACCOUNT_DELETED', 'NOT_ACTIVE', 'anything']) {
      expect(liveReasonFor(other)).toBe('REVOKED');
    }
  });

  it('reads denylist values, including the legacy "1"', () => {
    expect(toEndReason('SIGNED_IN_ELSEWHERE')).toBe('SIGNED_IN_ELSEWHERE');
    expect(toEndReason('1')).toBe('ADMIN');
  });
});
