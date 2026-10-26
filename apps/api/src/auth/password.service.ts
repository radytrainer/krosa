import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { lockedPasswordHash } from '@ssrs/shared/node';
import argon2 from 'argon2';

/** OWASP minimum recommendation for Argon2id (docs/security.md §2). */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 16;
/** Largest multiple of the alphabet size ≤ 256, for unbiased sampling. */
const TEMP_ALPHABET_LIMIT = 256 - (256 % TEMP_ALPHABET.length);

@Injectable()
export class PasswordService {
  /** Hash used to equalize timing when the account does not exist. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Malformed or unusable hash.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      return true;
    }
  }

  /** Performs a full verification against a throwaway hash and always returns false. */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    await this.verify(await this.dummyHash, password);
    return false;
  }

  /**
   * One-time temporary password: 16 characters from an alphabet without look-alikes
   * (no 0/O, 1/l/I), grouped for dictation, ~79 bits of entropy.
   * Uses rejection sampling so every character is uniformly likely.
   */
  generateTemporaryPassword(): string {
    const chars: string[] = [];
    while (chars.length < TEMP_PASSWORD_LENGTH) {
      for (const byte of randomBytes(32)) {
        if (byte < TEMP_ALPHABET_LIMIT && chars.length < TEMP_PASSWORD_LENGTH) {
          chars.push(TEMP_ALPHABET.charAt(byte % TEMP_ALPHABET.length));
        }
      }
    }
    return chars.join('').replace(/(.{4})(?=.)/g, '$1-');
  }

  /**
   * A hash value that can never verify, for accounts that must exist but cannot log in yet
   * (PENDING students before credentials are issued). See @ssrs/shared/node lockedPasswordHash.
   */
  unusableHash(): string {
    return lockedPasswordHash();
  }
}
