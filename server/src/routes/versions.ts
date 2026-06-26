/**
 * Version write routes: create a new version (a patch set) for a page, and fork
 * an existing version into a derivative that records its parent for attribution.
 * Creating a version notifies the author's eligible followers (push) and the
 * page room (realtime).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Page, Version, Vote, Comment, Bookmark, Activation } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { pageKey, hostOf } from '../services/url.js';
import { sanitizePatchList } from '../services/sanitize.js';
import { generateVersionName } from '../services/naming.js';
import { recomputeVersionScore } from '../services/scoring.js';
import { notifyFollowersOfNewVersion } from '../services/webpush.js';
import { emitNewVersion } from '../realtime/io.js';
import type { AnyPatch } from '@yandz/shared';

export const versionsRouter = Router();

// Loose patch schema at the boundary; deep validation is done by sanitizePatchList.
const patchInput = z.object({
  op: z.enum(['textReplace', 'imageSwap', 'cssOverride', 'attrChange', 'drawingOverlay', 'annotation']),
  target: z.record(z.any()),
  payload: z.record(z.any()),
  order: z.number(),
  template: z.enum(['auto', 'text', 'styles', 'both']).optional(),
});

// The version's application scope is chosen by its creator (defaults to 'page').
const scopeInput = z.enum(['page', 'site', 'global']);

const createSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  name: z.string().max(120).optional(),
  patches: z.array(patchInput).min(1),
  parentVersionId: z.string().optional(),
  scope: scopeInput.optional(),
  dependencies: z.array(z.string()).max(25).optional(),
});

/** Scope precedence: a version may only depend on equal-or-broader scope. */
const SCOPE_RANK: Record<string, number> = { page: 0, site: 1, global: 2 };

/**
 * Validate a version's declared dependencies: real versions, no self-dependency, and
 * each at least as broad in scope as the depending version. Returns the resolved ids.
 */
async function validateDependencies(
  depIds: string[] | undefined,
  effectiveScope: 'page' | 'site' | 'global',
  selfId?: Types.ObjectId | string,
): Promise<{ ok: true; ids: Types.ObjectId[] } | { ok: false; reason: string }> {
  if (!depIds || depIds.length === 0) return { ok: true, ids: [] };
  const unique = [...new Set(depIds)];
  if (unique.some((id) => !Types.ObjectId.isValid(id))) return { ok: false, reason: 'bad dependency id' };
  if (selfId && unique.includes(String(selfId))) return { ok: false, reason: 'self-dependency' };
  const found = await Version.find({ _id: { $in: unique } }).select('scope').lean();
  if (found.length !== unique.length) return { ok: false, reason: 'unknown dependency' };
  const ownRank = SCOPE_RANK[effectiveScope] ?? 0;
  for (const d of found) {
    if ((SCOPE_RANK[d.scope ?? 'page'] ?? 0) < ownRank) {
      return { ok: false, reason: `dependency scope '${d.scope}' is narrower than '${effectiveScope}'` };
    }
  }
  return { ok: true, ids: unique.map((id) => new Types.ObjectId(id)) };
}

/** Find or create the Page row for a URL, returning its id + urlKey. */
async function upsertPage(url: string, title?: string): Promise<{ id: Types.ObjectId; urlKey: string }> {
  const urlKey = pageKey(url);
  const page = await Page.findOneAndUpdate(
    { urlKey },
    { $setOnInsert: { urlKey, urlOriginal: url }, ...(title ? { $set: { title } } : {}) },
    { upsert: true, new: true },
  );
  return { id: page._id, urlKey };
}

/**
 * Shared creation path for both new versions and forks. `parent` carries the
 * lineage when forking so attribution can be displayed and linked.
 */
async function createVersion(
  req: Request,
  res: Response,
  opts: { patches: AnyPatch[]; parent?: { _id: Types.ObjectId; rootVersionId: Types.ObjectId | null } },
): Promise<void> {
  const body = createSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'invalid input', details: body.error.flatten() });
    return;
  }

  // Enforce the op/attr whitelist + sanitize text payloads before storage.
  const clean = sanitizePatchList(opts.patches);
  if (!clean.ok || !clean.patches) {
    res.status(422).json({ error: 'patch rejected', reason: clean.reason });
    return;
  }

  const deps = await validateDependencies(body.data.dependencies, body.data.scope ?? 'page');
  if (!deps.ok) {
    res.status(400).json({ error: 'invalid dependencies', reason: deps.reason });
    return;
  }

  const { id: pageId, urlKey } = await upsertPage(body.data.url, body.data.title);
  const created = await Version.create({
    pageId,
    authorId: new Types.ObjectId(req.userId!),
    // Auto-generate a friendly two-word name when the user didn't provide one.
    name: body.data.name?.trim() || generateVersionName(),
    patches: clean.patches,
    parentVersionId: opts.parent?._id ?? null,
    // rootVersionId points at the lineage root; self for an original version.
    rootVersionId: opts.parent ? opts.parent.rootVersionId ?? opts.parent._id : null,
    // Application scope chosen by the creator; `host` is denormalized from the page
    // so site-scoped feeds/activations resolve in one indexed query.
    scope: body.data.scope ?? 'page',
    host: hostOf(urlKey),
    dependencies: deps.ids,
    urlMatch: { mode: 'exact', value: urlKey },
  });
  if (!created.rootVersionId) {
    // An original version is the root of its own lineage. Cast bridges Mongoose's
    // structural ObjectId-ref field type to the document's own _id.
    created.rootVersionId = created._id as unknown as typeof created.rootVersionId;
    await created.save();
  }

  await Page.updateOne({ _id: pageId }, { $inc: { versionCount: 1 } });
  await recomputeVersionScore(String(created._id));

  // Side effects: realtime page update + push to eligible followers.
  const serialized = { id: String(created._id), name: created.name, authorId: req.userId };
  emitNewVersion(urlKey, serialized);
  await notifyFollowersOfNewVersion(req.userId!, {
    title: 'New modification',
    body: `A user you follow modified ${urlKey}`,
    url: body.data.url,
  });

  res.status(201).json({
    id: String(created._id),
    name: created.name, // the (possibly auto-generated) name, so the client can show it
    parentVersionId: created.parentVersionId ? String(created.parentVersionId) : null,
    rootVersionId: String(created.rootVersionId),
  });
}

// POST /versions — create a brand-new version.
versionsRouter.post('/', requireAuth, async (req, res) => {
  await createVersion(req, res, { patches: (req.body?.patches ?? []) as AnyPatch[] });
});

// POST /versions/:id/fork — fork an existing version. The body's patches are the
// forked+edited patch set; the :id establishes attribution/lineage.
versionsRouter.post('/:id/fork', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const parent = await Version.findById(req.params.id).select('rootVersionId').lean();
  if (!parent) {
    res.status(404).json({ error: 'parent version not found' });
    return;
  }
  await createVersion(req, res, {
    patches: (req.body?.patches ?? []) as AnyPatch[],
    parent: {
      _id: new Types.ObjectId(req.params.id),
      // lean() flattens the ObjectId type; cast back for the createVersion contract.
      rootVersionId: (parent.rootVersionId as Types.ObjectId | null | undefined) ?? null,
    },
  });
});

// PUT /versions/:id — replace a version's patch set (and optionally its name).
// Used by the editor's debounced auto-save: rapid edits coalesce into one version
// that is repeatedly updated rather than re-created. Author-only.
versionsRouter.put('/:id', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const updateSchema = z.object({
    name: z.string().max(120).optional(),
    patches: z.array(patchInput).min(1),
    scope: scopeInput.optional(),
    dependencies: z.array(z.string()).max(25).optional(),
  });
  const body = updateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'invalid input', details: body.error.flatten() });
    return;
  }
  const version = await Version.findById(req.params.id).select('authorId scope dependencies');
  if (!version) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Only the author may edit their own version.
  if (String(version.authorId) !== req.userId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  // Re-validate + sanitize on every update (never trust transit).
  const clean = sanitizePatchList(body.data.patches as AnyPatch[]);
  if (!clean.ok || !clean.patches) {
    res.status(422).json({ error: 'patch rejected', reason: clean.reason });
    return;
  }
  // Validate dependencies against the EFFECTIVE scope/dep-set: widening scope re-checks
  // the existing deps (a page-dep becomes invalid once the version is global).
  const effectiveScope = body.data.scope ?? (version.scope as 'page' | 'site' | 'global');
  const effectiveDeps = body.data.dependencies ?? (version.dependencies ?? []).map(String);
  const deps = await validateDependencies(effectiveDeps, effectiveScope, version._id as Types.ObjectId);
  if (!deps.ok) {
    res.status(400).json({ error: 'invalid dependencies', reason: deps.reason });
    return;
  }
  await Version.updateOne(
    { _id: version._id },
    {
      $set: {
        patches: clean.patches,
        ...(body.data.name ? { name: body.data.name } : {}),
        ...(body.data.scope ? { scope: body.data.scope } : {}),
        ...(body.data.dependencies !== undefined ? { dependencies: deps.ids } : {}),
      },
    },
  );
  // Changing scope invalidates other users' opt-in activations (their denormalized
  // scope/host no longer matches) — drop them so they re-activate under the new scope.
  if (body.data.scope && body.data.scope !== version.scope) {
    await Activation.deleteMany({ versionId: version._id });
  }
  res.json({ id: String(version._id) });
});

// GET /versions/:id — fetch a single version (used by the diff view / direct links).
versionsRouter.get('/:id', async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const v = await Version.findById(req.params.id).lean();
  if (!v) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Resolve dependencies for the editor (skip any whose Version was deleted).
  const depDocs = v.dependencies?.length
    ? await Version.find({ _id: { $in: v.dependencies } }).select('name scope').lean()
    : [];
  res.json({
    id: String(v._id),
    name: v.name,
    authorId: String(v.authorId),
    patches: v.patches,
    scope: v.scope ?? 'page',
    dependencies: depDocs.map((d) => ({ id: String(d._id), name: d.name, scope: d.scope ?? 'page' })),
    parentVersionId: v.parentVersionId ? String(v.parentVersionId) : null,
    rootVersionId: v.rootVersionId ? String(v.rootVersionId) : null,
    up: v.up,
    down: v.down,
    createdAt: v.createdAt,
  });
});

// DELETE /versions/:id — remove a version (author-only) and its votes, comments,
// and bookmarks; decrement the page's version count.
versionsRouter.delete('/:id', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const versionId = new Types.ObjectId(req.params.id);
  const version = await Version.findById(versionId).select('authorId pageId');
  if (!version) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (String(version.authorId) !== req.userId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  await Promise.all([
    Version.deleteOne({ _id: versionId }),
    Vote.deleteMany({ versionId }),
    Comment.deleteMany({ versionId }),
    Bookmark.deleteMany({ versionId }),
    Activation.deleteMany({ versionId }),
  ]);
  await Page.updateOne({ _id: version.pageId }, { $inc: { versionCount: -1 } });
  res.json({ deleted: true });
});
