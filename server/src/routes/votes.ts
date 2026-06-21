/**
 * Voting routes. One vote per (user, version); re-voting the same value clears it
 * (toggle), voting the opposite value switches it. After any change the version's
 * denormalized scores are recomputed and the new tally is broadcast to the page.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Vote, Version, Page } from '../models.js';
import { requireAuth } from '../lib/auth.js';
import { recomputeVersionScore } from '../services/scoring.js';
import { emitVoteUpdate } from '../realtime/io.js';

export const votesRouter = Router();

// POST /versions/:id/vote  { value: 1 | -1 }
votesRouter.post('/:id/vote', requireAuth, async (req, res) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const parsed = z.object({ value: z.union([z.literal(1), z.literal(-1)]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'value must be 1 or -1' });
    return;
  }
  const versionId = new Types.ObjectId(req.params.id);
  const userId = new Types.ObjectId(req.userId!);

  // A vote is sticky: clicking your current direction does nothing (no un-vote);
  // clicking the opposite direction switches it. Votes are never removed here.
  const existing = await Vote.findOne({ versionId, userId });
  if (!existing) {
    await Vote.create({ versionId, userId, value: parsed.data.value });
  } else if (existing.value !== parsed.data.value) {
    existing.value = parsed.data.value; // switch direction
    await existing.save();
  }
  // same value → keep as-is (no-op)

  const tally = await recomputeVersionScore(req.params.id);

  // Broadcast the new score to anyone viewing this page's version list.
  const version = await Version.findById(versionId).select('pageId').lean();
  if (version) {
    const page = await Page.findById(version.pageId).select('urlKey').lean();
    if (page) emitVoteUpdate(page.urlKey, { versionId: req.params.id, ...tally });
  }

  // The viewer's resulting vote is always the value they sent (never cleared).
  res.json({ ...tally, myVote: parsed.data.value });
});
