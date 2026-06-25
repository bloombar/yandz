/**
 * One-off migration: per-patch scope → per-version scope.
 *
 * Earlier, each patch carried its own `scope` ('page'|'site'|'global'). Scope now
 * lives on the whole Version. This script, for every existing version:
 *   1. sets Version.scope to the BROADEST of its patches' old scopes
 *      (any 'global' → 'global', else any 'site' → 'site', else 'page');
 *   2. backfills Version.host = hostOf(page.urlKey) for site-scoped feeds/activations;
 *   3. removes the now-defunct `scope` field from every embedded patch.
 *
 * Idempotent and safe to re-run. Refuses to run against a production database.
 * Activations start empty — existing author-only site/global auto-application stops
 * until those users re-activate, which is acceptable (and expected) under the new model.
 *
 * Run with:  npm run migrate:scope --workspace=server
 */
import { config } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { Version, Page } from '../models.js';
import { hostOf } from '../services/url.js';
import { broadestScope } from '../services/scope-migration.js';

async function migrate(): Promise<void> {
  if (config.isProd) {
    throw new Error('Refusing to migrate: NODE_ENV is production.');
  }

  await connectDb();
  console.log(`Migrating scope in database "${config.mongo.db}"…`);

  // Resolve every page's host once so the per-version backfill is a map lookup.
  const pages = await Page.find({}).select('_id urlKey').lean();
  const hostByPageId = new Map(pages.map((p) => [String(p._id), hostOf(p.urlKey)]));

  // Read raw docs (patches still carry the legacy `scope` in the DB even though the
  // schema no longer declares it).
  const versions = await Version.find({})
    .select('_id pageId scope patches')
    .lean<Array<{ _id: unknown; pageId: unknown; scope?: string; patches: Array<{ scope?: string }> }>>();

  let updated = 0;
  for (const v of versions) {
    const scope = broadestScope(v.patches ?? []);
    const host = hostByPageId.get(String(v.pageId)) ?? '';
    await Version.updateOne(
      { _id: v._id as never },
      {
        $set: { scope, host },
        // Strip the legacy per-patch scope from every embedded patch.
        $unset: { 'patches.$[].scope': '' },
      },
      { timestamps: false },
    );
    updated++;
  }

  console.log(`  ${updated} versions migrated (scope + host set, patch.scope removed).`);
  console.log('Migration complete.');
}

migrate()
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Migration failed:', err);
    await disconnectDb().catch(() => {});
    process.exit(1);
  });
