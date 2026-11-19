import { describe, expect, it } from 'vitest';
import { compareNames, normalizeName, type NameParts } from './names.js';

// Made-up names only (the Khmer ones are invented syllables).
const name = (firstName: string | null, lastName: string | null, fullName?: string): NameParts => ({
  firstName,
  lastName,
  fullName: fullName ?? [firstName, lastName].filter(Boolean).join(' '),
});

describe('normalizeName', () => {
  it('composes (NFC), trims, collapses spaces and folds case', () => {
    expect(normalizeName('  René   TEST\t ')).toBe('rené test');
    expect(normalizeName(null)).toBe('');
  });

  it('treats zero-width characters as spaces', () => {
    expect(normalizeName('​Alpha​Beta﻿')).toBe('alpha beta');
    expect(normalizeName('ឃ្វុប​ផ្អឹម')).toBe('ឃ្វុប ផ្អឹម');
  });
});

describe('compareNames', () => {
  it('finds the same name despite case, spaces and composition', () => {
    expect(compareNames(name('ALPHA', 'Beta'), name(' alpha ', 'BETA  '))).toBe('SAME');
    expect(compareNames(name('René', 'Test'), name('René', 'TEST'))).toBe('SAME');
  });

  it('calls swapped first and last names the same name in another order', () => {
    expect(compareNames(name('Alpha', 'Beta'), name('Beta', 'Alpha'))).toBe('ORDER');
  });

  it('compares full names word by word when a side has no split', () => {
    expect(compareNames(name(null, null, 'Gamma Delta'), name('Gamma', 'Delta'))).toBe('SAME');
    expect(compareNames(name(null, null, 'Delta Gamma'), name('Gamma', 'Delta'))).toBe('ORDER');
    expect(compareNames(name(null, null, 'Delta Epsilon'), name('Gamma', 'Delta'))).toBe(
      'DIFFERENT',
    );
  });

  it('reports another name as different', () => {
    expect(compareNames(name('Alpha', 'Beta'), name('Alpha', 'Gamma'))).toBe('DIFFERENT');
    expect(compareNames(name('Alpha', 'Beta'), name('Alphb', 'Beta'))).toBe('DIFFERENT');
  });

  it('handles Khmer names, including zero-width separators and swapped order', () => {
    expect(compareNames(name('ឃ្វុប', 'ផ្អឹម'), name('ឃ្វុប', 'ផ្អឹម'))).toBe('SAME');
    expect(compareNames(name(null, null, 'ឃ្វុប​ផ្អឹម'), name('ឃ្វុប', 'ផ្អឹម'))).toBe('SAME');
    expect(compareNames(name('ផ្អឹម', 'ឃ្វុប'), name('ឃ្វុប', 'ផ្អឹម'))).toBe('ORDER');
    expect(compareNames(name('ឃ្វុប', 'ឡុគ្យ'), name('ឃ្វុប', 'ផ្អឹម'))).toBe('DIFFERENT');
  });
});
