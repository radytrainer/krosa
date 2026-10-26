import { defineConfig } from 'vitest/config';

// Runs a real BullMQ worker against TEST_DATABASE_URL and TEST_REDIS_URL (Redis DB 15).
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.integration-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
