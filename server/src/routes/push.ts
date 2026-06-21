/**
 * Push-subscription management. The extension's service worker registers a Web
 * Push subscription and posts it here; we store one-or-more per user and use them
 * for follow notifications. Unsubscribe removes the stored subscription.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { PushSub } from '../models.js';
import { requireAuth } from '../lib/auth.js';

export const pushRouter = Router();

// POST /push/subscribe  { subscription }
pushRouter.post('/subscribe', requireAuth, async (req, res) => {
  const parsed = z.object({ subscription: z.object({ endpoint: z.string().url() }).passthrough() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid subscription' });
    return;
  }
  const userId = new Types.ObjectId(req.userId!);
  // De-dupe by endpoint so re-subscribing doesn't create duplicates.
  await PushSub.updateOne(
    { userId, 'subscription.endpoint': parsed.data.subscription.endpoint },
    { $set: { userId, subscription: parsed.data.subscription } },
    { upsert: true },
  );
  res.status(201).json({ ok: true });
});

// POST /push/unsubscribe  { endpoint }
pushRouter.post('/unsubscribe', requireAuth, async (req, res) => {
  const parsed = z.object({ endpoint: z.string().url() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  await PushSub.deleteOne({ userId: new Types.ObjectId(req.userId!), 'subscription.endpoint': parsed.data.endpoint });
  res.json({ ok: true });
});
