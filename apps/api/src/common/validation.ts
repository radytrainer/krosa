import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { parseDateOnly } from './dates.js';

/** Trims string input before validation. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Validates a real calendar date in `YYYY-MM-DD` form. */
export function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isDateOnly',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: {
        message: `${propertyName.toString()} must be a valid date (YYYY-MM-DD)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          try {
            parseDateOnly(value);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
  };
}

/** Marks/weights arrive as JSON numbers or decimal strings; normalize to a decimal string. */
export const ToDecimalString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value,
  );

/** Non-negative decimal with up to `dp` places and `intDigits` integer digits. */
export function decimalPattern(intDigits: number, dp: number): RegExp {
  return new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,${dp}})?$`);
}
