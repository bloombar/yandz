/**
 * Feed pagination (offset/limit/hasMore) and per-page block filtering. Pages must be
 * contiguous and gapless, ids unique across pages, and a blocked author's versions
 * must be absent from every page.
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

// Global-scoped so they all land in one feed (the "global" tab) across many pages.
async function makeVersion(token: string, url: string, name: string) {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({ url, name, scope: 'global', patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: name }, order: 0 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const ids = (body: { versions: { id: string }[] }) => body.versions.map((v) => v.id);
const G = { scope: 'global' as const };

describe('feed pagination', () => {
  it('paginates with offset/limit/hasMore; pages are contiguous and unique', async () => {
    const a = await makeUser('pagealice');
    const made: string[] = [];
    for (let i = 0; i < 6; i++) made.push(await makeVersion(a.token, `https://pa${i}.test/`, `v${i}`));

    const p0 = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 2, offset: 0 }).set(auth(a.token));
    const p1 = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 2, offset: 2 }).set(auth(a.token));
    const p2 = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 2, offset: 4 }).set(auth(a.token));
    const p3 = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 2, offset: 6 }).set(auth(a.token));

    expect(p0.body.versions).toHaveLength(2);
    expect(p0.body.hasMore).toBe(true);
    expect(p2.body.versions).toHaveLength(2);
    expect(p2.body.hasMore).toBe(false);
    expect(p3.body.versions).toHaveLength(0);

    const all = [...ids(p0.body), ...ids(p1.body), ...ids(p2.body)];
    expect(new Set(all).size).toBe(6); // unique, no dupes across pages
    expect([...all].sort()).toEqual([...made].sort()); // gapless: every version reachable
  });

  it('excludes a blocked author from every page', async () => {
    const a = await makeUser('pagebob');
    const c = await makeUser('pagecarol');
    for (let i = 0; i < 4; i++) await makeVersion(a.token, `https://pb${i}.test/`, `a${i}`);
    await makeVersion(c.token, 'https://pc0.test/', 'carol0');
    await makeVersion(c.token, 'https://pc1.test/', 'carol1');

    // Before blocking, carol's versions are visible to bob.
    const before = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 50 }).set(auth(a.token));
    expect(before.body.versions.some((v: { name: string }) => v.name.startsWith('carol'))).toBe(true);

    await request(app).post(`/users/${c.id}/block`).set(auth(a.token)).expect(200);

    // After: no page contains carol's versions, and the total drops to bob's 4.
    const seen: string[] = [];
    for (let offset = 0; offset < 20; offset += 2) {
      const r = await request(app).get('/feed').query({ ...G, sort: 'latest', limit: 2, offset }).set(auth(a.token));
      for (const v of r.body.versions as { id: string; name: string }[]) {
        expect(v.name.startsWith('carol')).toBe(false);
        seen.push(v.id);
      }
      if (!r.body.hasMore) break;
    }
    expect(new Set(seen).size).toBe(4);
  });
});
