import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './support/stack.js';

/**
 * End-to-end tests against production builds (run `pnpm build` first). The global setup starts
 * the API, worker and web app on their own ports against the test database, so it can run next to
 * a development server, but not at the same time as `pnpm test:integration` (same database).
 *
 * Browser: Playwright's Chromium by default (`pnpm exec playwright install chromium` once). Set
 * E2E_CHANNEL=msedge or chrome to use an installed browser instead.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One scenario sharing one database: run in order, never in parallel.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env['E2E_CHANNEL'] ? { channel: process.env['E2E_CHANNEL'] } : {}),
      },
    },
  ],
});
