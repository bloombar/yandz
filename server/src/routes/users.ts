/**
 * User read routes: public profiles (handle + reverse-chronological modified
 * pages + viewer's relationship state), the viewer's "following" list, and the
 * account-settings lists of muted/blocked users (each undoable via relationships).
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { User, Version, Follow, Mute, Block } from '../models.js';
import { requireAuth, withOptionalAuth } from '../lib/auth.js';
import { serializeVersions, type RawVersion } from '../services/serialize.js';

export const usersRouter = Router();

/** Map a list of user docs to public {id, handle} objects. */
function publicUsers(users: Array<{ _id: unknown; handle: string }>) {
  return users.map((u) => ({ id: String(u._id), handle: u.handle }));
}

// GET /users/me/following — users the viewer follows (for the Following panel).
usersRouter.get('/me/following', requireAuth, async (req, res) => {
  const follows = await Follow.find({ followerId: new Types.ObjectId(req.userId!) }).lean();
  const users = await User.find({ _id: { $in: follows.map((f) => f.followeeId) } }).select('handle').lean();
  res.json(publicUsers(users));
});

// GET /users/me/muted and /users/me/blocked — account-settings lists.
usersRouter.get('/me/muted', requireAuth, async (req, res) => {
  const mutes = await Mute.find({ muterId: new Types.ObjectId(req.userId!) }).lean();
  const users = await User.find({ _id: { $in: mutes.map((m) => m.mutedId) } }).select('handle').lean();
  res.json(publicUsers(users));
});

usersRouter.get('/me/blocked', requireAuth, async (req, res) => {
  // Only blocks the viewer created are shown (so they can be undone here).
  const blocks = await Block.find({ blockerId: new Types.ObjectId(req.userId!) }).lean();
  const users = await User.find({ _id: { $in: blocks.map((b) => b.blockedId) } }).select('handle').lean();
  res.json(publicUsers(users));
});

// GET /users/:id — public profile + that user's modified pages (newest first).
usersRouter.get('/:id', withOptionalAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const target = new Types.ObjectId(req.params.id);
  const user = await User.findById(target).select('handle').lean();
  if (!user) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // The user's versions, newest first, in the shared feed-item shape so the profile
  // can reuse the same VersionRow component as the feeds.
  const versions = await Version.find({ authorId: target }).sort({ createdAt: -1 }).limit(100).lean();
  const modifications = await serializeVersions(versions as unknown as RawVersion[], req.userId ?? null);

  // Viewer's relationship state toward this profile (drives toggle button states).
  let relationship = { following: false, muted: false, blocked: false };
  if (req.userId) {
    const me = new Types.ObjectId(req.userId);
    const [following, muted, blocked] = await Promise.all([
      Follow.exists({ followerId: me, followeeId: target }),
      Mute.exists({ muterId: me, mutedId: target }),
      Block.exists({ blockerId: me, blockedId: target }),
    ]);
    relationship = { following: !!following, muted: !!muted, blocked: !!blocked };
  }

  res.json({ user: { id: String(user._id), handle: user.handle }, modifications, relationship });
});
