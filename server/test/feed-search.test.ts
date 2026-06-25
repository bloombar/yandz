/**
 * Feed search (`GET /feed?q=`): matches a version by its title, the title of the page
 * it modifies, or its author's handle (with or without a `u/` prefix).
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
  return res.body.token as string;
}

// Global-scoped so search spans pages within the one (global) tab.
async function makeVersion(token: string, url: string, name: string, title: string) {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({
      url,
      name,
      title,
      scope: 'global',
      patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: 'x' }, order: 0 }],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const names = (body: { versions: { name: string }[] }) => body.versions.map((v) => v.name).sort();
const search = (q?: string) => request(app).get('/feed').query(q === undefined ? { scope: 'global' } : { scope: 'global', q });

describe('feed search', () => {
  it('matches by version title, page title, or handle (u/ optional)', async () => {
    const alice = await makeUser('searchalice');
    const bob = await makeUser('searchbob');
    await makeVersion(alice, 'https://shop.test/widgets', 'Dark Mode', 'Widget Shop');
    await makeVersion(bob, 'https://news.test/home', 'Bigger Fonts', 'Daily News');

    // By version title.
    expect(names((await search('dark')).body)).toEqual(['Dark Mode']);
    // By page title.
    expect(names((await search('widget')).body)).toEqual(['Dark Mode']);
    // By handle, both forms.
    expect(names((await search('u/searchbob')).body)).toEqual(['Bigger Fonts']);
    expect(names((await search('searchbob')).body)).toEqual(['Bigger Fonts']);
    // No matches.
    expect((await search('zzz-nothing')).body.versions).toHaveLength(0);
    // No query → both returned.
    expect(names((await search()).body).length).toBeGreaterThanOrEqual(2);
  });
});
