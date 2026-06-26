/**
 * Activation routes ("/me/activations"). A viewer opts in to versions so they
 * auto-apply on matching pages. A user may activate MANY versions of each scope; they
 * layer together (global under site under page). An activation can be paused (`enabled`
 * false — kept but not applied) or removed entirely.
 *
 * Relevance to a URL: global activations apply everywhere; site activations on a
 * matching host; page activations on the exact page. The content script applies the
 * enabled ones; the panel's applied bar shows them all (paused ones as "off").
 *
 * All handlers require auth and operate only on the caller's own activations.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Version, Activation } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { hostOf, pageKey } from '../services/url.js';
import { serializeVersions, type RawVersion, type SerializedVersion } from '../services/serialize.js';

export const meRouter = Router();

interface LeanActivation {
  _id: Types.ObjectId;
  versionId: Types.ObjectId;
  scope: 'page' | 'site' | 'global';
  host: string;
  pageKey: string;
  enabled: boolean;
}

/** A serialized version plus whether its activation is enabled (applied) or paused. */
type ActiveVersion = SerializedVersion & { on: boolean };

/** A version pulled in transitively because an active version declares it a dependency. */
type DependencyVersion = SerializedVersion & { on: true; dependency: true; requiredBy: string | null };

// A version is only worth applying on this URL if its own scope matches: global always,
// site when the host matches, page when the exact page key matches. Mirrors the
// activation relevance rule but evaluated against a Version doc (for transitive deps).
function isRelevant(
  v: { scope?: string | null; host?: string | null; urlMatch?: { value?: string } | null },
  host: string,
  key: string,
): boolean {
  const s = v.scope ?? 'page';
  if (s === 'global') return true;
  if (s === 'site') return (v.host ?? '') === host;
  return (v.urlMatch?.value ?? '') === key;
}

interface DepSeedDoc {
  _id: Types.ObjectId;
  name?: string;
  scope?: string;
  host?: string;
  urlMatch?: { value?: string };
  dependencies?: Types.ObjectId[];
}

/**
 * Transitively expand the dependencies of a user's ENABLED active versions into the set
 * of extra versions that must be bundled and applied alongside them on this URL. Purely
 * read-only (never touches Activation, unlike resolveActivations' orphan self-heal).
 *
 * BFS from each enabled active version's declared dependencies. A dependency is applied
 * only if it's relevant to this URL by its own scope; deleted deps are skipped. Versions
 * the user has already activated (enabled OR paused) are never re-appended — so a dep
 * can't silently duplicate or re-enable one the user paused — but their own deps are
 * still traversed so a chain through them still resolves. Bounded by depth + count
 * because this runs on every page load.
 */
async function expandDependencies(
  userId: string,
  url: string,
  acts: LeanActivation[],
): Promise<DependencyVersion[]> {
  const CAP_DEPTH = 8;
  const CAP_VERSIONS = 50;
  const host = hostOf(url);
  const key = pageKey(url);

  // `present`: ids that must not be appended (every version the user already activated,
  // plus deps already collected). `traversed`: ids whose dependencies are already
  // enqueued (enabled activations seeded the frontier; deps as we visit them).
  const present = new Set(acts.map((a) => String(a.versionId)));
  const traversed = new Set(acts.filter((a) => a.enabled).map((a) => String(a.versionId)));

  // Seed the frontier from the ENABLED active versions' declared dependencies (a paused
  // version contributes nothing — it isn't applied, so neither are its deps).
  const enabledIds = acts.filter((a) => a.enabled).map((a) => a.versionId);
  const seeds = await Version.find({ _id: { $in: enabledIds } })
    .select('name dependencies')
    .lean<DepSeedDoc[]>();
  let frontier: Array<{ id: string; requiredBy: string }> = [];
  for (const s of seeds) {
    for (const depId of s.dependencies ?? []) {
      frontier.push({ id: String(depId), requiredBy: s.name ?? '' });
    }
  }

  const collected: Array<{ v: DepSeedDoc; requiredBy: string }> = [];
  let depth = 0;
  while (frontier.length && depth < CAP_DEPTH && collected.length < CAP_VERSIONS) {
    const ids = frontier.map((f) => f.id).filter((id) => Types.ObjectId.isValid(id));
    const docs = await Version.find({ _id: { $in: ids } }).lean<DepSeedDoc[]>();
    const byId = new Map(docs.map((v) => [String(v._id), v]));
    const next: Array<{ id: string; requiredBy: string }> = [];
    for (const f of frontier) {
      const v = byId.get(f.id);
      if (!v) continue; // deleted dependency — invisible
      if (!isRelevant(v, host, key)) continue; // doesn't apply on this URL
      if (!present.has(f.id) && collected.length < CAP_VERSIONS) {
        present.add(f.id);
        collected.push({ v, requiredBy: f.requiredBy });
      }
      // Traverse this node's own deps once, even if it was already present (e.g. a paused
      // separate activation) so a chain that passes through it still resolves.
      if (!traversed.has(f.id)) {
        traversed.add(f.id);
        for (const depId of v.dependencies ?? []) {
          next.push({ id: String(depId), requiredBy: v.name ?? '' });
        }
      }
    }
    frontier = next;
    depth++;
  }

  const serialized = await serializeVersions(collected.map((c) => c.v) as unknown as RawVersion[], userId);
  const reqById = new Map(collected.map((c) => [String(c.v._id), c.requiredBy]));
  return serialized.map((s) => ({ ...s, on: true as const, dependency: true as const, requiredBy: reqById.get(s.id) ?? null }));
}

/**
 * Resolve activations into serialized versions tagged with their on/off state, in a
 * stable order (oldest activation first, so layering is deterministic). Self-heals by
 * deleting activations whose version no longer exists.
 */
async function resolveActivations(userId: string, acts: LeanActivation[]): Promise<ActiveVersion[]> {
  const versions = await Version.find({ _id: { $in: acts.map((a) => a.versionId) } }).lean();
  const liveIds = new Set(versions.map((v) => String(v._id)));
  const orphans = acts.filter((a) => !liveIds.has(String(a.versionId)));
  if (orphans.length) await Activation.deleteMany({ _id: { $in: orphans.map((o) => o._id) } });

  const enabledByVersion = new Map(acts.map((a) => [String(a.versionId), a.enabled]));
  const serialized = await serializeVersions(versions as unknown as RawVersion[], userId);
  const byId = new Map(serialized.map((s) => [s.id, s]));
  // Preserve the activations' order (acts come pre-sorted) for deterministic layering.
  return acts
    .map((a) => byId.get(String(a.versionId)))
    .filter((s): s is SerializedVersion => !!s)
    .map((s) => ({ ...s, on: enabledByVersion.get(s.id) ?? true }));
}

// GET /me/activations?url= — the caller's activations RELEVANT to this URL (every
// global, plus site activations whose host matches, plus page activations whose page
// matches), enabled or paused. The content script applies the enabled ones; the panel
// shows all (paused as "off").
meRouter.get('/activations', requireAuth, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const host = hostOf(url);
  const key = pageKey(url);
  const acts = await Activation.find({
    userId: new Types.ObjectId(req.userId!),
    $or: [{ scope: 'global' }, { scope: 'site', host }, { scope: 'page', pageKey: key }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean<LeanActivation[]>();
  const own = await resolveActivations(req.userId!, acts);
  const deps = await expandDependencies(req.userId!, url, acts);
  // Deps first so the content script lays them down before the user's own activations;
  // within a scope the user's deliberate version then overrides shared elements.
  res.json({ versions: [...deps, ...own] });
});

// GET /me/activations/list — all of the caller's activations, split by scope, for the
// account-settings management lists.
meRouter.get('/activations/list', requireAuth, async (req, res) => {
  const acts = await Activation.find({ userId: new Types.ObjectId(req.userId!) })
    .sort({ createdAt: 1, _id: 1 })
    .lean<LeanActivation[]>();
  const scopeByVersion = new Map(acts.map((a) => [String(a.versionId), a.scope]));
  const versions = await resolveActivations(req.userId!, acts);
  res.json({
    page: versions.filter((v) => scopeByVersion.get(v.id) === 'page'),
    site: versions.filter((v) => scopeByVersion.get(v.id) === 'site'),
    global: versions.filter((v) => scopeByVersion.get(v.id) === 'global'),
  });
});

// POST /me/activations { versionId } — opt in to a version (idempotent; re-enables a
// paused one). Returns the version's page urlKey so the client can navigate there when
// the version targets a different page/site.
meRouter.post('/activations', requireAuth, async (req, res) => {
  const body = z.object({ versionId: z.string() }).safeParse(req.body);
  if (!body.success || !Types.ObjectId.isValid(body.data.versionId)) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const version = await Version.findById(body.data.versionId)
    .select('scope host urlMatch')
    .lean<{ scope: 'page' | 'site' | 'global'; host?: string; urlMatch?: { value?: string } } | null>();
  if (!version) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const scope = version.scope;
  const key = version.urlMatch?.value ?? '';
  await Activation.findOneAndUpdate(
    { userId: new Types.ObjectId(req.userId!), versionId: new Types.ObjectId(body.data.versionId) },
    { $set: { scope, host: version.host ?? '', pageKey: scope === 'page' ? key : '', enabled: true } },
    { upsert: true, new: true },
  );
  res.json({ activated: true, scope, urlKey: key });
});

// PATCH /me/activations/:versionId { enabled } — pause/resume an activation (the bar's
// toggle). The opt-in is kept either way.
meRouter.patch('/activations/:versionId', requireAuth, async (req, res) => {
  const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!body.success || !Types.ObjectId.isValid(req.params.versionId)) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  await Activation.updateOne(
    { userId: new Types.ObjectId(req.userId!), versionId: new Types.ObjectId(req.params.versionId) },
    { $set: { enabled: body.data.enabled } },
  );
  res.json({ ok: true, enabled: body.data.enabled });
});

// DELETE /me/activations/:versionId — remove the opt-in entirely (the bar's ✕).
meRouter.delete('/activations/:versionId', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.versionId)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  await Activation.deleteOne({
    userId: new Types.ObjectId(req.userId!),
    versionId: new Types.ObjectId(req.params.versionId),
  });
  res.json({ removed: true });
});
