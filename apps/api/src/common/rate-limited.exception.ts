import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 with a Retry-After header (set by HttpExceptionFilter from `retryAfterSeconds`). */
export class RateLimitedException extends HttpException {
  constructor(
    public readonly retryAfterSeconds: number,
    code = 'RATE_LIMITED',
    message = 'Too many requests. Try again later.',
  ) {
    super({ code, message, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
