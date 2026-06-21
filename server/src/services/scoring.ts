/**
 * Vote tallying and denormalized score maintenance for a Version.
 *
 * Votes live in their own collection (one per user/version) for integrity; the
 * aggregate up/down counts and the precomputed hot/wilson scores are denormalized
 * onto the Version so the feed can be ordered cheaply. The viewer-specific
 * follow-boost is applied at read time (see services/social + shared/ranking).
 */
import { Types } from 'mongoose';
import { hotBase, wilson } from '@yandz/shared';
import { Version, Vote } from '../models.js';

/**
 * Recompute up/down/hotScore/wilsonScore for a version from its Vote rows and
 * persist them. Call after any vote mutation. Returns the updated tallies.
 */
export async function recomputeVersionScore(
  versionId: string,
): Promise<{ up: number; down: number; hotScore: number; wilsonScore: number }> {
  const id = new Types.ObjectId(versionId);
  // Tally up/down in a single aggregation pass.
  const agg = await Vote.aggregate<{ _id: 1 | -1; n: number }>([
    { $match: { versionId: id } },
    { $group: { _id: '$value', n: { $sum: 1 } } },
  ]);
  let up = 0;
  let down = 0;
  for (const row of agg) {
    if (row._id === 1) up = row.n;
    else down = row.n;
  }

  const version = await Version.findById(id).select('createdAt').lean();
  const createdAtMs = version?.createdAt ? new Date(version.createdAt).getTime() : Date.now();
  const hotScore = hotBase(up, down, createdAtMs);
  const wilsonScore = wilson(up, down);

  await Version.updateOne({ _id: id }, { $set: { up, down, hotScore, wilsonScore } });
  return { up, down, hotScore, wilsonScore };
}
