/**
 * Page read routes. Given a raw URL, resolve its urlKey and return the ranked,
 * block-filtered list of versions for the current viewer. This is what the
 * content script calls on page load to decide what to auto-apply.
 */
import { Router, type Request, type Response } from 'express';
import { Page, Version, User } from '../models.js';
import { pageKey } from '../services/url.js';
import { loadViewerSocial } from '../services/social.js';
import { sortVersions, type SortMode, type Rankable } from '@yandz/shared';

export const pagesRouter = Router();

/** Serialize a version doc for the client, attaching the author handle. */
function serializeVersion(v: any, handleById: Map<string, string>) {
  return {
    id: String(v._id),
    pageId: String(v.pageId),
    name: v.name,
    author: { id: String(v.authorId), handle: handleById.get(String(v.authorId)) ?? 'unknown' },
    patches: v.patches,
    parentVersionId: v.parentVersionId ? String(v.parentVersionId) : null,
    up: v.up,
    down: v.down,
    hotScore: v.hotScore,
    wilsonScore: v.wilsonScore,
    commentCount: v.commentCount,
    createdAt: v.createdAt,
  };
}

// GET /pages?url=<rawUrl>&sort=hot|top|new
// Returns { page, versions } with versions ranked for the viewer and filtered
// to exclude authors in a reciprocal block relationship.
pagesRouter.get('/', async (req: Request, res: Response) => {
  const rawUrl = String(req.query.url ?? '');
  if (!rawUrl) {
    res.status(400).json({ error: 'url required' });
    return;
  }
  const sort = (String(req.query.sort ?? 'hot') as SortMode);
  const urlKey = pageKey(rawUrl);

  const page = await Page.findOne({ urlKey }).lean();
  if (!page) {
    res.json({ page: { urlKey, versionCount: 0 }, versions: [] });
    return;
  }

  const [social, versions] = await Promise.all([
    loadViewerSocial(req.userId ?? null),
    Version.find({ pageId: page._id }).lean(),
  ]);

  // Hide content authored by blocked users (reciprocal).
  const visible = versions.filter((v) => !social.blockSet.has(String(v.authorId)));

  // Resolve author handles in one query.
  const authorIds = [...new Set(visible.map((v) => String(v.authorId)))];
  const authors = await User.find({ _id: { $in: authorIds } })
    .select('handle')
    .lean();
  const handleById = new Map(authors.map((a) => [String(a._id), a.handle]));

  // Rank for this viewer (follow-boost applied for 'hot').
  const rankable: (Rankable & { _doc: any })[] = visible.map((v) => ({
    hotScore: v.hotScore,
    wilsonScore: v.wilsonScore,
    createdAtMs: v.createdAt ? new Date(v.createdAt).getTime() : 0,
    authorId: String(v.authorId),
    _doc: v,
  }));
  const ranked = sortVersions(rankable, sort, social.followSet);

  res.json({
    page: { id: String(page._id), urlKey, title: page.title, versionCount: visible.length },
    versions: ranked.map((r) => serializeVersion(r._doc, handleById)),
  });
});
