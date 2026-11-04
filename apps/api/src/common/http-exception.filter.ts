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
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: 'The request could not be read',
  413: 'The request is too large',
  415: 'The request format is not supported',
};
/** Prisma's codes and the driver's for a database that cannot be reached. */
const DATABASE_DOWN_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  '57P01',
  '57P03',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Body-parser errors carry a 4xx `status` without being HttpExceptions. */
function clientErrorStatus(exception: unknown): number | null {
  if (!isRecord(exception) && !(exception instanceof Error)) return null;
  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
  const value = status ?? statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : null;
}

function isDatabaseDown(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  if (exception.name === 'PrismaClientInitializationError') return true;
  // The adapter nests the driver's error under `cause`, `meta` or `driverAdapterError`.
  const seen = new Set<unknown>();
  const queue: unknown[] = [exception];
  while (queue.length > 0) {
    const item = queue.shift();
    if (typeof item !== 'object' || item === null || seen.has(item)) continue;
    seen.add(item);
    const { code, cause, meta, driverAdapterError, originalCode, kind, errors } = item as Record<
      string,
      unknown
    >;
    if (typeof code === 'string' && DATABASE_DOWN_CODES.has(code)) return true;
    if (typeof originalCode === 'string' && DATABASE_DOWN_CODES.has(originalCode)) return true;
    if (kind === 'DatabaseNotReachable' || kind === 'SocketTimeout') return true;
    queue.push(cause, meta, driverAdapterError, ...(Array.isArray(errors) ? errors : []));
  }
  return false;
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

  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== null) {
    return {
      status: clientStatus,
      body: {
        error: {
          code: DEFAULT_CODES[clientStatus] ?? `HTTP_${clientStatus}`,
          message: CLIENT_ERROR_MESSAGES[clientStatus] ?? 'The request could not be processed',
          requestId,
        },
      },
    };
  }

  if (isDatabaseDown(exception)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The service is temporarily unavailable. Try again shortly.',
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
      if (!(exception instanceof HttpException) && status !== HttpStatus.SERVICE_UNAVAILABLE) {
        reportError(exception, { requestId });
      }
    }
    if (res.headersSent) return;
    const retryAfter = body.error['retryAfterSeconds'];
    if (status === 429 && typeof retryAfter === 'number') {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }
    res.status(status).json(body);
  }
}
