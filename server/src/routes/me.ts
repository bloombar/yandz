/**
 * Personal-patch routes ("/me"). A patch's `scope` lets its author apply it beyond
 * the page it was made on — across the whole host ('site') or every site ('global') —
 * for THAT user only. These routes serve the content script (which patches to
 * auto-apply on a given URL) and the account-settings management tabs (list + demote).
 *
 * All handlers require auth and operate only on the caller's own versions.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Version } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { hostOf, pageKey } from '../services/url.js';
import { sanitizePatchList } from '../services/sanitize.js';
import type { AnyPatch, PatchScope } from '@yandz/shared';

export const meRouter = Router();

type LeanVersion = { _id: Types.ObjectId; name: string; patches: AnyPatch[]; pageId?: { urlKey?: string } | null };

/** Plain patch objects (for sanitize/store), stripped of Mongoose subdoc machinery. */
function toPlain(patches: AnyPatch[]): AnyPatch[] {
  return patches.map((p) => ({ op: p.op, target: p.target, payload: p.payload, order: p.order, scope: p.scope }) as AnyPatch);
}

/** The caller's versions that contain at least one patch of the given scope(s), with page urlKey. */
async function ownedVersionsWithScope(userId: string, scopes: PatchScope[]): Promise<LeanVersion[]> {
  return Version.find({ authorId: userId, 'patches.scope': { $in: scopes } })
    .populate('pageId', 'urlKey')
    .lean<LeanVersion[]>();
}

/** Flatten matching patches into management entries (one per patch). */
function entriesForScope(versions: LeanVersion[], scope: PatchScope) {
  const out: { versionId: string; order: number; versionName: string; site: string; patch: AnyPatch }[] = [];
  for (const v of versions) {
    const site = hostOf(v.pageId?.urlKey ?? '');
    for (const p of v.patches) {
      if (p.scope === scope) out.push({ versionId: String(v._id), order: p.order, versionName: v.name, site, patch: p });
    }
  }
  return out;
}

// GET /me/patches?url=<currentUrl> — patches to auto-apply on this URL for the caller:
// every 'global' patch, plus 'site' patches whose version's host matches. Excludes the
// current page's own patches (those already arrive via /pages).
meRouter.get('/patches', requireAuth, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) {
    res.status(400).json({ error: 'missing url' });
    return;
  }
  const curHost = hostOf(url);
  const curKey = pageKey(url);
  const versions = await ownedVersionsWithScope(req.userId!, ['site', 'global']);
  const patches: AnyPatch[] = [];
  for (const v of versions) {
    const vKey = v.pageId?.urlKey ?? '';
    if (vKey && vKey === curKey) continue; // own page → already delivered via /pages
    const vHost = hostOf(vKey);
    for (const p of v.patches) {
      if (p.scope === 'global' || (p.scope === 'site' && vHost && vHost === curHost)) patches.push(p);
    }
  }
  res.json({ patches });
});

// GET /me/patches/global and /me/patches/site — management lists for the settings tabs.
meRouter.get('/patches/global', requireAuth, async (req, res) => {
  res.json({ patches: entriesForScope(await ownedVersionsWithScope(req.userId!, ['global']), 'global') });
});
meRouter.get('/patches/site', requireAuth, async (req, res) => {
  res.json({ patches: entriesForScope(await ownedVersionsWithScope(req.userId!, ['site']), 'site') });
});

// PATCH /me/patches/scope { versionId, order, scope } — change one patch's scope
// (drives the single demotions global→site and site→page). Author-only.
meRouter.patch('/patches/scope', requireAuth, async (req, res) => {
  const body = z
    .object({ versionId: z.string(), order: z.number(), scope: z.enum(['page', 'site', 'global']) })
    .safeParse(req.body);
  if (!body.success || !Types.ObjectId.isValid(body.data.versionId)) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const version = await Version.findById(body.data.versionId).lean<LeanVersion & { authorId: Types.ObjectId }>();
  if (!version) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (String(version.authorId) !== req.userId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const plain = toPlain(version.patches);
  const idx = plain.findIndex((p) => p.order === body.data.order);
  if (idx < 0) {
    res.status(404).json({ error: 'patch not found' });
    return;
  }
  plain[idx]!.scope = body.data.scope;
  const clean = sanitizePatchList(plain);
  if (!clean.ok || !clean.patches) {
    res.status(422).json({ error: 'patch rejected', reason: clean.reason });
    return;
  }
  await Version.updateOne({ _id: version._id }, { $set: { patches: clean.patches } });
  res.json({ ok: true });
});

// POST /me/patches/demote-site { host } — bulk demote: every 'site' patch on the
// caller's versions whose host matches becomes 'page'. Author-only by construction.
meRouter.post('/patches/demote-site', requireAuth, async (req, res) => {
  const body = z.object({ host: z.string().min(1) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const host = body.data.host.toLowerCase();
  const versions = await ownedVersionsWithScope(req.userId!, ['site']);
  let demoted = 0;
  for (const v of versions) {
    if (hostOf(v.pageId?.urlKey ?? '') !== host) continue;
    const plain = toPlain(v.patches);
    let changed = false;
    for (const p of plain) {
      if (p.scope === 'site') {
        p.scope = 'page';
        changed = true;
        demoted++;
      }
    }
    if (!changed) continue;
    const clean = sanitizePatchList(plain);
    if (clean.ok && clean.patches) await Version.updateOne({ _id: v._id }, { $set: { patches: clean.patches } });
  }
  res.json({ ok: true, demoted });
});
