import { tryDecimal } from '@ssrs/shared';
import type { CellValue } from '../reader.js';
import type { Gender } from './constants.js';

/** Trimmed text of a cell; null when empty. Integers render without decimals. */
export function cellText(value: CellValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

export function isBlank(value: CellValue | undefined): boolean {
  return cellText(value) === null;
}

export type DecimalFailure =
  'NOT_A_NUMBER' | 'COMMA_DECIMAL' | 'TOO_MANY_DECIMALS' | 'OUT_OF_RANGE';

export interface DecimalRules {
  maxDecimals: number;
  /** Exclusive lower bound when `minExclusive`, inclusive otherwise. */
  min: string;
  minExclusive?: boolean;
  max: string;
}

/**
 * Strict decimal parsing for sheet cells. Never rounds: a value with more decimals than allowed
 * (often a formula result such as =A1/3) is rejected so staff enter the intended value.
 */
export function parseDecimalCell(
  value: CellValue | undefined,
  rules: DecimalRules,
): { ok: true; value: string } | { ok: false; reason: DecimalFailure } {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, reason: 'NOT_A_NUMBER' };
    text = String(value);
    if (/e/i.test(text)) return { ok: false, reason: 'OUT_OF_RANGE' };
  } else if (typeof value === 'string') {
    text = value.trim();
    if (/^-?\d+,\d+$/.test(text)) return { ok: false, reason: 'COMMA_DECIMAL' };
  } else {
    return { ok: false, reason: 'NOT_A_NUMBER' };
  }
  const decimal = tryDecimal(text);
  if (!decimal) return { ok: false, reason: 'NOT_A_NUMBER' };
  if (decimal.decimalPlaces() > rules.maxDecimals)
    return { ok: false, reason: 'TOO_MANY_DECIMALS' };
  const belowMin = rules.minExclusive ? decimal.lte(rules.min) : decimal.lt(rules.min);
  if (belowMin || decimal.gt(rules.max)) return { ok: false, reason: 'OUT_OF_RANGE' };
  return { ok: true, value: decimal.toString() };
}

export type MarkCell =
  | { kind: 'blank' }
  | { kind: 'mark'; status: 'RECORDED' | 'ABSENT'; mark: string }
  | { kind: 'invalid'; message: string };

export const ABSENT_TOKEN = 'ABS';

/** A mark: number in 0…maxMark (≤ 3 dp), "ABS", or blank. Anything else is invalid. */
export function parseMarkCell(value: CellValue | undefined, maxMark: string): MarkCell {
  if (isBlank(value)) return { kind: 'blank' };
  if (typeof value === 'string' && value.trim().toUpperCase() === ABSENT_TOKEN) {
    return { kind: 'mark', status: 'ABSENT', mark: '0' };
  }
  if (typeof value === 'boolean')
    return { kind: 'invalid', message: 'Expected a number, ABS or an empty cell.' };

  const parsed = parseDecimalCell(value, { maxDecimals: 3, min: '0', max: maxMark });
  if (parsed.ok) return { kind: 'mark', status: 'RECORDED', mark: parsed.value };
  switch (parsed.reason) {
    case 'COMMA_DECIMAL':
      return { kind: 'invalid', message: 'Use a dot as the decimal separator (e.g. 8.5).' };
    case 'TOO_MANY_DECIMALS':
      return { kind: 'invalid', message: 'Marks may have at most 3 decimal places.' };
    case 'OUT_OF_RANGE':
      return { kind: 'invalid', message: `Mark must be between 0 and ${maxMark}.` };
    default:
      return { kind: 'invalid', message: 'Expected a number, ABS or an empty cell.' };
  }
}

/** TRUE/FALSE (checkbox or text, also yes/no). null = blank, undefined = unrecognized. */
export function parseBooleanCell(value: CellValue | undefined): boolean | null | undefined {
  if (typeof value === 'boolean') return value;
  const text = cellText(value)?.toLowerCase();
  if (text === undefined || text === null) return null;
  if (['true', 'yes', 'y', '1'].includes(text)) return true;
  if (['false', 'no', 'n', '0'].includes(text)) return false;
  return undefined;
}

const GENDERS: Record<string, Gender> = {
  f: 'FEMALE',
  female: 'FEMALE',
  m: 'MALE',
  male: 'MALE',
  o: 'OTHER',
  other: 'OTHER',
};

export function parseGenderCell(value: CellValue | undefined): {
  gender: Gender;
  recognized: boolean;
} {
  const text = cellText(value)?.toLowerCase();
  if (!text) return { gender: 'UNSPECIFIED', recognized: true };
  const gender = GENDERS[text];
  return gender ? { gender, recognized: true } : { gender: 'UNSPECIFIED', recognized: false };
}

/** Whole number within bounds (numbers or numeric text). */
export function parseIntegerCell(
  value: CellValue | undefined,
  min: number,
  max: number,
): number | null {
  const text = cellText(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
