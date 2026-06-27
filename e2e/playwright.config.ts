import { defineConfig } from '@playwright/test';

/**
 * Playwright e2e config. Tests load the BUILT Chromium extension into a persistent
 * context (the only way to exercise an MV3 extension in Chromium) and run against
 * the full live stack (server + live Mongo + MinIO from docker-compose.test.yml).
 *
 * Build the extension first: `npm run build --workspace=@yandz/extension`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false, // a persistent context per worker is heavy
  use: {
    baseURL: process.env.YZ_API_BASE ?? 'http://localhost:4100',
  },
  reporter: [['list']],
});
