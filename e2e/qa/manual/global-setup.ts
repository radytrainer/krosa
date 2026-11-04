import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareTestDatabase } from '@ssrs/database/testing';
import { PIDS_FILE } from '../../global-setup.js';
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
} from '../../support/stack.js';

export const SHEETS_DIR = path.join(ROOT, 'e2e', 'test-results', 'sheets');
export const API_ARGS = ['apps/api/test/qa/manual-api.mjs'];

export function manualEnv(): NodeJS.ProcessEnv {
  const env = serviceEnv();
  delete env['SHEETS_TEST_MODE'];
  return { ...env, QA_SHEETS_DIR: SHEETS_DIR };
}

/** Empty test database, one admin, real web app and worker, sheets served from local files. */
export default async function globalSetup(): Promise<void> {
  requireBuilt();
  await assertPortFree(E2E.apiPort);
  await assertPortFree(E2E.webPort);
  rmSync(SHEETS_DIR, { recursive: true, force: true });
  mkdirSync(SHEETS_DIR, { recursive: true });
  const env = manualEnv();
  await prepareTestDatabase(env['DATABASE_URL']);
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

  const api = start('api', API_ARGS, env);
  const worker = start('worker', ['apps/worker/test/qa/manual-worker.mjs'], env, ROOT);
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
