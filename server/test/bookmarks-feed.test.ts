/**
 * The dedicated Bookmarks tab (`GET /feed/bookmarks/all`): every saved version across ALL
 * scopes (page/site/global), independent of the current page, newest-bookmarked first.
 * The `type` param narrows by content type for the tab's Pages/Sites/Global pills. Results
 * are block-filtered and paginated.
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

async function makeVersion(token: string, url: string, scope: 'page' | 'site' | 'global', name: string) {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({ url, name, scope, patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: name }, order: 0 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const bookmark = (token: string, id: string) => request(app).post(`/versions/${id}/bookmark`).set(auth(token));
const allBookmarks = (token: string, type?: string) =>
  request(app).get('/feed/bookmarks/all').query(type ? { type } : {}).set(auth(token));
const names = (res: { body: { versions: { name: string }[] } }) => res.body.versions.map((v) => v.name);

describe('GET /feed/bookmarks/all', () => {
  it('returns saved versions of every scope, newest-bookmarked first', async () => {
    const author = await makeUser('bmAuthor');
    const viewer = await makeUser('bmViewer');
    const p = await makeVersion(author.token, 'https://bm.test/p', 'page', 'PageMod');
    const s = await makeVersion(author.token, 'https://bm.test/s', 'site', 'SiteMod');
    const g = await makeVersion(author.token, 'https://other.test/g', 'global', 'GlobalMod');

    // Bookmark in a deliberate order: global, then page, then site.
    await bookmark(viewer.token, g);
    await bookmark(viewer.token, p);
    await bookmark(viewer.token, s);

    // All three returned regardless of current page, newest-bookmarked first.
    expect(names(await allBookmarks(viewer.token))).toEqual(['SiteMod', 'PageMod', 'GlobalMod']);
  });

  it('filters by content type via the pills (page/site/global)', async () => {
    const author = await makeUser('bmTypeAuthor');
    const viewer = await makeUser('bmTypeViewer');
    const p = await makeVersion(author.token, 'https://t.test/p', 'page', 'P');
    const s = await makeVersion(author.token, 'https://t.test/s', 'site', 'S');
    const g = await makeVersion(author.token, 'https://t2.test/g', 'global', 'G');
    await bookmark(viewer.token, p);
    await bookmark(viewer.token, s);
    await bookmark(viewer.token, g);

    expect(names(await allBookmarks(viewer.token, 'page'))).toEqual(['P']);
    expect(names(await allBookmarks(viewer.token, 'site'))).toEqual(['S']);
    expect(names(await allBookmarks(viewer.token, 'global'))).toEqual(['G']);
    expect(names(await allBookmarks(viewer.token, 'all')).sort()).toEqual(['G', 'P', 'S']);
  });

  it('drops un-bookmarked versions and requires auth', async () => {
    const author = await makeUser('bmRmAuthor');
    const viewer = await makeUser('bmRmViewer');
    const g = await makeVersion(author.token, 'https://rm.test/g', 'global', 'G');
    await bookmark(viewer.token, g);
    expect(names(await allBookmarks(viewer.token))).toEqual(['G']);
    await request(app).delete(`/versions/${g}/bookmark`).set(auth(viewer.token)).expect(200);
    expect(await allBookmarks(viewer.token).then((r) => r.body.versions)).toHaveLength(0);
    await request(app).get('/feed/bookmarks/all').expect(401);
  });

  it('excludes a blocked author from the bookmarks list', async () => {
    const author = await makeUser('bmBlockAuthor');
    const viewer = await makeUser('bmBlockViewer');
    const g = await makeVersion(author.token, 'https://blk.test/g', 'global', 'G');
    await bookmark(viewer.token, g);
    expect(names(await allBookmarks(viewer.token))).toEqual(['G']);
    // Block the author → their saved version drops out of the list.
    await request(app).post(`/users/${author.id}/block`).set(auth(viewer.token)).expect(200);
    expect(await allBookmarks(viewer.token).then((r) => r.body.versions)).toHaveLength(0);
  });
});
