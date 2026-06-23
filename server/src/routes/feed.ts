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
import { Page, Version, Bookmark, User } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { pageKey } from '../services/url.js';
import { loadViewerSocial } from '../services/social.js';
import { serializeVersions, type RawVersion } from '../services/serialize.js';
import { sortVersions, type SortMode } from '@yandz/shared';

export const feedRouter = Router();

const FEED_LIMIT = 50;
// Headroom for the in-app rank (foryou/latest) and bookmark recency order before we
// paginate: pages slice into this candidate set, so it bounds reachable scroll depth.
const CANDIDATE_CAP = 1000;

/** Parse & clamp the pagination query params. */
function pageParams(req: Request): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || FEED_LIMIT)));
  return { offset, limit };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the `$or` clauses for a free-text feed search: matches a version's name, the
 * title of the page it modifies, or its author's handle. A leading `u/` is treated as
 * a username hint and stripped (so "u/alice" and "alice" both match the handle).
 * Returns [] when the query is empty (no filtering).
 */
async function searchClauses(rawQ: string): Promise<Record<string, unknown>[]> {
  const q = rawQ.trim().replace(/^u\//i, '').trim();
  if (!q) return [];
  const rx = new RegExp(escapeRegex(q), 'i');
  const [pages, users] = await Promise.all([
    Page.find({ title: rx }).select('_id').lean(),
    User.find({ handle: rx }).select('_id').lean(),
  ]);
  const clauses: Record<string, unknown>[] = [{ name: rx }];
  if (pages.length) clauses.push({ pageId: { $in: pages.map((p) => p._id) } });
  if (users.length) clauses.push({ authorId: { $in: users.map((u) => u._id) } });
  return clauses;
}

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
  const clauses = await searchClauses(String(req.query.q ?? ''));
  const { offset, limit } = pageParams(req);

  // scope=page with no matching page → empty (but still report the key).
  if (scope === 'page' && !pageId) {
    res.json({ currentPageKey, versions: [], hasMore: false });
    return;
  }

  // "By you": the viewer's own versions, newest first (DB-level pagination).
  if (mine) {
    if (!req.userId) {
      res.json({ currentPageKey, versions: [], hasMore: false });
      return;
    }
    const filter: Record<string, unknown> = { authorId: new Types.ObjectId(req.userId) };
    if (pageId) filter.pageId = pageId;
    if (clauses.length) filter.$or = clauses;
    const docs = await Version.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const page = (hasMore ? docs.slice(0, limit) : docs) as unknown as RawVersion[];
    res.json({ currentPageKey, versions: await serializeVersions(page, req.userId), hasMore });
    return;
  }

  // Block-filter authoritatively IN the query so every page excludes blocked authors
  // (and pages stay contiguous). Rank the block-filtered candidate set, then slice.
  const social = await loadViewerSocial(req.userId ?? null);
  const versionFilter: Record<string, unknown> = pageId ? { pageId } : {};
  if (clauses.length) versionFilter.$or = clauses;
  if (social.blockSet.size) versionFilter.authorId = { $nin: [...social.blockSet] };
  // `_id` is a stable tiebreaker so the candidate order (and thus offset pagination)
  // is deterministic even when versions share a createdAt — otherwise pages would
  // overlap/miss as ties get broken differently per query.
  const raw = await Version.find(versionFilter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(CANDIDATE_CAP)
    .lean();

  const rankedAll = sortVersions(
    (raw as unknown as RawVersion[]).map((v) => ({
      hotScore: v.hotScore,
      wilsonScore: v.wilsonScore,
      createdAtMs: v.createdAt ? new Date(v.createdAt).getTime() : 0,
      authorId: String(v.authorId),
      _doc: v,
    })),
    sort,
    social.followSet,
  );
  const hasMore = rankedAll.length > offset + limit;
  const page = rankedAll.slice(offset, offset + limit).map((r) => r._doc);

  res.json({ currentPageKey, versions: await serializeVersions(page, req.userId ?? null), hasMore });
});

// GET /feed/bookmarks — the viewer's saved versions, newest-bookmarked first.
feedRouter.get('/bookmarks', requireAuth, async (req: Request, res: Response) => {
  const scope = String(req.query.scope ?? 'all');
  const rawUrl = String(req.query.url ?? '');
  const { currentPageKey, pageId } = await resolveScope(scope, rawUrl);
  if (scope === 'page' && !pageId) {
    res.json({ currentPageKey, versions: [], hasMore: false });
    return;
  }
  const clauses = await searchClauses(String(req.query.q ?? ''));
  const { offset, limit } = pageParams(req);

  const [social, marks] = await Promise.all([
    loadViewerSocial(req.userId!),
    Bookmark.find({ userId: new Types.ObjectId(req.userId!) }).sort({ createdAt: -1, _id: -1 }).limit(CANDIDATE_CAP).lean(),
  ]);
  const versionIds = marks.map((m) => m.versionId);

  const filter: Record<string, unknown> = { _id: { $in: versionIds } };
  if (pageId) filter.pageId = pageId;
  if (clauses.length) filter.$or = clauses;
  const docs = await Version.find(filter).lean();

  // Preserve bookmark recency order, drop blocked authors, THEN paginate so each page
  // is block-filtered and contiguous.
  const byId = new Map(docs.map((d) => [String(d._id), d as unknown as RawVersion]));
  const ordered = versionIds
    .map((id) => byId.get(String(id)))
    .filter((v): v is RawVersion => !!v && !social.blockSet.has(String(v.authorId)));
  const hasMore = ordered.length > offset + limit;
  const page = ordered.slice(offset, offset + limit);

  res.json({ currentPageKey, versions: await serializeVersions(page, req.userId!), hasMore });
});
