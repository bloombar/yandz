/**
 * Dev database seed / migration script.
 *
 * Idempotent: wipes the app collections in the configured (dev) database and
 * re-inserts a deterministic mock data set — five users, five versions per user
 * across five real web pages (5 versions per page), a follower/following graph,
 * and a spread of votes so feed ranking is meaningful. Versions are backdated so
 * the "New" sort and time-decayed "Hot" score differ.
 *
 * Refuses to run against a production database. Run with:
 *   npm run seed --workspace=server
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { User, Page, Version, Vote, Comment, Follow, Mute, Block, PushSub } from '../models.js';
import { pageKey } from '../services/url.js';
import { sanitizePatchList } from '../services/sanitize.js';
import { recomputeVersionScore } from '../services/scoring.js';
import { USERS, PAGES, FOLLOWS, buildPatches } from './mock-data.js';
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
  ]);
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

  // --- Versions: each user modifies each page (25 total) -----------------
  const versionIds: Types.ObjectId[] = [];
  for (let u = 0; u < users.length; u++) {
    for (let p = 0; p < pages.length; p++) {
      const clean = sanitizePatchList(buildPatches(u, p));
      if (!clean.ok || !clean.patches) throw new Error(`seed patch invalid: ${clean.reason}`);

      const version = await Version.create({
        pageId: pages[p]!._id,
        authorId: users[u]!._id,
        name: `${USERS[u]!.handle}'s take on ${PAGES[p]!.title}`,
        patches: clean.patches,
        urlMatch: { mode: 'exact', value: pages[p]!.urlKey },
      });
      version.rootVersionId = version._id as unknown as typeof version.rootVersionId;
      // Backdate creation so "New" ordering and time-decayed "Hot" vary. Spread
      // versions over the last few weeks (timestamps:false to keep the value).
      const createdAt = new Date(Date.now() - (u * pages.length + p) * 1.5 * DAY_MS);
      await version.save();
      await Version.updateOne({ _id: version._id }, { $set: { createdAt } }, { timestamps: false });

      versionIds.push(version._id);
    }
  }
  // Set accurate per-page version counts.
  for (const page of pages) {
    const count = await Version.countDocuments({ pageId: page._id });
    await Page.updateOne({ _id: page._id }, { $set: { versionCount: count } });
  }
  console.log(`  ${versionIds.length} versions across ${pages.length} pages`);

  // --- Follows -----------------------------------------------------------
  let followCount = 0;
  for (const [followerIdx, followees] of Object.entries(FOLLOWS)) {
    for (const followeeIdx of followees) {
      await Follow.create({ followerId: users[Number(followerIdx)]!._id, followeeId: users[followeeIdx]!._id });
      followCount++;
    }
  }
  console.log(`  ${followCount} follow relationships`);

  // --- Votes: each user votes on several versions they didn't author -----
  let voteCount = 0;
  for (let u = 0; u < users.length; u++) {
    for (let i = 0; i < versionIds.length; i++) {
      // Deterministic but varied: vote on roughly every 3rd version not your own.
      const authorIdx = Math.floor(i / pages.length);
      if (authorIdx === u || (i + u) % 3 !== 0) continue;
      const value: 1 | -1 = (i + u) % 7 === 0 ? -1 : 1;
      await Vote.create({ versionId: versionIds[i]!, userId: users[u]!._id, value });
      voteCount++;
    }
  }
  // Recompute denormalized scores so Hot/Top reflect the seeded votes + dates.
  for (const id of versionIds) await recomputeVersionScore(String(id));
  console.log(`  ${voteCount} votes (scores recomputed)`);

  // --- A few comments for realism ---------------------------------------
  let commentCount = 0;
  for (let i = 0; i < versionIds.length; i += 4) {
    const commenter = users[(i + 1) % users.length]!;
    const comment = await Comment.create({
      versionId: versionIds[i]!,
      authorId: commenter._id,
      body: `Nice work — this is a clean remix. — u/${commenter.handle}`,
    });
    await Version.updateOne({ _id: versionIds[i]! }, { $inc: { commentCount: 1 } });
    // One threaded reply.
    const replier = users[(i + 2) % users.length]!;
    await Comment.create({
      versionId: versionIds[i]!,
      authorId: replier._id,
      parentCommentId: comment._id,
      body: 'Agreed, forking this.',
    });
    await Version.updateOne({ _id: versionIds[i]! }, { $inc: { commentCount: 1 } });
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
