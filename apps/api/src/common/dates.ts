/**
 * Calendar dates (PostgreSQL `date`) travel as `YYYY-MM-DD` strings. They are stored as UTC
 * midnight so no time-zone shift can move a date by a day.
 */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(value: string): Date {
  if (!DATE_ONLY_PATTERN.test(value)) throw new RangeError(`Invalid date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  // Rejects impossible dates such as 2026-02-30 (which Date would roll over).
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  return date;
}

export function formatDateOnly(date: Date): string;
export function formatDateOnly(date: Date | null): string | null;
export function formatDateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
