import { defineConfig } from 'vitest/config';

/**
 * Default test run: unit + integration against an in-memory MongoDB
 * (mongodb-memory-server) with mocked S3/push. The live full-stack tier uses
 * vitest.live.config.ts instead. setupTests.ts boots/stops the in-memory DB.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/live/**'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false, // share one in-memory Mongo across files
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types/**', 'src/**/*.test.ts'],
    },
  },
});
