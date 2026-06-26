/**
 * Integration tests for version DEPENDENCIES: versions that are bundled and applied
 * together whenever a version is applied. Covers (1) save-time validation — scope rank
 * (a version may depend only on equal-or-broader scope), self/unknown rejection, and the
 * widen-scope PUT re-check; (2) persistence + resolved GET; and (3) apply-time transitive
 * expansion via GET /me/activations (relevance gating, ordering, dedupe/pause respect,
 * transitivity, cycle termination). Driven through the real Express app on in-memory Mongo.
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

const patch = (to: string) => ({ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to }, order: 0 });

/** POST /versions; returns the full supertest response so callers can assert status. */
function postVersion(
  token: string,
  url: string,
  scope: 'page' | 'site' | 'global',
  opts: { name?: string; dependencies?: string[] } = {},
) {
  return request(app)
    .post('/versions')
    .set(auth(token))
    .send({ url, scope, name: opts.name ?? scope, patches: [patch(opts.name ?? scope)], ...(opts.dependencies ? { dependencies: opts.dependencies } : {}) });
}

/** Create a version expected to succeed; returns its id. */
async function makeVersion(token: string, url: string, scope: 'page' | 'site' | 'global', opts: { name?: string; dependencies?: string[] } = {}) {
  const res = await postVersion(token, url, scope, opts);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const activate = (token: string, versionId: string) => request(app).post('/me/activations').set(auth(token)).send({ versionId });
const relevant = (token: string, url: string) => request(app).get('/me/activations').query({ url }).set(auth(token));
const ids = (res: { body: { versions: { id: string }[] } }) => res.body.versions.map((v) => v.id);

describe('dependency validation (save time)', () => {
  it('accepts a dependency of equal or broader scope', async () => {
    const u = await makeUser('depEqual');
    const g = await makeVersion(u.token, 'https://dep.test/g', 'global');
    const s = await makeVersion(u.token, 'https://dep.test/s', 'site');
    // page → global (broader) and site → site (equal) are both allowed.
    expect((await postVersion(u.token, 'https://dep.test/p', 'page', { dependencies: [g] })).status).toBe(201);
    expect((await postVersion(u.token, 'https://dep.test/s2', 'site', { dependencies: [s] })).status).toBe(201);
  });

  it('rejects a dependency of narrower scope', async () => {
    const u = await makeUser('depNarrow');
    const p = await makeVersion(u.token, 'https://narrow.test/p', 'page');
    // global → page is narrower: not allowed.
    const res = await postVersion(u.token, 'https://narrow.test/g', 'global', { dependencies: [p] });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown dependency id', async () => {
    const u = await makeUser('depUnknown');
    const res = await postVersion(u.token, 'https://unknown.test/p', 'page', { dependencies: ['000000000000000000000000'] });
    expect(res.status).toBe(400);
  });

  it('rejects a self-dependency on update', async () => {
    const u = await makeUser('depSelf');
    const v = await makeVersion(u.token, 'https://self.test/p', 'page');
    const res = await request(app)
      .put(`/versions/${v}`)
      .set(auth(u.token))
      .send({ patches: [patch('x')], dependencies: [v] });
    expect(res.status).toBe(400);
  });

  it('re-validates existing dependencies when a version is WIDENED to a broader scope', async () => {
    const u = await makeUser('depWiden');
    const q = await makeVersion(u.token, 'https://widen.test/q', 'page', { name: 'Q' });
    const p = await makeVersion(u.token, 'https://widen.test/p', 'page', { name: 'P', dependencies: [q] }); // page → page ok
    // Widening P to global leaves a now-illegal page dependency (Q) → rejected even though
    // `dependencies` isn't re-sent (the effective deps are re-checked against the new scope).
    const res = await request(app).put(`/versions/${p}`).set(auth(u.token)).send({ patches: [patch('x')], scope: 'global' });
    expect(res.status).toBe(400);
    // Narrowing/keeping page scope still accepts the same dep.
    const ok = await request(app).put(`/versions/${p}`).set(auth(u.token)).send({ patches: [patch('y')], scope: 'page' });
    expect(ok.status).toBe(200);
  });
});

describe('dependency persistence + resolved read', () => {
  it('persists dependencies and GET /:id resolves them, dropping deleted ones', async () => {
    const u = await makeUser('depRead');
    const g = await makeVersion(u.token, 'https://read.test/g', 'global', { name: 'Global one' });
    const p = await makeVersion(u.token, 'https://read.test/p', 'page', { dependencies: [g] });

    const got = await request(app).get(`/versions/${p}`).set(auth(u.token));
    expect(got.status).toBe(200);
    expect(got.body.dependencies).toEqual([{ id: g, name: 'Global one', scope: 'global' }]);

    // Deleting the dependency makes it silently disappear from the resolved list.
    await request(app).delete(`/versions/${g}`).set(auth(u.token)).expect(200);
    const after = await request(app).get(`/versions/${p}`).set(auth(u.token));
    expect(after.body.dependencies).toEqual([]);
  });

  it('persists dependencies through a fork', async () => {
    const u = await makeUser('depFork');
    const g = await makeVersion(u.token, 'https://fork.test/g', 'global', { name: 'G' });
    const base = await makeVersion(u.token, 'https://fork.test/p', 'page', { name: 'base' });
    const forked = await request(app)
      .post(`/versions/${base}/fork`)
      .set(auth(u.token))
      .send({ url: 'https://fork.test/p', name: 'mine', patches: [patch('z')], scope: 'page', dependencies: [g] });
    expect(forked.status).toBe(201);
    const got = await request(app).get(`/versions/${forked.body.id}`).set(auth(u.token));
    expect(got.body.dependencies.map((d: { id: string }) => d.id)).toEqual([g]);
  });
});

describe('dependency expansion (apply time)', () => {
  it('bundles broader-scope dependencies, tagged and ordered before the requiring version', async () => {
    const author = await makeUser('expAuthor');
    const viewer = await makeUser('expViewer');
    const g = await makeVersion(author.token, 'https://exp.test/g', 'global', { name: 'G' });
    const s = await makeVersion(author.token, 'https://exp.test/s', 'site', { name: 'S' });
    const v = await makeVersion(author.token, 'https://exp.test/p1', 'page', { name: 'V', dependencies: [g, s] });

    await activate(viewer.token, v);
    const res = await relevant(viewer.token, 'https://exp.test/p1');
    // Deps first (G, S in stored order), then the user's own activation V.
    expect(ids(res)).toEqual([g, s, v]);
    const byId = Object.fromEntries(res.body.versions.map((x: { id: string }) => [x.id, x]));
    expect(byId[g]).toMatchObject({ dependency: true, requiredBy: 'V', on: true });
    expect(byId[s]).toMatchObject({ dependency: true, requiredBy: 'V', on: true });
    expect(byId[v].dependency).toBeUndefined();
  });

  it('excludes a dependency that is not relevant to the viewed URL', async () => {
    const author = await makeUser('relAuthor2');
    const viewer = await makeUser('relViewer2');
    // V on /p1 depends on a PAGE version P2 on a different page.
    const p2 = await makeVersion(author.token, 'https://relx.test/p2', 'page', { name: 'P2' });
    const v = await makeVersion(author.token, 'https://relx.test/p1', 'page', { name: 'V', dependencies: [p2] });
    await activate(viewer.token, v);
    // Viewing V's page: P2 (a page version for /p2) is not relevant here, so it's dropped.
    expect(ids(await relevant(viewer.token, 'https://relx.test/p1'))).toEqual([v]);
  });

  it('drops a version\'s dependencies when it is paused', async () => {
    const author = await makeUser('pauseDepAuthor');
    const viewer = await makeUser('pauseDepViewer');
    const g = await makeVersion(author.token, 'https://pdep.test/g', 'global', { name: 'G' });
    const v = await makeVersion(author.token, 'https://pdep.test/p', 'page', { name: 'V', dependencies: [g] });
    await activate(viewer.token, v);
    expect(ids(await relevant(viewer.token, 'https://pdep.test/p'))).toEqual([g, v]);
    // Pausing V means it isn't applied — so neither is its dependency G.
    await request(app).patch(`/me/activations/${v}`).set(auth(viewer.token)).send({ enabled: false });
    expect(ids(await relevant(viewer.token, 'https://pdep.test/p'))).toEqual([v]);
    expect((await relevant(viewer.token, 'https://pdep.test/p')).body.versions[0].on).toBe(false);
  });

  it('does not duplicate or re-enable a dependency the user has separately paused', async () => {
    const author = await makeUser('dupAuthor');
    const viewer = await makeUser('dupViewer');
    const g = await makeVersion(author.token, 'https://dup.test/g', 'global', { name: 'G' });
    const v = await makeVersion(author.token, 'https://dup.test/p', 'page', { name: 'V', dependencies: [g] });
    await activate(viewer.token, v);
    await activate(viewer.token, g); // also a direct opt-in
    await request(app).patch(`/me/activations/${g}`).set(auth(viewer.token)).send({ enabled: false }); // paused

    const res = await relevant(viewer.token, 'https://dup.test/p');
    // G appears exactly once — as the user's own (paused) activation, NOT re-added/re-enabled as a dep.
    expect(ids(res).filter((id) => id === g)).toEqual([g]);
    const gEntry = res.body.versions.find((x: { id: string }) => x.id === g);
    expect(gEntry.on).toBe(false);
    expect(gEntry.dependency).toBeUndefined();
  });

  it('resolves transitive dependencies (V → W → X)', async () => {
    const author = await makeUser('transAuthor');
    const viewer = await makeUser('transViewer');
    const x = await makeVersion(author.token, 'https://trans.test/x', 'global', { name: 'X' });
    const w = await makeVersion(author.token, 'https://trans.test/w', 'global', { name: 'W', dependencies: [x] });
    const v = await makeVersion(author.token, 'https://trans.test/p', 'page', { name: 'V', dependencies: [w] });
    await activate(viewer.token, v);
    const res = await relevant(viewer.token, 'https://trans.test/p');
    expect(ids(res).sort()).toEqual([v, w, x].sort());
    const byId = Object.fromEntries(res.body.versions.map((e: { id: string }) => [e.id, e]));
    expect(byId[w]).toMatchObject({ dependency: true, requiredBy: 'V' });
    expect(byId[x]).toMatchObject({ dependency: true, requiredBy: 'W' });
  });

  it('terminates on a dependency cycle (V ↔ W)', async () => {
    const author = await makeUser('cycleAuthor');
    const viewer = await makeUser('cycleViewer');
    const v = await makeVersion(author.token, 'https://cycle.test/c', 'page', { name: 'V' });
    const w = await makeVersion(author.token, 'https://cycle.test/c', 'page', { name: 'W', dependencies: [v] });
    // Close the cycle: V now also depends on W.
    await request(app).put(`/versions/${v}`).set(auth(author.token)).send({ patches: [patch('v2')], dependencies: [w] }).expect(200);
    await activate(viewer.token, v);
    const res = await relevant(viewer.token, 'https://cycle.test/c');
    // Both resolve once; no infinite loop. V is the user's own; W is pulled as a dep.
    expect(ids(res).sort()).toEqual([v, w].sort());
  });
});
