/**
 * Feed ranking — pure functions shared by server (authoritative ordering) and
 * client (optimistic re-sort). See §7 of the plan.
 *
 * Ordering blends three signals: net vote score, recency, and — per viewer —
 * whether the viewer follows the author (an additive boost).
 */

/** Additive boost applied when the viewing user follows a version's author. */
export const FOLLOW_BOOST = 1.5;

/** Reference epoch for the "hot" formula (Palimpsest launch, ms). Keeps scores bounded. */
export const EPOCH_MS = 1_700_000_000_000;

/**
 * Reddit "hot" score: log-scaled net votes plus a recency term. Early votes matter
 * most; newer items get a time bump. `createdAtMs` is a Unix ms timestamp.
 */
export function hotBase(up: number, down: number, createdAtMs: number): number {
  const score = up - down;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const seconds = (createdAtMs - EPOCH_MS) / 1000;
  return Number((sign * order + seconds / 45000).toFixed(7));
}

/**
 * Wilson score lower bound (95% confidence) — quality ranking robust to low vote
 * counts. Used for the "Top" tab. Returns 0 when there are no votes.
 */
export function wilson(up: number, down: number): number {
  const n = up + down;
  if (n === 0) return 0;
  const z = 1.959963984540054; // 95%
  const phat = up / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return Number(((center - margin) / denom).toFixed(7));
}

/**
 * Personalized "hot" rank for a specific viewer: the base hot score plus the
 * follow-boost when the viewer follows the author. The boost surfaces followed
 * authors without overriding strongly-voted versions.
 */
export function rankForViewer(hotScore: number, viewerFollowsAuthor: boolean): number {
  return hotScore + (viewerFollowsAuthor ? FOLLOW_BOOST : 0);
}

export type SortMode = 'hot' | 'top' | 'new';

export interface Rankable {
  hotScore: number;
  wilsonScore: number;
  createdAtMs: number;
  authorId: string;
}

/**
 * Sort a list of versions for a given viewer & mode. `followedAuthorIds` is the
 * viewer's follow set (used only for 'hot'). Returns a new, sorted array.
 */
export function sortVersions<T extends Rankable>(
  items: T[],
  mode: SortMode,
  followedAuthorIds: ReadonlySet<string>,
): T[] {
  const copy = [...items];
  switch (mode) {
    case 'top':
      copy.sort((a, b) => b.wilsonScore - a.wilsonScore || b.createdAtMs - a.createdAtMs);
      break;
    case 'new':
      copy.sort((a, b) => b.createdAtMs - a.createdAtMs);
      break;
    case 'hot':
    default:
      copy.sort(
        (a, b) =>
          rankForViewer(b.hotScore, followedAuthorIds.has(b.authorId)) -
          rankForViewer(a.hotScore, followedAuthorIds.has(a.authorId)),
      );
      break;
  }
  return copy;
}
