import { Decimal } from 'decimal.js';

/**
 * Isolated Decimal constructor for grading. High precision so intermediate results are
 * effectively exact; rounding happens once, explicitly, at the presentation boundary.
 */
export const GradeDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type GradeDecimal = InstanceType<typeof GradeDecimal>;

/** Decimal places for displayed contributions, final scores and averages. */
export const SCORE_DP = 2;
/** Decimal places stored for marks, max marks and weights (numeric(…, 3) columns). */
export const VALUE_DP = 3;

export type DecimalInput = string | number | { toString(): string };

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** Strict parse: rejects NaN/Infinity, exponent notation, locale commas and empty strings. */
export function toDecimal(value: DecimalInput): GradeDecimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
    return new GradeDecimal(value);
  }
  const text = value.toString().trim();
  if (!DECIMAL_STRING.test(text)) throw new RangeError(`Not a decimal number: "${text}"`);
  return new GradeDecimal(text);
}

export function tryDecimal(value: DecimalInput): GradeDecimal | null {
  try {
    return toDecimal(value);
  } catch {
    return null;
  }
}

/** Half-up rounding to a fixed number of places, as a string (e.g. "86.75"). */
export function formatFixed(value: GradeDecimal, dp: number): string {
  return value.toDecimalPlaces(dp, GradeDecimal.ROUND_HALF_UP).toFixed(dp);
}
