import { defineConfig } from 'vitest/config';

// Integration tests run against TEST_DATABASE_URL / TEST_REDIS_URL (recreated by global setup).
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.integration-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
