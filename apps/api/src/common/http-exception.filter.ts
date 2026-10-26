import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { reportError } from '@ssrs/shared/node';

export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
    [extra: string]: unknown;
  };
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts every exception into the standard error envelope (docs/api-specification.md).
 * Unexpected errors are logged with their stack and returned as an opaque 500 so internal
 * details never reach clients.
 */
export function toErrorEnvelope(
  exception: unknown,
  requestId?: string,
): {
  status: number;
  body: ErrorEnvelope;
} {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const fallbackCode = DEFAULT_CODES[status] ?? `HTTP_${status}`;

    if (typeof response === 'string') {
      return { status, body: { error: { code: fallbackCode, message: response, requestId } } };
    }

    const {
      code,
      message,
      details,
      statusCode: _statusCode,
      error: _error,
      ...extra
    } = isRecord(response) ? response : {};

    let finalMessage = exception.message;
    let finalDetails: ErrorDetail[] | undefined = Array.isArray(details)
      ? (details as ErrorDetail[])
      : undefined;

    // class-validator via ValidationPipe produces `message: string[]`.
    if (Array.isArray(message)) {
      finalMessage = 'Request validation failed';
      finalDetails = message.map((m) => ({ message: String(m) }));
    } else if (typeof message === 'string') {
      finalMessage = message;
    }

    return {
      status,
      body: {
        error: {
          ...extra,
          code:
            typeof code === 'string'
              ? code
              : Array.isArray(message)
                ? 'VALIDATION_FAILED'
                : fallbackCode,
          message: finalMessage,
          ...(finalDetails ? { details: finalDetails } : {}),
          requestId,
        },
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId } },
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: unknown }>();
    const res = ctx.getResponse<Response>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    const { status, body } = toErrorEnvelope(exception, requestId);
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
      // Expected dependency failures (503 from Google or the queue) are not bugs.
      if (!(exception instanceof HttpException)) reportError(exception, { requestId });
    }
    if (res.headersSent) return;
    const retryAfter = body.error['retryAfterSeconds'];
    if (status === 429 && typeof retryAfter === 'number') {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }
    res.status(status).json(body);
  }
}
