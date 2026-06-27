/**
 * Scope feeds. Each tab is a scope-restricted, ranked, block-filtered list of versions:
 *   - scope=page   → page-scoped versions on the viewer's current page
 *   - scope=site   → site-scoped versions on the viewer's current host
 *   - scope=global → global-scoped versions everywhere
 * Within a tab the viewer filters by All / Following / Mine and sorts by Your-feed
 * (personalized) / Latest.
 *
 *  - GET /feed?scope=page|site|global&filter=all|following|mine&sort=foryou|latest&url=&q=
 *  - GET /feed/bookmarks?scope=page|site|global&url=&q=          (requires auth)
 *  - GET /feed/bookmarks/all?type=all|page|site|global&q=        (requires auth) — every
 *      saved version across all scopes, newest-bookmarked first (the Bookmarks tab).
 */
import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { Page, Version, Bookmark, User } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { pageKey, hostOf } from '../services/url.js';
import { loadViewerSocial } from '../services/social.js';
import { serializeVersions, type RawVersion } from '../services/serialize.js';
import { sortVersions, type SortMode, type VersionScope } from '@yandz/shared';

export const feedRouter = Router();

const FEED_LIMIT = 50;
// Headroom for the in-app rank (foryou/latest) and bookmark recency order before we
// paginate: pages slice into this candidate set, so it bounds reachable scroll depth.
const CANDIDATE_CAP = 1000;

// 'latest' is a cross-page feed of ALL page-scoped versions (page modifications
// everywhere), as opposed to 'page' which is restricted to the viewer's current page.
type FeedScope = 'latest' | 'page' | 'site' | 'global';
type FeedFilter = 'all' | 'following' | 'mine';

/** Parse & clamp the pagination query params. */
function pageParams(req: Request): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || FEED_LIMIT)));
  return { offset, limit };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const asScope = (v: unknown): FeedScope =>
  v === 'latest' || v === 'page' || v === 'site' || v === 'global' ? v : 'global';
const asFilter = (v: unknown): FeedFilter =>
  v === 'all' || v === 'following' || v === 'mine' ? v : 'all';

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

/** Resolve the viewer's current page/host context from the active tab's URL. */
async function resolveContext(
  rawUrl: string,
): Promise<{ currentPageKey: string | null; pageId: Types.ObjectId | null; host: string }> {
  if (!rawUrl) return { currentPageKey: null, pageId: null, host: '' };
  const key = pageKey(rawUrl);
  const host = hostOf(rawUrl);
  const page = await Page.findOne({ urlKey: key }).select('_id').lean();
  return { currentPageKey: key, pageId: page ? (page._id as Types.ObjectId) : null, host };
}

/**
 * The base Mongo filter restricting a query to a scope tab, or null when the tab can't
 * resolve (page tab with no matching page; site tab off a non-web URL) → empty feed.
 */
function scopeFilter(
  scope: FeedScope,
  pageId: Types.ObjectId | null,
  host: string,
): Record<string, unknown> | null {
  // 'latest': every page-scoped version, across all pages (no page restriction).
  if (scope === 'latest') return { scope: 'page' as VersionScope };
  if (scope === 'page') return pageId ? { scope: 'page' as VersionScope, pageId } : null;
  if (scope === 'site') return host ? { scope: 'site' as VersionScope, host } : null;
  return { scope: 'global' as VersionScope };
}

// GET /feed — a scope tab's ranked list, filtered by all|following|mine.
feedRouter.get('/', async (req: Request, res: Response) => {
  const scope = asScope(req.query.scope);
  const filter = asFilter(req.query.filter);
  const sort = String(req.query.sort ?? 'foryou') as SortMode;
  const rawUrl = String(req.query.url ?? '');
  const { currentPageKey, pageId, host } = await resolveContext(rawUrl);
  const clauses = await searchClauses(String(req.query.q ?? ''));
  const { offset, limit } = pageParams(req);

  const base = scopeFilter(scope, pageId, host);
  if (!base) {
    res.json({ currentPageKey, versions: [], hasMore: false });
    return;
  }

  // "Mine": the viewer's own versions in this scope, newest first (DB-level pagination).
  if (filter === 'mine') {
    if (!req.userId) {
      res.json({ currentPageKey, versions: [], hasMore: false });
      return;
    }
    const f: Record<string, unknown> = { ...base, authorId: new Types.ObjectId(req.userId) };
    if (clauses.length) f.$or = clauses;
    const docs = await Version.find(f).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const pageDocs = (hasMore ? docs.slice(0, limit) : docs) as unknown as RawVersion[];
    res.json({ currentPageKey, versions: await serializeVersions(pageDocs, req.userId), hasMore });
    return;
  }

  // "All"/"Following": rank a block-filtered candidate set, then slice. Block-filter
  // (and the follow restriction) live IN the query so every page is contiguous.
  const social = await loadViewerSocial(req.userId ?? null);
  const versionFilter: Record<string, unknown> = { ...base };
  if (clauses.length) versionFilter.$or = clauses;
  if (filter === 'following') {
    const allowed = [...social.followSet].filter((id) => !social.blockSet.has(id));
    if (!allowed.length) {
      res.json({ currentPageKey, versions: [], hasMore: false });
      return;
    }
    versionFilter.authorId = { $in: allowed.map((id) => new Types.ObjectId(id)) };
  } else if (social.blockSet.size) {
    versionFilter.authorId = { $nin: [...social.blockSet] };
  }
  // `_id` is a stable tiebreaker so offset pagination is deterministic across ties.
  const raw = await Version.find(versionFilter).sort({ createdAt: -1, _id: -1 }).limit(CANDIDATE_CAP).lean();

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
  const pageDocs = rankedAll.slice(offset, offset + limit).map((r) => r._doc);

  res.json({ currentPageKey, versions: await serializeVersions(pageDocs, req.userId ?? null), hasMore });
});

// GET /feed/bookmarks — the viewer's saved versions in the given scope tab,
// newest-bookmarked first.
feedRouter.get('/bookmarks', requireAuth, async (req: Request, res: Response) => {
  const scope = asScope(req.query.scope);
  const rawUrl = String(req.query.url ?? '');
  const { currentPageKey, pageId, host } = await resolveContext(rawUrl);
  const base = scopeFilter(scope, pageId, host);
  if (!base) {
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

  const filter: Record<string, unknown> = { ...base, _id: { $in: versionIds } };
  if (clauses.length) filter.$or = clauses;
  const docs = await Version.find(filter).lean();

  // Preserve bookmark recency order, drop blocked authors, THEN paginate so each page
  // is block-filtered and contiguous.
  const byId = new Map(docs.map((d) => [String(d._id), d as unknown as RawVersion]));
  const ordered = versionIds
    .map((id) => byId.get(String(id)))
    .filter((v): v is RawVersion => !!v && !social.blockSet.has(String(v.authorId)));
  const hasMore = ordered.length > offset + limit;
  const pageDocs = ordered.slice(offset, offset + limit);

  res.json({ currentPageKey, versions: await serializeVersions(pageDocs, req.userId!), hasMore });
});

// GET /feed/bookmarks/all — EVERY saved version across ALL scopes (page, site, and global),
// not restricted to the current page/host, newest-bookmarked first. `type` narrows by
// content type (page|site|global); omitted/'all' returns them all. Drives the dedicated
// Bookmarks tab and its Pages/Sites/Global pills.
const asType = (v: unknown): VersionScope | 'all' =>
  v === 'page' || v === 'site' || v === 'global' ? v : 'all';

feedRouter.get('/bookmarks/all', requireAuth, async (req: Request, res: Response) => {
  const type = asType(req.query.type);
  const clauses = await searchClauses(String(req.query.q ?? ''));
  const { offset, limit } = pageParams(req);

  const [social, marks] = await Promise.all([
    loadViewerSocial(req.userId!),
    Bookmark.find({ userId: new Types.ObjectId(req.userId!) }).sort({ createdAt: -1, _id: -1 }).limit(CANDIDATE_CAP).lean(),
  ]);
  const versionIds = marks.map((m) => m.versionId);

  const filter: Record<string, unknown> = { _id: { $in: versionIds } };
  if (type !== 'all') filter.scope = type;
  if (clauses.length) filter.$or = clauses;
  const docs = await Version.find(filter).lean();

  // Preserve bookmark recency order, drop blocked authors, THEN paginate.
  const byId = new Map(docs.map((d) => [String(d._id), d as unknown as RawVersion]));
  const ordered = versionIds
    .map((id) => byId.get(String(id)))
    .filter((v): v is RawVersion => !!v && !social.blockSet.has(String(v.authorId)));
  const hasMore = ordered.length > offset + limit;
  const pageDocs = ordered.slice(offset, offset + limit);

  res.json({ currentPageKey: null, versions: await serializeVersions(pageDocs, req.userId!), hasMore });
});
