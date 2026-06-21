/**
 * Shared version serialization for the feeds, the per-page list, and profiles.
 *
 * Hydrates a set of lean Version docs into the client-facing shape, attaching the
 * author handle, the page (urlKey + title) the version modifies, and — for an
 * authenticated viewer — whether they've bookmarked it. Batches the author/page/
 * bookmark lookups so a list costs a constant number of queries.
 */
import { Types } from 'mongoose';
import { User, Page, Bookmark, Vote, Version } from '../models.js';

/** Minimal shape we need off a lean Version doc. */
export interface RawVersion {
  _id: Types.ObjectId | string;
  pageId: Types.ObjectId | string;
  authorId: Types.ObjectId | string;
  name: string;
  patches: unknown[];
  parentVersionId?: Types.ObjectId | string | null;
  up: number;
  down: number;
  hotScore: number;
  wilsonScore: number;
  commentCount: number;
  createdAt?: Date;
}

export interface SerializedVersion {
  id: string;
  name: string;
  author: { id: string; handle: string };
  page: { urlKey: string; title: string };
  patches: unknown[];
  parentVersionId: string | null;
  /** Author of the version this one was based on (for "based on u/x" links), or null. */
  parentAuthor: { id: string; handle: string } | null;
  up: number;
  down: number;
  hotScore: number;
  wilsonScore: number;
  commentCount: number;
  bookmarked: boolean;
  /** The viewer's vote on this version: 1 (up), -1 (down), or 0 (none). */
  myVote: 1 | -1 | 0;
  createdAt: Date | undefined;
}

/**
 * Serialize a list of versions for `viewerId` (null when anonymous). One query each
 * for the authors, the pages, and the viewer's bookmarks over this set.
 */
export async function serializeVersions(
  versions: RawVersion[],
  viewerId: string | null,
): Promise<SerializedVersion[]> {
  if (versions.length === 0) return [];

  // Resolve the authors of parent versions (for "based on u/x" attribution).
  const parentIds = versions.map((v) => v.parentVersionId).filter(Boolean) as Array<Types.ObjectId | string>;
  const parentVersions = parentIds.length
    ? await Version.find({ _id: { $in: parentIds } }).select('authorId').lean()
    : [];
  const parentAuthorByParentId = new Map(parentVersions.map((pv) => [String(pv._id), String(pv.authorId)]));

  const authorIds = [
    ...new Set([
      ...versions.map((v) => String(v.authorId)),
      ...parentVersions.map((pv) => String(pv.authorId)),
    ]),
  ];
  const pageIds = [...new Set(versions.map((v) => String(v.pageId)))];

  const versionIds = versions.map((v) => v._id);
  const [authors, pages, bookmarks, votes] = await Promise.all([
    User.find({ _id: { $in: authorIds } }).select('handle').lean(),
    Page.find({ _id: { $in: pageIds } }).select('urlKey title').lean(),
    viewerId
      ? Bookmark.find({ userId: new Types.ObjectId(viewerId), versionId: { $in: versionIds } }).lean()
      : Promise.resolve([]),
    viewerId
      ? Vote.find({ userId: new Types.ObjectId(viewerId), versionId: { $in: versionIds } }).lean()
      : Promise.resolve([]),
  ]);

  const handleById = new Map(authors.map((a) => [String(a._id), a.handle]));
  const pageById = new Map(pages.map((p) => [String(p._id), { urlKey: p.urlKey, title: p.title }]));
  const bookmarked = new Set(bookmarks.map((b) => String(b.versionId)));
  const voteByVersion = new Map(votes.map((vt) => [String(vt.versionId), vt.value as 1 | -1]));

  return versions.map((v) => {
    const parentAuthorId = v.parentVersionId
      ? parentAuthorByParentId.get(String(v.parentVersionId))
      : undefined;
    return {
    id: String(v._id),
    name: v.name,
    author: { id: String(v.authorId), handle: handleById.get(String(v.authorId)) ?? 'unknown' },
    page: pageById.get(String(v.pageId)) ?? { urlKey: '', title: '' },
    patches: v.patches,
    parentVersionId: v.parentVersionId ? String(v.parentVersionId) : null,
    parentAuthor: parentAuthorId
      ? { id: parentAuthorId, handle: handleById.get(parentAuthorId) ?? 'unknown' }
      : null,
    up: v.up,
    down: v.down,
    hotScore: v.hotScore,
    wilsonScore: v.wilsonScore,
    commentCount: v.commentCount,
    bookmarked: bookmarked.has(String(v._id)),
    myVote: voteByVersion.get(String(v._id)) ?? 0,
    createdAt: v.createdAt,
    };
  });
}
