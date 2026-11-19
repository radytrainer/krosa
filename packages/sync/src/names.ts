/**
 * Comparing a student's name in the sheet's `ALL` tab with the stored one (decisions.md RP6).
 * Names never reach a logger or an audit entry; they appear only in admin-only issue data.
 */

export interface NameParts {
  firstName: string | null;
  lastName: string | null;
  fullName: string;
}

/** SAME: the same name. ORDER: the same words in another order. DIFFERENT: another name. */
export type NameComparison = 'SAME' | 'ORDER' | 'DIFFERENT';

// Zero-width space, joiners, word joiner and BOM. Khmer uses U+200B between words in some text,
// so it is treated as a space, never removed outright (that would join two words).
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** NFC, zero-width characters as spaces, trimmed, whitespace collapsed, case-folded. */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value.normalize('NFC').replace(ZERO_WIDTH, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

const words = (value: string) => value.split(' ').filter(Boolean);
const sortedWords = (value: string) => words(value).toSorted().join(' ');

function fullOf(name: NameParts): string {
  const full = normalizeName(name.fullName);
  if (full) return full;
  return normalizeName([name.firstName, name.lastName].filter(Boolean).join(' '));
}

/**
 * Compares two names. With a first and a last name on both sides they must match part by part;
 * swapped parts are the same name in another order. Otherwise the full names are compared, and
 * the same words in another order are the same name too.
 */
export function compareNames(sheet: NameParts, stored: NameParts): NameComparison {
  const a = { first: normalizeName(sheet.firstName), last: normalizeName(sheet.lastName) };
  const b = { first: normalizeName(stored.firstName), last: normalizeName(stored.lastName) };
  if (a.first && a.last && b.first && b.last) {
    if (a.first === b.first && a.last === b.last) return 'SAME';
    if (a.first === b.last && a.last === b.first) return 'ORDER';
  }
  const fullA = fullOf(sheet);
  const fullB = fullOf(stored);
  if (!fullA || !fullB) return fullA === fullB ? 'SAME' : 'DIFFERENT';
  if (fullA === fullB) return 'SAME';
  return sortedWords(fullA) === sortedWords(fullB) ? 'ORDER' : 'DIFFERENT';
}
