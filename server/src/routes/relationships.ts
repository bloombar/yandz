/**
 * Social graph mutations: follow/unfollow, mute/unmute, block/unblock.
 *
 * - Follow: drives the ranking follow-boost and push notifications.
 * - Mute: one-directional; suppresses notifications only.
 * - Block: reciprocal content hiding. Blocking also tears down any follow edges
 *   in BOTH directions (you can't follow someone you've blocked, or vice-versa).
 */
import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { Follow, Mute, Block } from '../models.js';
import { requireAuth } from '../lib/auth.js';

export const relationshipsRouter = Router();

/** Reject self-targeting and malformed ids; returns the target ObjectId or null. */
function targetId(req: Request): Types.ObjectId | null {
  if (!Types.ObjectId.isValid(req.params.id)) return null;
  if (req.params.id === req.userId) return null; // no self relationships
  return new Types.ObjectId(req.params.id);
}

// POST /users/:id/follow
relationshipsRouter.post('/:id/follow', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  const me = new Types.ObjectId(req.userId!);
  // Cannot follow someone in a block relationship with you.
  if (await Block.exists({ $or: [{ blockerId: me, blockedId: target }, { blockerId: target, blockedId: me }] })) {
    res.status(409).json({ error: 'blocked relationship' });
    return;
  }
  await Follow.updateOne({ followerId: me, followeeId: target }, { $setOnInsert: { followerId: me, followeeId: target } }, { upsert: true });
  res.json({ following: true });
});

// DELETE /users/:id/follow
relationshipsRouter.delete('/:id/follow', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  await Follow.deleteOne({ followerId: new Types.ObjectId(req.userId!), followeeId: target });
  res.json({ following: false });
});

// POST /users/:id/mute
relationshipsRouter.post('/:id/mute', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  const me = new Types.ObjectId(req.userId!);
  await Mute.updateOne({ muterId: me, mutedId: target }, { $setOnInsert: { muterId: me, mutedId: target } }, { upsert: true });
  res.json({ muted: true });
});

// DELETE /users/:id/mute
relationshipsRouter.delete('/:id/mute', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  await Mute.deleteOne({ muterId: new Types.ObjectId(req.userId!), mutedId: target });
  res.json({ muted: false });
});

// POST /users/:id/block — also removes follow edges in both directions.
relationshipsRouter.post('/:id/block', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  const me = new Types.ObjectId(req.userId!);
  await Block.updateOne({ blockerId: me, blockedId: target }, { $setOnInsert: { blockerId: me, blockedId: target } }, { upsert: true });
  // Tear down mutual follows so a blocked user is fully disentangled.
  await Follow.deleteMany({
    $or: [
      { followerId: me, followeeId: target },
      { followerId: target, followeeId: me },
    ],
  });
  res.json({ blocked: true });
});

// DELETE /users/:id/block
relationshipsRouter.delete('/:id/block', requireAuth, async (req, res) => {
  const target = targetId(req);
  if (!target) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  await Block.deleteOne({ blockerId: new Types.ObjectId(req.userId!), blockedId: target });
  res.json({ blocked: false });
});
