import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareTestDatabase } from '@ssrs/database/testing';
import { loadRootEnv } from '@ssrs/shared/node';
import {
  API_URL,
  E2E,
  ROOT,
  WEB_URL,
  assertPortFree,
  requireBuilt,
  serviceEnv,
  start,
  waitForUrl,
} from './support/stack.js';

export const PIDS_FILE = path.join(ROOT, 'e2e', 'test-results', 'pids.json');

/**
 * Brings up the production builds of the API, worker and web app against the test database, with
 * the Google Sheets fixture (SHEETS_TEST_MODE=fixtures). Starts from an empty, migrated database
 * and one administrator created through the real CLI.
 */
export default async function globalSetup(): Promise<void> {
  loadRootEnv();
  requireBuilt();
  await assertPortFree(E2E.apiPort);
  await assertPortFree(E2E.webPort);

  const env = serviceEnv();
  await prepareTestDatabase(env['DATABASE_URL']);
  // Flush the test Redis (queue and cache) in a plain Node process: Playwright's TypeScript
  // loader cannot load ioredis in-process.
  const flush = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { Redis } = await import('ioredis'); const r = new Redis(process.env.REDIS_URL); await r.flushdb(); await r.quit();",
    ],
    { cwd: path.join(ROOT, 'e2e'), env, encoding: 'utf8' },
  );
  if (flush.status !== 0) throw new Error(`Redis flush failed: ${flush.stderr}`);

  const admin = spawnSync(
    process.execPath,
    [
      'apps/api/dist/cli/create-admin.js',
      '--username',
      E2E.adminUser,
      '--display-name',
      'Registrar',
    ],
    { cwd: ROOT, env, input: E2E.adminPassword, encoding: 'utf8' },
  );
  if (admin.status !== 0) throw new Error(`create-admin failed: ${admin.stderr || admin.stdout}`);

  const api = start('api', ['apps/api/dist/main.js'], env);
  const worker = start('worker', ['apps/worker/dist/main.js'], env);
  const web = start(
    'web',
    [
      path.join(ROOT, 'apps/web/node_modules/next/dist/bin/next'),
      'start',
      '--port',
      String(E2E.webPort),
    ],
    { ...process.env, NODE_ENV: 'production', API_INTERNAL_URL: API_URL },
    path.join(ROOT, 'apps/web'),
  );
  writeFileSync(PIDS_FILE, JSON.stringify([api.pid, worker.pid, web.pid]));

  await waitForUrl(`${API_URL}/api/v1/health/ready`);
  await waitForUrl(`${WEB_URL}/api/v1/health`);
}
