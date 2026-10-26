import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadRootEnv } from '@ssrs/shared/node';
import { Logger } from 'nestjs-pino';
import { loadWorkerEnv } from './config/env.js';
import { WorkerModule } from './worker.module.js';

loadRootEnv();
const env = loadWorkerEnv();

// Application context only: the worker exposes no HTTP surface.
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
// SIGTERM/SIGINT trigger onApplicationShutdown hooks (BullMQ workers close gracefully there).
app.enableShutdownHooks();
await app.init();
