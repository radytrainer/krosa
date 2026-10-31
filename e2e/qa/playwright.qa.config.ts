import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from '../support/stack.js';

/**
 * QA browser suite, area H. Same stack as the scenario test (production builds, test database,
 * fixture workbook). Run from e2e/: pnpm exec playwright test --config qa/playwright.qa.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: '../global-setup.ts',
  globalTeardown: '../global-teardown.ts',
  outputDir: '../test-results/qa',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
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
