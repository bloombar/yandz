/**
 * Dev database seed.
 *
 * Idempotent: wipes the app collections in the configured (dev) database and re-inserts
 * a deterministic mock data set — five users; a set of real, scoped versions (page /
 * site / global) across real public pages on a range of hosts (reference sites plus
 * popular news & culture sites like UnHerd, NYT, the Guardian, BBC, and The Atlantic);
 * a follower graph; votes; bookmarks; version DEPENDENCIES (versions that bundle + apply
 * together, including a transitive chain); and opt-in activations — some of dependency-
 * bearing versions — so every scope tab, feed filter, and the applied-versions bar
 * (including read-only "required by" rows) have content. Versions are backdated so
 * "Latest" and the time-decayed "Your feed" ranking differ.
 *
 * Refuses to run against a production database. Run with:
 *   npm run seed --workspace=server
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectDb, disconnectDb, syncIndexes } from '../db.js';
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
  // Reconcile indexes with the current schema first, so a re-seed also drops any stale
  // indexes (e.g. a unique constraint that was later relaxed) rather than carrying them
  // over the wipe (which only deletes documents, not indexes).
  await syncIndexes();
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

  // --- Dependencies: link versions that bundle + apply together. Done in a SECOND pass
  //     so a spec can depend on any version regardless of insert order. Mirrors the
  //     server's rule (a version may depend only on equal-or-broader scope) and asserts it.
  const SCOPE_RANK: Record<VersionScope, number> = { page: 0, site: 1, global: 2 };
  let dependencyLinks = 0;
  for (let i = 0; i < VERSION_SPECS.length; i++) {
    const deps = VERSION_SPECS[i]!.dependsOn;
    if (!deps?.length) continue;
    const owner = seeded[i]!;
    const depIds = deps.map((depIdx) => {
      const dep = seeded[depIdx];
      if (!dep) throw new Error(`seed: ${VERSION_SPECS[i]!.name} depends on missing spec index ${depIdx}`);
      if (depIdx === i) throw new Error(`seed: ${VERSION_SPECS[i]!.name} cannot depend on itself`);
      if (SCOPE_RANK[dep.scope] < SCOPE_RANK[owner.scope]) {
        throw new Error(`seed: ${VERSION_SPECS[i]!.name} (${owner.scope}) cannot depend on a narrower '${dep.scope}' version`);
      }
      return dep.id;
    });
    await Version.updateOne({ _id: owner.id }, { $set: { dependencies: depIds } });
    dependencyLinks += depIds.length;
  }
  console.log(`  ${dependencyLinks} dependency links`);

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

  // Opt a few users into DEPENDENCY-BEARING versions (by spec index → seeded[i]) so the
  // applied bar shows bundled, read-only "required by …" rows out of the box — including a
  // transitive chain. Upsert (not create) so it's harmless if the plan above already added it.
  const dependencyActivations: { userIdx: number; specIdx: number }[] = [
    { userIdx: 1, specIdx: 0 }, //  grace ← "Friendlier Example" (page) bundles a global tint
    { userIdx: 2, specIdx: 19 }, // linus ← "UnHerd calmer headline" (page) bundles the UnHerd serif site reader
    { userIdx: 3, specIdx: 23 }, // margaret ← "NYT Tech declutter" (page) → NYT dark mode (site) → distraction-free (global)
  ];
  for (const d of dependencyActivations) {
    const v = seeded[d.specIdx];
    if (!v || v.authorIdx === d.userIdx) continue; // never activate your own
    await Activation.findOneAndUpdate(
      { userId: users[d.userIdx]!._id, versionId: v.id },
      {
        $set: {
          scope: v.scope,
          host: v.scope === 'global' ? '' : v.host,
          pageKey: v.scope === 'page' ? v.pageKey : '',
          enabled: true,
        },
      },
      { upsert: true, new: true },
    );
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
