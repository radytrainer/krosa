/**
 * Student ID normalization. The business student ID is the login identifier and the key
 * used to match spreadsheet rows, so normalization must be deterministic and must never
 * "repair" values in a way that could merge two different students.
 *
 * Rules: trim surrounding whitespace (including NBSP / zero-width characters), uppercase,
 * then require ^[A-Z0-9][A-Z0-9_-]{0,31}$. Inner whitespace is rejected, not collapsed.
 * Integer numbers (as returned by Sheets for unformatted numeric cells) are accepted.
 */
export const STUDENT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

// Invisible characters that `String.prototype.trim` does not remove but spreadsheets often contain.
const ZERO_WIDTH = new Set(['​', '‌', '‍', '⁠']);

function isEdgeChar(c: string | undefined): boolean {
  return c !== undefined && (ZERO_WIDTH.has(c) || c.trim() === '');
}

function trimEdges(text: string): string {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && isEdgeChar(chars[start])) start++;
  while (end > start && isEdgeChar(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}

export type StudentIdResult =
  { ok: true; value: string } | { ok: false; reason: 'EMPTY' | 'INVALID_TYPE' | 'INVALID_FORMAT' };

export function normalizeStudentId(raw: unknown): StudentIdResult {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return { ok: false, reason: 'INVALID_FORMAT' };
    text = String(raw);
  } else if (raw === null || raw === undefined) {
    return { ok: false, reason: 'EMPTY' };
  } else {
    return { ok: false, reason: 'INVALID_TYPE' };
  }

  const value = trimEdges(text).toUpperCase();
  if (value.length === 0) return { ok: false, reason: 'EMPTY' };
  if (!STUDENT_ID_PATTERN.test(value)) return { ok: false, reason: 'INVALID_FORMAT' };
  return { ok: true, value };
}
