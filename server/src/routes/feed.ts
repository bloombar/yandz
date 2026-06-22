/**
 * Global feeds. Unlike /pages (which lists versions for one page), these return
 * versions across ALL pages by default, with an optional `scope=page` filter for
 * the page the viewer is currently on. Block-filtered and ranked per the viewer.
 *
 *  - GET /feed?sort=foryou|latest&scope=all|page&url=...   (optional auth)
 *  - GET /feed/bookmarks?scope=all|page&url=...            (requires auth)
 */
import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { Page, Version, Bookmark } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { pageKey } from '../services/url.js';
import { loadViewerSocial } from '../services/social.js';
import { serializeVersions, type RawVersion } from '../services/serialize.js';
import { sortVersions, type SortMode } from '@yandz/shared';

export const feedRouter = Router();

const FEED_LIMIT = 50;

/** Resolve the optional page filter: returns the pageId for scope=page, or null. */
async function resolveScope(
  scope: string,
  rawUrl: string,
): Promise<{ currentPageKey: string | null; pageId: Types.ObjectId | null }> {
  if (!rawUrl) return { currentPageKey: null, pageId: null };
  const key = pageKey(rawUrl);
  const page = await Page.findOne({ urlKey: key }).select('_id').lean();
  return { currentPageKey: key, pageId: scope === 'page' && page ? (page._id as Types.ObjectId) : null };
}

// GET /feed — global (or this-page) ranked list of versions. With `mine=1`, only
// the viewer's own versions (newest first) — backs the "By you" tab.
feedRouter.get('/', async (req: Request, res: Response) => {
  const sort = (String(req.query.sort ?? 'foryou') as SortMode);
  const scope = String(req.query.scope ?? 'all');
  const rawUrl = String(req.query.url ?? '');
  const mine = String(req.query.mine ?? '') === '1';
  const { currentPageKey, pageId } = await resolveScope(scope, rawUrl);

  // scope=page with no matching page → empty (but still report the key).
  if (scope === 'page' && !pageId) {
    res.json({ currentPageKey, versions: [] });
    return;
  }

  // "By you": the viewer's own versions, newest first.
  if (mine) {
    if (!req.userId) {
      res.json({ currentPageKey, versions: [] });
      return;
    }
    const filter: Record<string, unknown> = { authorId: new Types.ObjectId(req.userId) };
    if (pageId) filter.pageId = pageId;
    const docs = await Version.find(filter).sort({ createdAt: -1 }).limit(FEED_LIMIT).lean();
    res.json({ currentPageKey, versions: await serializeVersions(docs as unknown as RawVersion[], req.userId) });
    return;
  }

  const [social, raw] = await Promise.all([
    loadViewerSocial(req.userId ?? null),
    Version.find(pageId ? { pageId } : {})
      .sort({ createdAt: -1 })
      .limit(500) // headroom before block-filter + rank + final slice
      .lean(),
  ]);

  const visible = (raw as unknown as RawVersion[]).filter((v) => !social.blockSet.has(String(v.authorId)));
  const ranked = sortVersions(
    visible.map((v) => ({
      hotScore: v.hotScore,
      wilsonScore: v.wilsonScore,
      createdAtMs: v.createdAt ? new Date(v.createdAt).getTime() : 0,
      authorId: String(v.authorId),
      _doc: v,
    })),
    sort,
    social.followSet,
  )
    .slice(0, FEED_LIMIT)
    .map((r) => r._doc);

  res.json({ currentPageKey, versions: await serializeVersions(ranked, req.userId ?? null) });
});

// GET /feed/bookmarks — the viewer's saved versions, newest-bookmarked first.
feedRouter.get('/bookmarks', requireAuth, async (req: Request, res: Response) => {
  const scope = String(req.query.scope ?? 'all');
  const rawUrl = String(req.query.url ?? '');
  const { currentPageKey, pageId } = await resolveScope(scope, rawUrl);
  if (scope === 'page' && !pageId) {
    res.json({ currentPageKey, versions: [] });
    return;
  }

  const [social, marks] = await Promise.all([
    loadViewerSocial(req.userId!),
    Bookmark.find({ userId: new Types.ObjectId(req.userId!) }).sort({ createdAt: -1 }).limit(500).lean(),
  ]);
  const versionIds = marks.map((m) => m.versionId);

  const filter: Record<string, unknown> = { _id: { $in: versionIds } };
  if (pageId) filter.pageId = pageId;
  const docs = await Version.find(filter).lean();

  // Preserve bookmark recency order, then drop blocked authors.
  const byId = new Map(docs.map((d) => [String(d._id), d as unknown as RawVersion]));
  const ordered = versionIds
    .map((id) => byId.get(String(id)))
    .filter((v): v is RawVersion => !!v && !social.blockSet.has(String(v.authorId)))
    .slice(0, FEED_LIMIT);

  res.json({ currentPageKey, versions: await serializeVersions(ordered, req.userId!) });
});
