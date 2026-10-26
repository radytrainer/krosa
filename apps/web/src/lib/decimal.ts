/**
 * Exact arithmetic for 3-decimal values (weights, max marks) using integer thousandths, so the
 * live "total = 100" check never suffers from floating-point error. The API re-validates with
 * decimal.js; this only drives the editor's feedback.
 */
const PATTERN = /^\d{1,5}(\.\d{1,3})?$/;

/** `"33.3"` → 33300; null for anything that is not a non-negative number with ≤ 3 dp. */
export function toMilli(value: string): number | null {
  const text = value.trim();
  if (!PATTERN.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}

/** 99500 → `"99.5"`. */
export function fromMilli(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = String(Math.abs(milli % 1000))
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export const HUNDRED_MILLI = 100_000;
