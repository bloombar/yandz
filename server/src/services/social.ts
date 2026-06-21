/**
 * Per-viewer social sets used to filter content and personalize ranking.
 *
 * - blockSet: reciprocal — every user the viewer blocked OR who blocked the viewer.
 *   Content authored by anyone in this set is hidden from the viewer everywhere.
 * - muteSet: one-directional — users the viewer muted (notifications suppressed only).
 * - followSet: users the viewer follows (drives the ranking follow-boost).
 *
 * See §7, §9, §9a of the plan.
 */
import { Block, Follow, Mute } from '../models.js';
import { Types } from 'mongoose';

export interface ViewerSocial {
  blockSet: Set<string>;
  muteSet: Set<string>;
  followSet: Set<string>;
}

// lean() flattens ObjectId ref fields into a structural type, so accept anything
// stringifiable here and normalize to string ids.
const ids = (arr: Array<{ toString(): string } | null | undefined>): string[] =>
  arr.filter((x): x is { toString(): string } => !!x).map((x) => x.toString());

/** Load the reciprocal block set for a viewer (both directions). */
export async function loadBlockSet(viewerId: string): Promise<Set<string>> {
  const id = new Types.ObjectId(viewerId);
  const rows = await Block.find({ $or: [{ blockerId: id }, { blockedId: id }] }).lean();
  const set = new Set<string>();
  for (const r of rows) {
    const other = r.blockerId.toString() === viewerId ? r.blockedId : r.blockerId;
    set.add(other.toString());
  }
  return set;
}

export async function loadViewerSocial(viewerId: string | null): Promise<ViewerSocial> {
  if (!viewerId) {
    return { blockSet: new Set(), muteSet: new Set(), followSet: new Set() };
  }
  const id = new Types.ObjectId(viewerId);
  const [blockSet, mutes, follows] = await Promise.all([
    loadBlockSet(viewerId),
    Mute.find({ muterId: id }).lean(),
    Follow.find({ followerId: id }).lean(),
  ]);
  return {
    blockSet,
    muteSet: new Set(ids(mutes.map((m) => m.mutedId))),
    followSet: new Set(ids(follows.map((f) => f.followeeId))),
  };
}

/** Filter a list of authored items, removing those by blocked users. */
export function filterByBlock<T extends { authorId: { toString(): string } }>(
  items: T[],
  blockSet: Set<string>,
): T[] {
  return items.filter((it) => !blockSet.has(it.authorId.toString()));
}
