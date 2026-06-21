import { defineConfig } from 'vitest/config';

/**
 * Extension unit tests run in jsdom so the patch engine (matcher/applier) can be
 * exercised against a real DOM without a browser. WXT entrypoints and React UI
 * are covered by Playwright e2e instead.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['lib/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/engine/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
