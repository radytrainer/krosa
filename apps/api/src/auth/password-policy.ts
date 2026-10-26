/**
 * Password policy (docs/security.md §2, NIST SP 800-63B): length limits, no composition
 * rules, and rejection of passwords that are common or derived from the account name.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordPolicyViolation =
  'TOO_SHORT' | 'TOO_LONG' | 'CONTAINS_USERNAME' | 'TOO_COMMON' | 'REPEATED_CHARACTER';

/** Frequently breached passwords that satisfy the length rule. Compared case-insensitively. */
const COMMON_PASSWORDS = new Set([
  '0000000000',
  '0123456789',
  '1111111111',
  '1234567890',
  '12345678910',
  '0987654321',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'abc1234567',
  'abcdefghij',
  'admin12345',
  'administrator',
  'asdfghjkl1',
  'baseball123',
  'changeme123',
  'dragon1234',
  'football123',
  'iloveyou12',
  'letmein123',
  'master1234',
  'monkey1234',
  'p@ssw0rd123',
  'passw0rd123',
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'password!',
  'princess123',
  'qazwsxedcrfv',
  'qwerty1234',
  'qwerty12345',
  'qwertyuiop',
  'student123',
  'student1234',
  'sunshine123',
  'trustno1234',
  'welcome123',
  'zxcvbnm123',
]);

export function checkPasswordPolicy(password: string, username: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) violations.push('TOO_SHORT');
  if (length > PASSWORD_MAX_LENGTH) violations.push('TOO_LONG');

  const lower = password.toLowerCase();
  const name = username.trim().toLowerCase();
  if (name.length >= 3 && lower.includes(name)) violations.push('CONTAINS_USERNAME');
  if (COMMON_PASSWORDS.has(lower)) violations.push('TOO_COMMON');
  if (length > 0 && new Set(lower).size === 1) violations.push('REPEATED_CHARACTER');
  return violations;
}

export const PASSWORD_POLICY_MESSAGES: Record<PasswordPolicyViolation, string> = {
  TOO_SHORT: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  TOO_LONG: `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
  CONTAINS_USERNAME: 'Password must not contain your username or student ID.',
  TOO_COMMON: 'This password is too common. Choose something less predictable.',
  REPEATED_CHARACTER: 'Password must not be a single repeated character.',
};
