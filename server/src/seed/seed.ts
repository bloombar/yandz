/**
 * Dev database seed.
 *
 * Idempotent: wipes the app collections in the configured (dev) database and re-inserts
 * a deterministic mock data set — five users; a set of real, scoped versions (page /
 * site / global) across real public pages on a few hosts; a follower graph; votes;
 * bookmarks; and a couple of opt-in activations so every scope tab, feed filter, and the
 * applied-versions bar have content. Versions are backdated so "Latest" and the
 * time-decayed "Your feed" ranking differ.
 *
 * Refuses to run against a production database. Run with:
 *   npm run seed --workspace=server
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { User, Page, Version, Vote, Comment, Follow, Mute, Block, PushSub, Bookmark, Activation } from '../models.js';
import { pageKey, hostOf } from '../services/url.js';
import { sanitizePatchList } from '../services/sanitize.js';
import { recomputeVersionScore } from '../services/scoring.js';
import { USERS, PAGES, FOLLOWS, VERSION_SPECS } from './mock-data.js';
import type { VersionScope } from '@yandz/shared';
import { Types } from 'mongoose';

const DEV_PASSWORD = 'password123';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Remove all app data from the current database (dev only). */
async function wipe(): Promise<void> {
  await Promise.all([
    User.deleteMany({}),
    Page.deleteMany({}),
    Version.deleteMany({}),
    Vote.deleteMany({}),
    Comment.deleteMany({}),
    Follow.deleteMany({}),
    Mute.deleteMany({}),
    Block.deleteMany({}),
    PushSub.deleteMany({}),
    Bookmark.deleteMany({}),
    Activation.deleteMany({}),
  ]);
}

interface SeededVersion {
  id: Types.ObjectId;
  authorIdx: number;
  scope: VersionScope;
  host: string;
  pageKey: string;
}

async function seed(): Promise<void> {
  if (config.isProd) {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }

  await connectDb();
  console.log(`Seeding database "${config.mongo.db}"…`);
  await wipe();

  // --- Users -------------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const users = await User.insertMany(
    USERS.map((u) => ({
      email: u.email,
      passwordHash,
      handle: u.handle,
      handleLower: u.handle.toLowerCase(),
    })),
  );
  console.log(`  ${users.length} users (password for all: "${DEV_PASSWORD}")`);

  // --- Pages -------------------------------------------------------------
  const pages = await Page.insertMany(
    PAGES.map((p) => ({ urlKey: pageKey(p.url), urlOriginal: p.url, title: p.title, versionCount: 0 })),
  );

  // --- Versions: one per spec, with real patches + a per-version scope ----
  const seeded: SeededVersion[] = [];
  for (let i = 0; i < VERSION_SPECS.length; i++) {
    const spec = VERSION_SPECS[i]!;
    const clean = sanitizePatchList(spec.patches);
    if (!clean.ok || !clean.patches) throw new Error(`seed patch invalid (${spec.name}): ${clean.reason}`);

    const page = pages[spec.pageIdx]!;
    const host = hostOf(page.urlKey);
    const version = await Version.create({
      pageId: page._id,
      authorId: users[spec.authorIdx]!._id,
      name: spec.name,
      patches: clean.patches,
      scope: spec.scope,
      host,
      urlMatch: { mode: 'exact', value: page.urlKey },
    });
    version.rootVersionId = version._id as unknown as typeof version.rootVersionId;
    // Backdate creation so "Latest" ordering and time-decayed ranking vary.
    const createdAt = new Date(Date.now() - i * 1.5 * DAY_MS);
    await version.save();
    await Version.updateOne({ _id: version._id }, { $set: { createdAt } }, { timestamps: false });

    seeded.push({ id: version._id, authorIdx: spec.authorIdx, scope: spec.scope, host, pageKey: page.urlKey });
  }
  // Set accurate per-page version counts.
  for (const page of pages) {
    const count = await Version.countDocuments({ pageId: page._id });
    await Page.updateOne({ _id: page._id }, { $set: { versionCount: count } });
  }
  const byScope = (s: VersionScope) => seeded.filter((v) => v.scope === s).length;
  console.log(`  ${seeded.length} versions (${byScope('page')} page, ${byScope('site')} site, ${byScope('global')} global)`);

  // --- Follows -----------------------------------------------------------
  let followCount = 0;
  for (const [followerIdx, followees] of Object.entries(FOLLOWS)) {
    for (const followeeIdx of followees) {
      await Follow.create({ followerId: users[Number(followerIdx)]!._id, followeeId: users[followeeIdx]!._id });
      followCount++;
    }
  }
  console.log(`  ${followCount} follow relationships`);

  // --- Votes: each user votes on roughly every 3rd version not their own --
  let voteCount = 0;
  for (let u = 0; u < users.length; u++) {
    for (let i = 0; i < seeded.length; i++) {
      if (seeded[i]!.authorIdx === u || (i + u) % 3 !== 0) continue;
      const value: 1 | -1 = (i + u) % 7 === 0 ? -1 : 1;
      await Vote.create({ versionId: seeded[i]!.id, userId: users[u]!._id, value });
      voteCount++;
    }
  }
  for (const v of seeded) await recomputeVersionScore(String(v.id));
  console.log(`  ${voteCount} votes (scores recomputed)`);

  // --- Bookmarks: a few saves per user (not their own) -------------------
  let bookmarkCount = 0;
  for (let u = 0; u < users.length; u++) {
    let saved = 0;
    for (let i = 0; i < seeded.length && saved < 3; i++) {
      if (seeded[i]!.authorIdx === u || (i + u) % 4 !== 0) continue;
      await Bookmark.create({ userId: users[u]!._id, versionId: seeded[i]!.id });
      saved++;
      bookmarkCount++;
    }
  }
  console.log(`  ${bookmarkCount} bookmarks`);

  // --- Activations: opt a few users into versions (not their own) so the applied-versions
  //     bar and the account-settings lists have content out of the box. A user may activate
  //     several versions of each scope; they layer together.
  const pickFor = (userIdx: number, scope: VersionScope, key?: string) =>
    seeded.find(
      (v) =>
        v.scope === scope &&
        v.authorIdx !== userIdx &&
        (key === undefined ? true : scope === 'page' ? v.pageKey === key : v.host === key),
    );
  const activationPlan: { userIdx: number; scope: VersionScope; key?: string }[] = [
    { userIdx: 0, scope: 'global' }, //                                  ada → a global tint
    { userIdx: 0, scope: 'site', key: 'news.ycombinator.com' }, //       ada → HN dark mode
    { userIdx: 0, scope: 'page', key: pageKey('https://example.com/') }, // ada → an example.com page mod
    { userIdx: 1, scope: 'global' }, //                                  grace → a global
    { userIdx: 2, scope: 'site', key: 'en.wikipedia.org' }, //           linus → a wiki site version
  ];
  let activationCount = 0;
  for (const plan of activationPlan) {
    const v = pickFor(plan.userIdx, plan.scope, plan.key);
    if (!v) continue;
    await Activation.create({
      userId: users[plan.userIdx]!._id,
      versionId: v.id,
      scope: plan.scope,
      host: plan.scope === 'global' ? '' : v.host,
      pageKey: plan.scope === 'page' ? v.pageKey : '',
      enabled: true,
    });
    activationCount++;
  }
  console.log(`  ${activationCount} activations`);

  // --- A few comments for realism ---------------------------------------
  let commentCount = 0;
  for (let i = 0; i < seeded.length; i += 4) {
    const commenter = users[(i + 1) % users.length]!;
    const comment = await Comment.create({
      versionId: seeded[i]!.id,
      authorId: commenter._id,
      body: `Nice work — this is a clean remix. — u/${commenter.handle}`,
    });
    await Version.updateOne({ _id: seeded[i]!.id }, { $inc: { commentCount: 1 } });
    const replier = users[(i + 2) % users.length]!;
    await Comment.create({
      versionId: seeded[i]!.id,
      authorId: replier._id,
      parentCommentId: comment._id,
      body: 'Agreed, forking this.',
    });
    await Version.updateOne({ _id: seeded[i]!.id }, { $inc: { commentCount: 1 } });
    commentCount += 2;
  }
  console.log(`  ${commentCount} comments`);

  console.log('Seed complete.');
}

seed()
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await disconnectDb().catch(() => {});
    process.exit(1);
  });
