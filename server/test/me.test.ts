/**
 * Integration tests for the activation routes (/me/activations). A viewer opts in to
 * public site/global versions; an activation auto-applies on matching pages, replaces
 * the prior version in its scope slot, is isolated per user, and is cleaned up when its
 * version is deleted.
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

/** Create a version with the given scope on `url`. Returns its id. */
async function makeVersion(token: string, url: string, scope: 'page' | 'site' | 'global') {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({
      url,
      scope,
      name: `${scope} version`,
      patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: scope }, order: 0 }],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('/me/activations', () => {
  it('applies a global activation everywhere and a site activation only on its host', async () => {
    const author = await makeUser('actAuthor');
    const viewer = await makeUser('actViewer');
    const siteId = await makeVersion(author.token, 'https://site-a.com/page1', 'site');
    const globalId = await makeVersion(author.token, 'https://anywhere.test/x', 'global');

    // Viewer opts in to both.
    const aSite = await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: siteId });
    expect(aSite.status).toBe(200);
    expect(aSite.body).toMatchObject({ activated: true, scope: 'site', host: 'site-a.com', replacedVersionId: null });
    const aGlobal = await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: globalId });
    expect(aGlobal.body).toMatchObject({ activated: true, scope: 'global', replacedVersionId: null });

    // On the same host (different page): global + site both relevant.
    const onHost = await request(app).get('/me/activations').query({ url: 'https://site-a.com/page2' }).set(auth(viewer.token));
    expect(onHost.status).toBe(200);
    expect(onHost.body.versions.map((v: { id: string }) => v.id).sort()).toEqual([siteId, globalId].sort());

    // On a different host: only the global activation is relevant.
    const offHost = await request(app).get('/me/activations').query({ url: 'https://elsewhere.test/y' }).set(auth(viewer.token));
    expect(offHost.body.versions).toHaveLength(1);
    expect(offHost.body.versions[0].id).toBe(globalId);

    // Activations are isolated: the author opted in to nothing.
    const authorView = await request(app).get('/me/activations').query({ url: 'https://site-a.com/page2' }).set(auth(author.token));
    expect(authorView.body.versions).toHaveLength(0);
  });

  it('replaces the version in a scope slot when a new one is activated', async () => {
    const author = await makeUser('actAuthor2');
    const viewer = await makeUser('actViewer2');
    const g1 = await makeVersion(author.token, 'https://a.test/1', 'global');
    const g2 = await makeVersion(author.token, 'https://b.test/2', 'global');

    await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: g1 });
    const replace = await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: g2 });
    expect(replace.body.replacedVersionId).toBe(g1);

    // Only the newest global remains active.
    const active = await request(app).get('/me/activations').query({ url: 'https://anything.test/z' }).set(auth(viewer.token));
    expect(active.body.versions.map((v: { id: string }) => v.id)).toEqual([g2]);
  });

  it('lists active versions split by scope and deactivates them', async () => {
    const author = await makeUser('actAuthor3');
    const viewer = await makeUser('actViewer3');
    const siteId = await makeVersion(author.token, 'https://list.test/p', 'site');
    const globalId = await makeVersion(author.token, 'https://list2.test/p', 'global');
    await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: siteId });
    await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: globalId });

    let list = await request(app).get('/me/activations/list').set(auth(viewer.token));
    expect(list.body.site.map((v: { id: string }) => v.id)).toEqual([siteId]);
    expect(list.body.global.map((v: { id: string }) => v.id)).toEqual([globalId]);

    const off = await request(app).delete(`/me/activations/${siteId}`).set(auth(viewer.token));
    expect(off.body).toEqual({ deactivated: true });
    list = await request(app).get('/me/activations/list').set(auth(viewer.token));
    expect(list.body.site).toHaveLength(0);
    expect(list.body.global).toHaveLength(1);
  });

  it('rejects activating a page-scoped version', async () => {
    const author = await makeUser('actAuthor4');
    const viewer = await makeUser('actViewer4');
    const pageId = await makeVersion(author.token, 'https://page.test/p', 'page');
    const res = await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: pageId });
    expect(res.status).toBe(400);
  });

  it('cleans up an activation when its version is deleted', async () => {
    const author = await makeUser('actAuthor5');
    const viewer = await makeUser('actViewer5');
    const globalId = await makeVersion(author.token, 'https://del.test/p', 'global');
    await request(app).post('/me/activations').set(auth(viewer.token)).send({ versionId: globalId });

    await request(app).delete(`/versions/${globalId}`).set(auth(author.token)).expect(200);

    // The stale activation is self-healed away on the next read.
    const active = await request(app).get('/me/activations').query({ url: 'https://x.test/y' }).set(auth(viewer.token));
    expect(active.body.versions).toHaveLength(0);
    const list = await request(app).get('/me/activations/list').set(auth(viewer.token));
    expect(list.body.global).toHaveLength(0);
  });
});
