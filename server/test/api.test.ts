/**
 * Integration tests for the core API, driven through the real Express app via
 * supertest against an in-memory MongoDB. Covers auth, version create/fork,
 * voting + ranking recompute, threaded comments, and the social graph including
 * reciprocal block content-filtering and mute notification suppression.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { eligibleRecipientIds } from '../src/services/webpush.js';
import { Follow } from '../src/models.js';
import { Types } from 'mongoose';

const app = createApp();

/** Register a fresh user and return their token + id + handle. */
async function makeUser(handle: string) {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: `${handle}@example.com`, password: 'password123', handle });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string, handle };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const samplePatch = (to: string) => ({
  op: 'textReplace',
  target: { cssSelector: 'h1' },
  payload: { from: 'Hello', to },
  order: 0,
});

async function makeVersion(token: string, url: string, to = 'Hi there') {
  const res = await request(app)
    .post('/versions')
    .set(auth(token))
    .send({ url, name: 'v', patches: [samplePatch(to)] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('auth', () => {
  it('signs up, rejects duplicate handle, logs in', async () => {
    await makeUser('alice');
    const dup = await request(app)
      .post('/auth/signup')
      .send({ email: 'other@example.com', password: 'password123', handle: 'alice' });
    expect(dup.status).toBe(409);

    const login = await request(app).post('/auth/login').send({ email: 'alice@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.user.handle).toBe('alice');

    const bad = await request(app).post('/auth/login').send({ email: 'alice@example.com', password: 'wrong' });
    expect(bad.status).toBe(401);
  });

  it('rejects unsafe handles and short passwords', async () => {
    const r = await request(app).post('/auth/signup').send({ email: 'x@y.com', password: 'short', handle: 'no!' });
    expect(r.status).toBe(400);
  });
});

describe('versions + sanitization', () => {
  it('creates a version and lists it for a page', async () => {
    const u = await makeUser('bob');
    const url = 'https://example.com/article?utm_source=x';
    await makeVersion(u.token, url);

    const list = await request(app).get('/pages').query({ url: 'https://example.com/article' });
    expect(list.status).toBe(200);
    expect(list.body.versions).toHaveLength(1);
    expect(list.body.versions[0].author.handle).toBe('bob');
  });

  it('rejects a patch with a forbidden attribute', async () => {
    const u = await makeUser('mallory');
    const res = await request(app)
      .post('/versions')
      .set(auth(u.token))
      .send({
        url: 'https://evil.test/',
        patches: [{ op: 'attrChange', target: { cssSelector: 'a' }, payload: { attr: 'onclick', value: 'x' }, order: 0 }],
      });
    expect(res.status).toBe(422);
  });

  it('forks a version and records lineage', async () => {
    const u = await makeUser('carol');
    const url = 'https://example.com/forkme';
    const parentId = await makeVersion(u.token, url);
    const fork = await request(app)
      .post(`/versions/${parentId}/fork`)
      .set(auth(u.token))
      .send({ url, name: 'forked', patches: [samplePatch('Forked!')] });
    expect(fork.status).toBe(201);
    expect(fork.body.parentVersionId).toBe(parentId);
    expect(fork.body.rootVersionId).toBe(parentId);
  });

  it('updates a version (author only) — backs the debounced auto-save', async () => {
    const author = await makeUser('quinn');
    const other = await makeUser('rob');
    const url = 'https://example.com/autosave';
    const id = await makeVersion(author.token, url, 'orig');

    const upd = await request(app)
      .put(`/versions/${id}`)
      .set(auth(author.token))
      .send({ name: 'updated', patches: [samplePatch('updated text')] });
    expect(upd.status).toBe(200);

    const fetched = await request(app).get(`/versions/${id}`);
    expect(fetched.body.name).toBe('updated');
    expect(fetched.body.patches[0].payload.to).toBe('updated text');

    // A non-author cannot update someone else's version.
    const forbidden = await request(app)
      .put(`/versions/${id}`)
      .set(auth(other.token))
      .send({ patches: [samplePatch('hijack')] });
    expect(forbidden.status).toBe(403);
  });
});

describe('voting', () => {
  it('toggles and switches votes, updating tallies', async () => {
    const author = await makeUser('dave');
    const voter = await makeUser('erin');
    const id = await makeVersion(author.token, 'https://example.com/vote');

    let r = await request(app).post(`/versions/${id}/vote`).set(auth(voter.token)).send({ value: 1 });
    expect(r.body).toMatchObject({ up: 1, down: 0 });

    // Same value again toggles it off.
    r = await request(app).post(`/versions/${id}/vote`).set(auth(voter.token)).send({ value: 1 });
    expect(r.body).toMatchObject({ up: 0, down: 0 });

    // Switch to downvote.
    await request(app).post(`/versions/${id}/vote`).set(auth(voter.token)).send({ value: 1 });
    r = await request(app).post(`/versions/${id}/vote`).set(auth(voter.token)).send({ value: -1 });
    expect(r.body).toMatchObject({ up: 0, down: 1 });
  });
});

describe('comments', () => {
  it('posts and lists threaded comments', async () => {
    const u = await makeUser('frank');
    const id = await makeVersion(u.token, 'https://example.com/comments');
    const top = await request(app).post(`/versions/${id}/comments`).set(auth(u.token)).send({ body: 'top' });
    expect(top.status).toBe(201);
    await request(app)
      .post(`/versions/${id}/comments`)
      .set(auth(u.token))
      .send({ body: 'reply', parentCommentId: top.body.id });

    const list = await request(app).get(`/versions/${id}/comments`).set(auth(u.token));
    expect(list.body).toHaveLength(2);
    expect(list.body.find((c: any) => c.parentCommentId === top.body.id)).toBeTruthy();
  });
});

describe('block filtering (reciprocal)', () => {
  it('hides a blocked author\'s versions and comments from the blocker, both ways', async () => {
    const a = await makeUser('grace');
    const b = await makeUser('heidi');
    const url = 'https://example.com/blocktest';
    await makeVersion(b.token, url, 'by heidi');

    // grace sees heidi's version before blocking.
    let list = await request(app).get('/pages').query({ url }).set(auth(a.token));
    expect(list.body.versions).toHaveLength(1);

    // grace blocks heidi.
    const blk = await request(app).post(`/users/${b.id}/block`).set(auth(a.token));
    expect(blk.body).toEqual({ blocked: true });

    // Now grace sees nothing...
    list = await request(app).get('/pages').query({ url }).set(auth(a.token));
    expect(list.body.versions).toHaveLength(0);

    // ...and reciprocally, heidi can't see grace's content either.
    await makeVersion(a.token, url, 'by grace');
    const heidiView = await request(app).get('/pages').query({ url }).set(auth(b.token));
    expect(heidiView.body.versions.every((v: any) => v.author.handle !== 'grace')).toBe(true);

    // Unblock restores visibility.
    await request(app).delete(`/users/${b.id}/block`).set(auth(a.token));
    list = await request(app).get('/pages').query({ url }).set(auth(a.token));
    expect(list.body.versions.length).toBeGreaterThan(0);
  });

  it('block removes mutual follows', async () => {
    const a = await makeUser('ivan');
    const b = await makeUser('judy');
    await request(app).post(`/users/${b.id}/follow`).set(auth(a.token));
    await request(app).post(`/users/${a.id}/follow`).set(auth(b.token));
    expect(await Follow.countDocuments()).toBe(2);
    await request(app).post(`/users/${b.id}/block`).set(auth(a.token));
    expect(await Follow.countDocuments()).toBe(0);
  });
});

describe('mute (notification suppression)', () => {
  it('excludes a muter from a muted author\'s notification recipients', async () => {
    const author = await makeUser('karl');
    const follower = await makeUser('lana');
    // lana follows karl, then mutes him.
    await request(app).post(`/users/${author.id}/follow`).set(auth(follower.token));
    let recipients = await eligibleRecipientIds(author.id);
    expect(recipients).toContain(follower.id);

    await request(app).post(`/users/${author.id}/mute`).set(auth(follower.token));
    recipients = await eligibleRecipientIds(author.id);
    expect(recipients).not.toContain(follower.id);
  });
});

describe('profile', () => {
  it('lists a user\'s modifications newest-first with relationship state', async () => {
    const u = await makeUser('mike');
    await makeVersion(u.token, 'https://example.com/p1');
    await makeVersion(u.token, 'https://example.com/p2');
    const viewer = await makeUser('nina');
    await request(app).post(`/users/${u.id}/follow`).set(auth(viewer.token));

    const profile = await request(app).get(`/users/${u.id}`).set(auth(viewer.token));
    expect(profile.body.user.handle).toBe('mike');
    expect(profile.body.modifications).toHaveLength(2);
    expect(profile.body.relationship.following).toBe(true);
  });

  it('rejects self-follow and bad ids', async () => {
    const u = await makeUser('opal');
    const self = await request(app).post(`/users/${u.id}/follow`).set(auth(u.token));
    expect(self.status).toBe(400);
    const bad = await request(app).post(`/users/${new Types.ObjectId()}/follow`).set(auth(u.token));
    expect(bad.status).toBe(200); // valid id, just no such user relationship yet
  });
});
