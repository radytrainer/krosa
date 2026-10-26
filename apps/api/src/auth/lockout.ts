/** Failed attempts allowed before the first lock. */
export const LOCKOUT_THRESHOLD = 5;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 15 * 60_000;

/**
 * Progressive lockout: the 5th consecutive failure locks for 1 minute, each further failure
 * doubles the lock, capped at 15 minutes. Returns null while below the threshold.
 */
export function lockedUntilAfterFailure(failedCount: number, now: Date): Date | null {
  if (failedCount < LOCKOUT_THRESHOLD) return null;
  const exponent = Math.min(failedCount - LOCKOUT_THRESHOLD, 10);
  const duration = Math.min(BASE_LOCK_MS * 2 ** exponent, MAX_LOCK_MS);
  return new Date(now.getTime() + duration);
}
