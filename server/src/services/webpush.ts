/**
 * Web Push (VAPID) fan-out. When a user posts a new version, notify their
 * followers — EXCEPT followers who have muted or blocked the author (§9/§9a).
 */
import webpush from 'web-push';
import { config } from '../config.js';
import { Follow, Mute, PushSub } from '../models.js';
import { loadBlockSet } from './social.js';
import { Types } from 'mongoose';

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!config.webPush.publicKey || !config.webPush.privateKey) return false;
  webpush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
  configured = true;
  return true;
}

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Compute the set of follower ids that should receive a notification about
 * `authorId`'s activity: followers minus (followers who muted the author) minus
 * (anyone in a reciprocal block relationship with the author).
 */
export async function eligibleRecipientIds(authorId: string): Promise<string[]> {
  const author = new Types.ObjectId(authorId);
  const [followers, muters, blockSet] = await Promise.all([
    Follow.find({ followeeId: author }).lean(),
    Mute.find({ mutedId: author }).lean(),
    loadBlockSet(authorId),
  ]);
  const mutedBy = new Set(muters.map((m) => m.muterId.toString()));
  return followers
    .map((f) => f.followerId.toString())
    .filter((uid) => uid !== authorId && !mutedBy.has(uid) && !blockSet.has(uid));
}

/** Send a push to all of a user's subscriptions; prunes dead subscriptions. */
export async function pushToUser(userId: string, payload: NotifyPayload): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = await PushSub.find({ userId: new Types.ObjectId(userId) });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription as webpush.PushSubscription, JSON.stringify(payload));
      } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await s.deleteOne();
      }
    }),
  );
}

/** Notify all eligible followers of an author about a new version. */
export async function notifyFollowersOfNewVersion(
  authorId: string,
  payload: NotifyPayload,
): Promise<number> {
  const recipients = await eligibleRecipientIds(authorId);
  await Promise.all(recipients.map((uid) => pushToUser(uid, payload)));
  return recipients.length;
}
