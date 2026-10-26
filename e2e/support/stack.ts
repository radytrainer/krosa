import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is e2e/support/stack.ts). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const E2E = {
  webPort: Number(process.env['E2E_WEB_PORT'] ?? 3200),
  apiPort: Number(process.env['E2E_API_PORT'] ?? 4200),
  adminUser: 'admin',
  adminPassword: 'Registrar-E2E-Pass-2026',
};

export const WEB_URL = `http://localhost:${E2E.webPort}`;
export const API_URL = `http://localhost:${E2E.apiPort}`;

/** Environment shared by the API and worker under test: test database, fixture Sheets. */
export function serviceEnv(): NodeJS.ProcessEnv {
  const db = process.env['TEST_DATABASE_URL'];
  const redis = process.env['TEST_REDIS_URL'];
  if (!db || !redis) throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL must be set (.env)');
  if (new URL(redis).pathname !== '/15') {
    throw new Error('TEST_REDIS_URL must select Redis database 15 (it is flushed by tests)');
  }
  return {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL: db,
    REDIS_URL: redis,
    API_PORT: String(E2E.apiPort),
    WEB_ORIGIN: WEB_URL,
    COOKIE_SECURE: 'false',
    SWAGGER_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
    // The scenario signs in a few times from one IP; keep login limits but lift the global one.
    RATE_LIMIT_PER_MINUTE: '10000',
    // Serve the fixture workbook; takes precedence over any Google credentials in .env.
    SHEETS_TEST_MODE: 'fixtures',
  };
}

const LOG_DIR = path.join(ROOT, 'e2e', 'test-results', 'logs');

/** Starts a compiled service; output goes to e2e/test-results/logs/<name>.log. */
export function start(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = ROOT,
): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = openSync(path.join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', log, log] });
  child.on('exit', (code) => {
    // Teardown force-stops the services (exit code 1 on Windows); only report earlier exits.
    if (code !== null && code !== 0 && !process.env['E2E_STOPPING']) {
      process.stderr.write(`[e2e] ${name} exited with code ${code}; see ${LOG_DIR}/${name}.log\n`);
    }
  });
  return child;
}

/** Stops a process and everything it started (Next.js spawns workers). */
export function stop(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

export async function waitForUrl(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url} (${last})`);
}

export async function assertPortFree(port: number): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return; // nothing listening
  }
  throw new Error(`Port ${port} is already in use. Set E2E_WEB_PORT / E2E_API_PORT to free ports.`);
}

export function requireBuilt(): void {
  const missing = [
    'apps/api/dist/main.js',
    'apps/api/dist/cli/create-admin.js',
    'apps/worker/dist/main.js',
    'apps/web/.next/BUILD_ID',
  ].filter((p) => !existsSync(path.join(ROOT, p)));
  if (missing.length) {
    throw new Error(`Build first (pnpm build). Missing: ${missing.join(', ')}`);
  }
}
