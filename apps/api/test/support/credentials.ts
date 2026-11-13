import { createHmac, randomBytes } from 'node:crypto';
import { COMMON_PASSWORDS } from '../../src/auth/password-policy.js';

/**
 * Test passwords, never hardcoded (scanners flag literals). `TEST_ADMIN_PASSWORD` and
 * `TEST_STUDENT_PASSWORD` are used when set; every other password, and those two when unset, is
 * derived from a random seed made once per run. The seed is kept in `TEST_PASSWORD_SEED`, so
 * child processes started later derive the same values. Generated values are 24 characters and
 * meet the password policy (length, not common, not containing a username).
 */
const SEED_ENV = 'TEST_PASSWORD_SEED';
const FROM_ENV: Record<string, string> = {
  admin: 'TEST_ADMIN_PASSWORD',
  student: 'TEST_STUDENT_PASSWORD',
};

function seed(): string {
  let value = process.env[SEED_ENV];
  if (!value) {
    value = randomBytes(32).toString('hex');
    process.env[SEED_ENV] = value;
  }
  return value;
}

/** The password for `label`: the same value for the whole run, different for each label. */
export function testPassword(label: string): string {
  const configured = FROM_ENV[label] ? process.env[FROM_ENV[label]]?.trim() : undefined;
  if (configured) return configured;
  return `Kt${createHmac('sha256', seed()).update(label).digest('base64url').slice(0, 22)}`;
}

/**
 * A signing secret for `label` (for example the API's JWT_ACCESS_SECRET): 43 characters, derived
 * from the same per-run seed, so the services started by a test and the test itself agree.
 */
export function testSecret(label: string): string {
  return createHmac('sha256', seed()).update(`secret:${label}`).digest('base64url');
}

export const testAdminPassword = (): string => testPassword('admin');
export const testStudentPassword = (): string => testPassword('student');

/** A password the policy rejects as common (taken from the policy's own list). */
export function commonPassword(): string {
  const found = [...COMMON_PASSWORDS].find((p) => new Set(p).size > 2);
  if (!found) throw new Error('The password policy lists no common password');
  return found;
}
