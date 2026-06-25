/**
 * Activation routes ("/me/activations"). A viewer opts in to a public site- or
 * global-scoped version so it auto-re-applies on every matching page until they
 * deactivate it. At most one version is active per scope instance (one global per
 * user; one site per user per host) — activating a new one replaces the old.
 *
 * These routes serve the content script (which versions to auto-apply on a URL) and
 * the account-settings management lists. Page-scoped versions are never activated
 * here — they live in per-page session state on the client.
 *
 * All handlers require auth and operate only on the caller's own activations.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Version, Activation } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { hostOf } from '../services/url.js';
import { serializeVersions, type RawVersion } from '../services/serialize.js';

export const meRouter = Router();

interface LeanActivation {
  _id: Types.ObjectId;
  versionId: Types.ObjectId;
  scope: 'site' | 'global';
  host: string;
}

/**
 * Load the caller's activations, resolve their versions, and serialize them. Drops
 * (and deletes) any activation whose version no longer exists — a self-healing pass
 * so stale opt-ins from deleted versions don't linger.
 */
async function resolveActivations(userId: string, acts: LeanActivation[]) {
  const versionIds = acts.map((a) => a.versionId);
  const versions = await Version.find({ _id: { $in: versionIds } }).lean();
  const liveIds = new Set(versions.map((v) => String(v._id)));
  const orphans = acts.filter((a) => !liveIds.has(String(a.versionId)));
  if (orphans.length) await Activation.deleteMany({ _id: { $in: orphans.map((o) => o._id) } });
  return serializeVersions(versions as unknown as RawVersion[], userId);
}

// GET /me/activations?url=<currentUrl> — the caller's ACTIVE versions relevant to this
// URL: every global activation, plus the site activation whose host matches. Returns
// fully serialized versions (the content script needs the patch sets to apply). NOT
// block-filtered: a deliberate opt-in overrides discovery blocks.
meRouter.get('/activations', requireAuth, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const host = hostOf(url);
  const acts = await Activation.find({
    userId: new Types.ObjectId(req.userId!),
    $or: [{ scope: 'global' }, { scope: 'site', host }],
  }).lean<LeanActivation[]>();
  res.json({ versions: await resolveActivations(req.userId!, acts) });
});

// GET /me/activations/list — all of the caller's active versions, split by scope, for
// the account-settings management lists ("Active on all sites" / "Active on this site").
meRouter.get('/activations/list', requireAuth, async (req, res) => {
  const acts = await Activation.find({ userId: new Types.ObjectId(req.userId!) }).lean<LeanActivation[]>();
  const versions = await resolveActivations(req.userId!, acts);
  res.json({
    site: versions.filter((v) => v.scope === 'site'),
    global: versions.filter((v) => v.scope === 'global'),
  });
});

// POST /me/activations { versionId } — opt in to a site/global version. Upserts on the
// (user, scope, host) slot, so activating a new version replaces whatever was active
// there; the replaced version's id is returned so the client can flip its toggle off.
meRouter.post('/activations', requireAuth, async (req, res) => {
  const body = z.object({ versionId: z.string() }).safeParse(req.body);
  if (!body.success || !Types.ObjectId.isValid(body.data.versionId)) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const version = await Version.findById(body.data.versionId).select('scope host').lean();
  if (!version) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (version.scope !== 'site' && version.scope !== 'global') {
    res.status(400).json({ error: 'only site or global versions can be activated' });
    return;
  }
  const scope = version.scope;
  const host = scope === 'site' ? version.host ?? '' : '';
  const userId = new Types.ObjectId(req.userId!);

  // Whatever currently occupies this (scope, host) slot gets replaced.
  const existing = await Activation.findOne({ userId, scope, host }).lean<LeanActivation | null>();
  const replacedVersionId =
    existing && String(existing.versionId) !== body.data.versionId ? String(existing.versionId) : null;

  await Activation.findOneAndUpdate(
    { userId, scope, host },
    { $set: { versionId: new Types.ObjectId(body.data.versionId) } },
    { upsert: true, new: true },
  );
  res.json({ activated: true, scope, host, replacedVersionId });
});

// DELETE /me/activations/:versionId — deactivate (permanently, until re-activated).
meRouter.delete('/activations/:versionId', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.versionId)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  await Activation.deleteOne({
    userId: new Types.ObjectId(req.userId!),
    versionId: new Types.ObjectId(req.params.versionId),
  });
  res.json({ deactivated: true });
});
