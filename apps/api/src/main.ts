import 'reflect-metadata';
import { loadRootEnv } from '@ssrs/shared/node';
import { createApp } from './bootstrap.js';
import { loadApiEnv } from './config/env.js';

loadRootEnv();
const env = loadApiEnv();
const app = await createApp(env);
await app.listen(env.API_PORT, '0.0.0.0');
