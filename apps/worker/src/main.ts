import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { flushSentry, initSentry, loadRootEnv } from '@ssrs/shared/node';
import { Logger } from 'nestjs-pino';
import { loadWorkerEnv } from './config/env.js';
import { WorkerModule } from './worker.module.js';

loadRootEnv();
const env = loadWorkerEnv();
initSentry({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  service: 'worker',
});

// Application context only: the worker exposes no HTTP surface.
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
// SIGTERM/SIGINT trigger onApplicationShutdown hooks (BullMQ workers close gracefully there).
app.enableShutdownHooks();
process.once('beforeExit', () => void flushSentry());
await app.init();
