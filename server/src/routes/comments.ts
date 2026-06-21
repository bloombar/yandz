/**
 * Per-version threaded comments. Listing filters out comments authored by users
 * in a reciprocal block relationship with the viewer; posting sanitizes the body,
 * bumps the version's comment count, and broadcasts to the version room so open
 * boards update in real time.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Comment, Version, User } from '../models.js';
import { requireAuth, withOptionalAuth } from '../lib/auth.js';
import { loadBlockSet } from '../services/social.js';
import { sanitizeText } from '../services/sanitize.js';
import { emitNewComment } from '../realtime/io.js';

export const commentsRouter = Router();

// GET /versions/:id/comments — flat list (client builds the tree from parentCommentId).
commentsRouter.get('/:id/comments', withOptionalAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const versionId = new Types.ObjectId(req.params.id);
  const blockSet = req.userId ? await loadBlockSet(req.userId) : new Set<string>();

  const comments = await Comment.find({ versionId }).sort({ createdAt: 1 }).lean();
  const visible = comments.filter((c) => !blockSet.has(String(c.authorId)));

  // Attach author handles.
  const authorIds = [...new Set(visible.map((c) => String(c.authorId)))];
  const authors = await User.find({ _id: { $in: authorIds } }).select('handle').lean();
  const handleById = new Map(authors.map((a) => [String(a._id), a.handle]));

  res.json(
    visible.map((c) => ({
      id: String(c._id),
      author: { id: String(c.authorId), handle: handleById.get(String(c.authorId)) ?? 'unknown' },
      parentCommentId: c.parentCommentId ? String(c.parentCommentId) : null,
      body: c.body,
      createdAt: c.createdAt,
    })),
  );
});

// POST /versions/:id/comments  { body, parentCommentId? }
commentsRouter.post('/:id/comments', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const parsed = z
    .object({ body: z.string().min(1).max(5000), parentCommentId: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const versionId = new Types.ObjectId(req.params.id);
  if (!(await Version.exists({ _id: versionId }))) {
    res.status(404).json({ error: 'version not found' });
    return;
  }

  const comment = await Comment.create({
    versionId,
    authorId: new Types.ObjectId(req.userId!),
    parentCommentId: parsed.data.parentCommentId ? new Types.ObjectId(parsed.data.parentCommentId) : null,
    body: sanitizeText(parsed.data.body),
  });
  await Version.updateOne({ _id: versionId }, { $inc: { commentCount: 1 } });

  // Broadcast the created comment to everyone viewing this version's board. The
  // author handle comes from the JWT claims (set by requireAuth).
  const payload = {
    id: String(comment._id),
    author: { id: req.userId!, handle: req.userHandle ?? 'unknown' },
    parentCommentId: parsed.data.parentCommentId ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
  };
  emitNewComment(req.params.id, payload);
  res.status(201).json(payload);
});
