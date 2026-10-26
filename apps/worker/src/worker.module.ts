import { Module, type DynamicModule } from '@nestjs/common';
import { createSheetsReader } from '@ssrs/sheets';
import { LoggerModule } from 'nestjs-pino';
import { WORKER_ENV, type WorkerEnv } from './config/env.js';
import { HeartbeatService } from './heartbeat/heartbeat.service.js';
import { PrismaService } from './infra/prisma.service.js';
import { RedisService } from './infra/redis.service.js';
import { SHEETS_READER, SyncProcessor } from './sync/sync.processor.js';

@Module({})
export class WorkerModule {
  static forRoot(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            // The worker has no HTTP requests, so tag every log line via pino's mixin.
            mixin: () => ({ service: 'worker' }),
            redact: {
              paths: ['*.password', '*.temporaryPassword', '*.token', '*.privateKey'],
              censor: '[REDACTED]',
            },
            ...(env.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
        }),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: SHEETS_READER, useFactory: () => createSheetsReader(env) },
        PrismaService,
        RedisService,
        HeartbeatService,
        SyncProcessor,
      ],
      exports: [WORKER_ENV, PrismaService, RedisService],
    };
  }
}
