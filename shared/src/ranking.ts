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

/** Weight on vote quality (Wilson score, 0..1) in the personalized feed rank. */
export const QUALITY_WEIGHT = 3;
/** Recency contributes 1 → 0 over this many days (a bounded freshness component). */
export const RECENCY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Personalized "For you" feed rank — deliberately NOT just recency, so it differs
 * from "Latest". Blends vote quality (Wilson, weighted), a follow boost for authors
 * the viewer follows, and a bounded recency term that fades over RECENCY_WINDOW_DAYS.
 * Votes and follows therefore reorder the feed rather than time dominating it.
 */
export function feedRank(item: Rankable, viewerFollowsAuthor: boolean, nowMs: number = Date.now()): number {
  const ageDays = Math.max(0, (nowMs - item.createdAtMs) / DAY_MS);
  const recency = Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS);
  return QUALITY_WEIGHT * item.wilsonScore + (viewerFollowsAuthor ? FOLLOW_BOOST : 0) + recency;
}

/**
 * The two feeds offered in the UI:
 *  - 'foryou' — personalized feed rank (vote quality + follow boost + recency).
 *  - 'latest' — strictly reverse-chronological.
 * Both are applied after block-filtering, which happens server-side.
 */
export type SortMode = 'foryou' | 'latest';

export interface Rankable {
  hotScore: number;
  wilsonScore: number;
  createdAtMs: number;
  authorId: string;
}

/**
 * Sort a list of versions for a given viewer & mode. `followedAuthorIds` is the
 * viewer's follow set (used only by 'foryou'). `nowMs` is injectable for tests.
 * Returns a new, sorted array.
 */
export function sortVersions<T extends Rankable>(
  items: T[],
  mode: SortMode,
  followedAuthorIds: ReadonlySet<string>,
  nowMs: number = Date.now(),
): T[] {
  const copy = [...items];
  if (mode === 'latest') {
    copy.sort((a, b) => b.createdAtMs - a.createdAtMs);
  } else {
    // 'foryou': rank by feed score; break ties by recency.
    copy.sort(
      (a, b) =>
        feedRank(b, followedAuthorIds.has(b.authorId), nowMs) -
          feedRank(a, followedAuthorIds.has(a.authorId), nowMs) ||
        b.createdAtMs - a.createdAtMs,
    );
  }
  return copy;
}
