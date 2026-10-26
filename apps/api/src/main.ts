import 'reflect-metadata';
import { initSentry, loadRootEnv } from '@ssrs/shared/node';
import { createApp } from './bootstrap.js';
import { loadApiEnv } from './config/env.js';

loadRootEnv();
const env = loadApiEnv();
initSentry({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  service: 'api',
});
const app = await createApp(env);
await app.listen(env.API_PORT, '0.0.0.0');
