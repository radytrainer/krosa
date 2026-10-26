import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with Argon2id using the configured parameters', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    // Parameter order in the PHC string is library-defined; check each one.
    expect(hash).toMatch(/[$,]m=19456[,$]/);
    expect(hash).toMatch(/[$,]t=2[,$]/);
    expect(hash).toMatch(/[$,]p=1[,$]/);
    expect(hash).not.toContain('correct horse');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('flags hashes with weaker parameters for rehash and tolerates malformed hashes', async () => {
    expect(
      service.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA'),
    ).toBe(true);
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('dummy verification always fails', async () => {
    await expect(service.verifyDummy('anything')).resolves.toBe(false);
  });

  it('generates unambiguous, grouped, policy-compliant temporary passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = service.generateTemporaryPassword();
      expect(pw).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });

  it('unusable (locked) hashes never verify', async () => {
    const hash = service.unusableHash();
    expect(hash.startsWith('!locked:')).toBe(true);
    await expect(service.verify(hash, '')).resolves.toBe(false);
    await expect(service.verify(hash, hash)).resolves.toBe(false);
  });
});
