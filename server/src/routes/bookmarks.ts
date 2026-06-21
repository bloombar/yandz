/**
 * Bookmark toggle routes. A bookmark saves a version to the user's global
 * Bookmarks feed (see /feed/bookmarks). Author or not, anyone signed in can
 * bookmark any visible version.
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { Bookmark, Version } from '../models.js';
import { requireAuth } from '../lib/auth.js';

export const bookmarksRouter = Router();

// POST /versions/:id/bookmark — add (idempotent).
bookmarksRouter.post('/:id/bookmark', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const versionId = new Types.ObjectId(req.params.id);
  if (!(await Version.exists({ _id: versionId }))) {
    res.status(404).json({ error: 'version not found' });
    return;
  }
  const userId = new Types.ObjectId(req.userId!);
  await Bookmark.updateOne({ userId, versionId }, { $setOnInsert: { userId, versionId } }, { upsert: true });
  res.json({ bookmarked: true });
});

// DELETE /versions/:id/bookmark — remove.
bookmarksRouter.delete('/:id/bookmark', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  await Bookmark.deleteOne({
    userId: new Types.ObjectId(req.userId!),
    versionId: new Types.ObjectId(req.params.id),
  });
  res.json({ bookmarked: false });
});
