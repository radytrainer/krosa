import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([k, v]) => hasNul(k) || hasNul(v));
  }
  return false;
}

/** PostgreSQL text cannot hold U+0000, so it is refused for every route before any query runs. */
export class RejectNulPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'custom' && hasNul(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: [{ message: 'Text must not contain a NUL character' }],
      });
    }
    return value;
  }
}
