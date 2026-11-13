import { createHmac, randomBytes } from 'node:crypto';
import { COMMON_PASSWORDS } from '../../apps/api/src/auth/password-policy.js';

/**
 * Test passwords for the browser suites, never hardcoded (scanners flag literals). Same rules as
 * apps/api/test/support/credentials.ts: `TEST_ADMIN_PASSWORD` / `TEST_STUDENT_PASSWORD` when set,
 * otherwise derived from a random seed made once per run. The seed is stored in
 * `TEST_PASSWORD_SEED` by the first caller (the Playwright main process, which imports this through
 * the config), so the workers, global setup and the services it starts all agree.
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

export const testAdminPassword = (): string => testPassword('admin');
export const testStudentPassword = (): string => testPassword('student');

/** A password the policy rejects as common (taken from the policy's own list). */
export function commonPassword(): string {
  const found = [...COMMON_PASSWORDS].find((p) => new Set(p).size > 2);
  if (!found) throw new Error('The password policy lists no common password');
  return found;
}
