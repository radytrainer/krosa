import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** One tab detection per source at a time. A lease, so a crashed run cannot block it for good. */
export const DETECT_LOCK_LEASE_MS = 120_000;

export const detectLockKey = (sourceId: string) => `ssrs:v1:detect-lock:${sourceId}`;

/** Deletes the key only while it still holds this run's token (never another run's lock). */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Takes the lock for one detection run. Returns the run's token, or null when another run holds
 * it. Throws when Redis cannot be reached (the caller decides what that means).
 */
export async function acquireDetectLock(redis: Redis, sourceId: string): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(detectLockKey(sourceId), token, 'PX', DETECT_LOCK_LEASE_MS, 'NX');
  return ok === 'OK' ? token : null;
}

export async function releaseDetectLock(
  redis: Redis,
  sourceId: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE, 1, detectLockKey(sourceId), token);
}
