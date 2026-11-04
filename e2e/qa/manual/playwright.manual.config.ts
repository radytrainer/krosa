import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from '../../support/stack.js';

/** QA: the 196 cases of test-case.xlsx, in the browser. Run from e2e/. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  globalTeardown: '../../global-teardown.ts',
  outputDir: '../../test-results/manual',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['json', { outputFile: process.env['QA_JSON'] ?? 'manual-results.json' }]],
  use: { baseURL: WEB_URL, screenshot: 'only-on-failure', trace: 'off' },
  projects: [
    {
      name: 'edge',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env['E2E_CHANNEL'] ? { channel: process.env['E2E_CHANNEL'] } : {}),
      },
    },
  ],
});
