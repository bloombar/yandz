import { defineConfig } from 'vitest/config';

/**
 * Live full-stack test tier: runs against a REAL MongoDB and REAL MinIO (brought
 * up by docker-compose.test.yml), not the in-memory/mocked stack. Exercises the
 * seams mocks hide — actual presigned upload + fetch, real indexes, real realtime.
 *
 * Point the env at the compose services before running:
 *   MONGO_URI=mongodb://localhost:27018 S3_ENDPOINT=http://localhost:9010 \
 *   npm run test:live --workspace=server
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
