import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SheetsAccessError } from '@ssrs/sheets';

/**
 * Converts Google access failures into HTTP errors:
 *  422 – the admin can fix it (share the file, fix the URL)
 *  503 – temporary or server configuration problem (quota, outage, missing credentials)
 *  502 – Google rejected our credentials
 */
export function toHttpError(err: unknown): unknown {
  if (!(err instanceof SheetsAccessError)) return err;
  const body = { code: err.code, message: err.message };
  switch (err.code) {
    case 'SHEET_NOT_SHARED':
    case 'SHEET_NOT_FOUND':
      return new UnprocessableEntityException(body);
    case 'GOOGLE_AUTH_FAILED':
      return new BadGatewayException(body);
    case 'RATE_LIMITED':
    case 'GOOGLE_UNAVAILABLE':
    case 'GOOGLE_NOT_CONFIGURED':
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, 502);
  }
}
