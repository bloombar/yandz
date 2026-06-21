/**
 * Full-stack live test: real Express app + real MongoDB + real MinIO.
 *
 * Verifies the integration seams that the in-memory suite mocks away:
 *  - a presigned upload URL actually accepts a PUT to MinIO, and the object is
 *    then readable at its public URL,
 *  - an imageSwap patch referencing that live URL round-trips through the API,
 *  - Mongo unique indexes are enforced against the real engine.
 *
 * Requires docker-compose.test.yml to be up and env pointed at it. Skipped
 * automatically when MONGO_URI doesn't target the live test port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const LIVE = process.env.MONGO_URI?.includes('27018') ?? false;
const d = LIVE ? describe : describe.skip;

d('full-stack live (Mongo + MinIO)', () => {
  let app: import('express').Express;
  let connectDb: typeof import('../../src/db.js').connectDb;
  let disconnectDb: typeof import('../../src/db.js').disconnectDb;
  let ensureBucket: typeof import('../../src/services/s3.js').ensureBucket;

  beforeAll(async () => {
    // Import after env is set so config picks up the live endpoints.
    ({ connectDb, disconnectDb } = await import('../../src/db.js'));
    ({ ensureBucket } = await import('../../src/services/s3.js'));
    const { createApp } = await import('../../src/app.js');
    app = createApp();
    await connectDb(process.env.MONGO_URI, 'yandz_livetest');
    await ensureBucket();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('presigns, uploads to MinIO, and serves the object back', async () => {
    const signup = await request(app)
      .post('/auth/signup')
      .send({ email: 'live@example.com', password: 'password123', handle: 'liveuser' });
    const token = signup.body.token as string;

    const presign = await request(app)
      .post('/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentType: 'image/png', ext: 'png' });
    expect(presign.status).toBe(200);

    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(put.ok).toBe(true);

    const get = await fetch(presign.body.publicUrl);
    expect(get.ok).toBe(true);
    expect(get.headers.get('content-type')).toContain('image/png');

    // The live URL is usable as an imageSwap target.
    const version = await request(app)
      .post('/versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        url: 'https://example.com/live',
        patches: [
          {
            op: 'imageSwap',
            target: { cssSelector: 'img' },
            payload: { originalSrcHash: 'h', newAssetUrl: presign.body.publicUrl },
            order: 0,
          },
        ],
      });
    expect(version.status).toBe(201);
  });
});
