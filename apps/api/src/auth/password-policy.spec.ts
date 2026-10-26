import { checkPasswordPolicy } from './password-policy.js';

describe('checkPasswordPolicy', () => {
  it('accepts a long, uncommon password', () => {
    expect(checkPasswordPolicy('correct horse battery staple', 'GEN26-0001')).toEqual([]);
  });

  it('enforces length limits (counting code points)', () => {
    expect(checkPasswordPolicy('short', 'user')).toContain('TOO_SHORT');
    expect(checkPasswordPolicy('a'.repeat(129) + 'b', 'user')).toContain('TOO_LONG');
    // 10 emoji = 10 code points (20 UTF-16 units).
    expect(checkPasswordPolicy('🎓📚🧪🔬🧮📐📏🖊️✏', 'user')).not.toContain('TOO_SHORT');
  });

  it('rejects passwords containing the username, case-insensitively', () => {
    expect(checkPasswordPolicy('my-gen26-0001-pass', 'GEN26-0001')).toContain('CONTAINS_USERNAME');
    expect(checkPasswordPolicy('Admin-is-great-2026', 'admin')).toContain('CONTAINS_USERNAME');
  });

  it('rejects common passwords and repeated characters', () => {
    expect(checkPasswordPolicy('Password123', 'someone')).toContain('TOO_COMMON');
    expect(checkPasswordPolicy('zzzzzzzzzzzz', 'someone')).toContain('REPEATED_CHARACTER');
  });
});
