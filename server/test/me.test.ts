/**
 * Integration tests for the personal scoped-patch routes (/me). Verifies that a
 * patch's `scope` controls cross-page/site auto-apply for its author only, that the
 * management lists are correct, and that the demotion ladder (global→site→page) works.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function makeUser(handle: string) {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: `${handle}@example.com`, password: 'password123', handle });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

/** Create a version on `url` with a 'site' patch and a 'global' patch. */
async function makeScopedVersion(token: string, url: string) {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({
      url,
      name: 'scoped',
      patches: [
        { op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: 'Site' }, order: 0, scope: 'site' },
        { op: 'textReplace', target: { cssSelector: 'h2' }, payload: { from: 'Hello', to: 'Global' }, order: 1, scope: 'global' },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('/me/patches', () => {
  it('applies site patches on the same host and global patches everywhere, for the author only', async () => {
    const a = await makeUser('scopeA');
    const b = await makeUser('scopeB');
    await makeScopedVersion(a.token, 'https://site-a.com/page1');

    // Same host, different page → both site + global apply.
    const same = await request(app).get('/me/patches').query({ url: 'https://site-a.com/page2' }).set(auth(a.token));
    expect(same.status).toBe(200);
    expect(same.body.patches.map((p: { scope: string }) => p.scope).sort()).toEqual(['global', 'site']);

    // Different host → only the global patch.
    const other = await request(app).get('/me/patches').query({ url: 'https://other.com/x' }).set(auth(a.token));
    expect(other.body.patches).toHaveLength(1);
    expect(other.body.patches[0].scope).toBe('global');

    // The version's own page → nothing (those patches already arrive via /pages).
    const ownPage = await request(app).get('/me/patches').query({ url: 'https://site-a.com/page1' }).set(auth(a.token));
    expect(ownPage.body.patches).toHaveLength(0);

    // A different user gets none of A's personal patches.
    const isolation = await request(app).get('/me/patches').query({ url: 'https://site-a.com/page2' }).set(auth(b.token));
    expect(isolation.body.patches).toHaveLength(0);
  });

  it('lists global and site patches and demotes them down the ladder', async () => {
    const a = await makeUser('scopeC');
    const versionId = await makeScopedVersion(a.token, 'https://demo.test/p1');

    let global = await request(app).get('/me/patches/global').set(auth(a.token));
    let site = await request(app).get('/me/patches/site').set(auth(a.token));
    expect(global.body.patches).toHaveLength(1);
    expect(site.body.patches).toHaveLength(1);
    expect(global.body.patches[0].site).toBe('demo.test');

    // Demote the global patch (order 1) → site.
    const demote = await request(app)
      .patch('/me/patches/scope')
      .set(auth(a.token))
      .send({ versionId, order: 1, scope: 'site' });
    expect(demote.status).toBe(200);
    global = await request(app).get('/me/patches/global').set(auth(a.token));
    site = await request(app).get('/me/patches/site').set(auth(a.token));
    expect(global.body.patches).toHaveLength(0);
    expect(site.body.patches).toHaveLength(2);

    // Bulk demote every site patch on the host → page.
    const bulk = await request(app).post('/me/patches/demote-site').set(auth(a.token)).send({ host: 'demo.test' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.demoted).toBe(2);
    site = await request(app).get('/me/patches/site').set(auth(a.token));
    expect(site.body.patches).toHaveLength(0);

    // The patches now apply nowhere off-page.
    const none = await request(app).get('/me/patches').query({ url: 'https://demo.test/p2' }).set(auth(a.token));
    expect(none.body.patches).toHaveLength(0);
  });

  it("forbids changing another user's patch scope", async () => {
    const a = await makeUser('scopeD');
    const b = await makeUser('scopeE');
    const versionId = await makeScopedVersion(a.token, 'https://owned.test/p1');
    const res = await request(app)
      .patch('/me/patches/scope')
      .set(auth(b.token))
      .send({ versionId, order: 0, scope: 'page' });
    expect(res.status).toBe(403);
  });
});
