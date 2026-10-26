import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { toErrorEnvelope } from './http-exception.filter.js';

describe('toErrorEnvelope', () => {
  it('maps a plain HttpException to a default code', () => {
    const { status, body } = toErrorEnvelope(new NotFoundException('Student not found'), 'req-1');
    expect(status).toBe(404);
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Student not found', requestId: 'req-1' },
    });
  });

  it('preserves an explicit code and extra fields', () => {
    const { body } = toErrorEnvelope(
      new ConflictException({ code: 'SYNC_IN_PROGRESS', message: 'Already running', jobId: 'j1' }),
    );
    expect(body.error).toMatchObject({
      code: 'SYNC_IN_PROGRESS',
      message: 'Already running',
      jobId: 'j1',
    });
  });

  it('turns ValidationPipe message arrays into details', () => {
    const { status, body } = toErrorEnvelope(
      new BadRequestException(['name should not be empty', 'code must match pattern']),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual([
      { message: 'name should not be empty' },
      { message: 'code must match pattern' },
    ]);
  });

  it('keeps structured readiness information on 503', () => {
    const { status, body } = toErrorEnvelope(
      new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        checks: { redis: 'down' },
      }),
    );
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', checks: { redis: 'down' } });
  });

  it('hides internal error details', () => {
    const { status, body } = toErrorEnvelope(new Error('connection string postgres://secret'));
    expect(status).toBe(500);
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
