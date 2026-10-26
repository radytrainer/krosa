import { randomBytes } from 'node:crypto';

/**
 * A password-hash value that can never verify (Unix "!" convention). Used for accounts that
 * must exist but cannot sign in yet: students provisioned by sync stay PENDING until an admin
 * issues credentials. It is not a PHC string, so Argon2 verification always fails, and creating
 * it costs nothing (provisioning 2,000 students must not spend minutes hashing).
 */
export const LOCKED_PASSWORD_PREFIX = '!locked:';

export function lockedPasswordHash(): string {
  return `${LOCKED_PASSWORD_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function isLockedPasswordHash(hash: string): boolean {
  return hash.startsWith(LOCKED_PASSWORD_PREFIX);
}
