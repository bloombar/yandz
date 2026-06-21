/**
 * Version write routes: create a new version (a patch set) for a page, and fork
 * an existing version into a derivative that records its parent for attribution.
 * Creating a version notifies the author's eligible followers (push) and the
 * page room (realtime).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Page, Version } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { pageKey } from '../services/url.js';
import { sanitizePatchList } from '../services/sanitize.js';
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
});

const createSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  name: z.string().max(120).optional(),
  patches: z.array(patchInput).min(1),
  parentVersionId: z.string().optional(),
});

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

  const { id: pageId, urlKey } = await upsertPage(body.data.url, body.data.title);
  const created = await Version.create({
    pageId,
    authorId: new Types.ObjectId(req.userId!),
    name: body.data.name ?? 'Untitled version',
    patches: clean.patches,
    parentVersionId: opts.parent?._id ?? null,
    // rootVersionId points at the lineage root; self for an original version.
    rootVersionId: opts.parent ? opts.parent.rootVersionId ?? opts.parent._id : null,
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
  res.json({
    id: String(v._id),
    name: v.name,
    authorId: String(v.authorId),
    patches: v.patches,
    parentVersionId: v.parentVersionId ? String(v.parentVersionId) : null,
    rootVersionId: v.rootVersionId ? String(v.rootVersionId) : null,
    up: v.up,
    down: v.down,
    createdAt: v.createdAt,
  });
});
