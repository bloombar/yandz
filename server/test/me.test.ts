/**
 * Integration tests for the activation routes (/me/activations). A viewer may activate
 * MANY versions of each scope; they layer together. Activations are relevant to a URL by
 * scope (global everywhere, site by host, page by exact page), can be paused (kept but
 * not applied) or removed, are isolated per user, and are cleaned up when their version
 * is deleted.
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

const activate = (token: string, versionId: string) =>
  request(app).post('/me/activations').set(auth(token)).send({ versionId });
const relevant = (token: string, url: string) =>
  request(app).get('/me/activations').query({ url }).set(auth(token));
const ids = (res: { body: { versions: { id: string }[] } }) => res.body.versions.map((v) => v.id);

describe('/me/activations', () => {
  it('lets a user activate MANY versions per scope, layered together', async () => {
    const author = await makeUser('multiAuthor');
    const viewer = await makeUser('multiViewer');
    const g1 = await makeVersion(author.token, 'https://a.test/1', 'global');
    const g2 = await makeVersion(author.token, 'https://b.test/2', 'global');
    await activate(viewer.token, g1);
    const second = await activate(viewer.token, g2);
    expect(second.status).toBe(200);

    // Both globals are active (no replacement).
    const active = await relevant(viewer.token, 'https://anywhere.test/x');
    expect(ids(active).sort()).toEqual([g1, g2].sort());
    expect(active.body.versions.every((v: { on: boolean }) => v.on === true)).toBe(true);
  });

  it('resolves relevance by scope: global everywhere, site by host, page by exact page', async () => {
    const author = await makeUser('relAuthor');
    const viewer = await makeUser('relViewer');
    const globalId = await makeVersion(author.token, 'https://global.test/x', 'global');
    const siteId = await makeVersion(author.token, 'https://site.test/a', 'site');
    const pageId = await makeVersion(author.token, 'https://site.test/p1', 'page');
    await activate(viewer.token, globalId);
    await activate(viewer.token, siteId);
    await activate(viewer.token, pageId);

    // On the exact page of the site: global + site + page all relevant.
    expect(ids(await relevant(viewer.token, 'https://site.test/p1')).sort()).toEqual([globalId, siteId, pageId].sort());
    // Another page of the same host: global + site (not the page version).
    expect(ids(await relevant(viewer.token, 'https://site.test/other')).sort()).toEqual([globalId, siteId].sort());
    // A different host: only the global.
    expect(ids(await relevant(viewer.token, 'https://elsewhere.test/y'))).toEqual([globalId]);
  });

  it('pauses (keeps but does not apply) and resumes an activation', async () => {
    const author = await makeUser('pauseAuthor');
    const viewer = await makeUser('pauseViewer');
    const g = await makeVersion(author.token, 'https://p.test/x', 'global');
    await activate(viewer.token, g);

    const off = await request(app).patch(`/me/activations/${g}`).set(auth(viewer.token)).send({ enabled: false });
    expect(off.body).toEqual({ ok: true, enabled: false });
    // Still listed (so the bar can show it), but flagged off.
    let active = await relevant(viewer.token, 'https://p.test/x');
    expect(ids(active)).toEqual([g]);
    expect(active.body.versions[0].on).toBe(false);

    await request(app).patch(`/me/activations/${g}`).set(auth(viewer.token)).send({ enabled: true });
    active = await relevant(viewer.token, 'https://p.test/x');
    expect(active.body.versions[0].on).toBe(true);
  });

  it('removes an activation entirely', async () => {
    const author = await makeUser('rmAuthor');
    const viewer = await makeUser('rmViewer');
    const g = await makeVersion(author.token, 'https://r.test/x', 'global');
    await activate(viewer.token, g);
    const rm = await request(app).delete(`/me/activations/${g}`).set(auth(viewer.token));
    expect(rm.body).toEqual({ removed: true });
    expect(ids(await relevant(viewer.token, 'https://r.test/x'))).toHaveLength(0);
  });

  it('lists activations split by scope; activations are isolated per user', async () => {
    const author = await makeUser('listAuthor');
    const viewer = await makeUser('listViewer');
    const g = await makeVersion(author.token, 'https://l.test/g', 'global');
    const s = await makeVersion(author.token, 'https://l.test/s', 'site');
    const p = await makeVersion(author.token, 'https://l.test/p', 'page');
    await activate(viewer.token, g);
    await activate(viewer.token, s);
    await activate(viewer.token, p);

    const list = await request(app).get('/me/activations/list').set(auth(viewer.token));
    expect(list.body.global.map((v: { id: string }) => v.id)).toEqual([g]);
    expect(list.body.site.map((v: { id: string }) => v.id)).toEqual([s]);
    expect(list.body.page.map((v: { id: string }) => v.id)).toEqual([p]);

    // The author opted into nothing.
    const authorList = await request(app).get('/me/activations/list').set(auth(author.token));
    expect(authorList.body.global).toHaveLength(0);
  });

  it('re-activating is idempotent and re-enables a paused activation', async () => {
    const author = await makeUser('reAuthor');
    const viewer = await makeUser('reViewer');
    const g = await makeVersion(author.token, 'https://re.test/x', 'global');
    await activate(viewer.token, g);
    await request(app).patch(`/me/activations/${g}`).set(auth(viewer.token)).send({ enabled: false });
    await activate(viewer.token, g); // re-activate
    const active = await relevant(viewer.token, 'https://re.test/x');
    expect(ids(active)).toEqual([g]); // still one row
    expect(active.body.versions[0].on).toBe(true); // re-enabled
  });

  it('cleans up activations when their version is deleted', async () => {
    const author = await makeUser('delAuthor');
    const viewer = await makeUser('delViewer');
    const g = await makeVersion(author.token, 'https://del.test/x', 'global');
    await activate(viewer.token, g);
    await request(app).delete(`/versions/${g}`).set(auth(author.token)).expect(200);
    expect(ids(await relevant(viewer.token, 'https://x.test/y'))).toHaveLength(0);
  });
});
