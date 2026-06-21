import { describe, it, expect } from 'vitest';
import {
  hotBase,
  wilson,
  feedRank,
  sortVersions,
  FOLLOW_BOOST,
  QUALITY_WEIGHT,
  EPOCH_MS,
  type Rankable,
} from './ranking.js';

describe('hotBase', () => {
  it('gives a higher score to more-upvoted content at the same time', () => {
    const t = EPOCH_MS + 1000;
    expect(hotBase(100, 0, t)).toBeGreaterThan(hotBase(10, 0, t));
  });

  it('gives a higher score to newer content with equal votes', () => {
    expect(hotBase(10, 0, EPOCH_MS + 100_000)).toBeGreaterThan(hotBase(10, 0, EPOCH_MS));
  });

  it('treats net negative votes as negative order', () => {
    const t = EPOCH_MS;
    expect(hotBase(0, 50, t)).toBeLessThan(hotBase(0, 0, t));
  });

  it('uses |score|>=1 floor so a tie does not throw', () => {
    expect(Number.isFinite(hotBase(0, 0, EPOCH_MS))).toBe(true);
  });
});

describe('wilson', () => {
  it('returns 0 with no votes', () => {
    expect(wilson(0, 0)).toBe(0);
  });

  it('ranks 90/10 above 8/2 (more evidence, similar ratio)', () => {
    expect(wilson(90, 10)).toBeGreaterThan(wilson(8, 2));
  });

  it('is bounded in [0,1]', () => {
    const v = wilson(50, 50);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('feedRank', () => {
  const NOW = EPOCH_MS + 1_000_000_000; // a fixed "now" for determinism
  const item = (wilsonScore: number, createdAtMs: number): Rankable => ({
    hotScore: 0,
    wilsonScore,
    createdAtMs,
    authorId: 'x',
  });

  it('weights vote quality', () => {
    expect(feedRank(item(0.9, NOW), false, NOW)).toBeGreaterThan(feedRank(item(0.1, NOW), false, NOW));
  });

  it('adds FOLLOW_BOOST when following the author', () => {
    expect(feedRank(item(0.5, NOW), true, NOW) - feedRank(item(0.5, NOW), false, NOW)).toBeCloseTo(FOLLOW_BOOST);
  });

  it('quality can outweigh recency (unlike "latest")', () => {
    const oldButLoved = item(1, NOW - 20 * 86_400_000); // 20 days old, top quality
    const freshNoVotes = item(0, NOW); // brand new, no votes
    expect(feedRank(oldButLoved, false, NOW)).toBeGreaterThan(feedRank(freshNoVotes, false, NOW));
    expect(QUALITY_WEIGHT).toBeGreaterThan(1);
  });
});

describe('sortVersions', () => {
  const NOW = EPOCH_MS + 1_000_000_000;
  // newest = a, then c, then b; but b has the best votes.
  const base: Rankable[] = [
    { hotScore: 0, wilsonScore: 0.0, createdAtMs: NOW - 1_000, authorId: 'a' },
    { hotScore: 0, wilsonScore: 0.9, createdAtMs: NOW - 3_000, authorId: 'b' },
    { hotScore: 0, wilsonScore: 0.0, createdAtMs: NOW - 2_000, authorId: 'c' },
  ];

  it('latest: strict reverse-chronological', () => {
    const out = sortVersions(base, 'latest', new Set(), NOW);
    expect(out.map((v) => v.authorId)).toEqual(['a', 'c', 'b']);
  });

  it('foryou: differs from latest — the well-voted version rises to the top', () => {
    const out = sortVersions(base, 'foryou', new Set(), NOW);
    expect(out[0]!.authorId).toBe('b'); // best votes, despite being oldest
    expect(out.map((v) => v.authorId)).not.toEqual(['a', 'c', 'b']);
  });

  it('foryou: follow-boost lifts a followed author among similar-quality items', () => {
    // b still tops on votes; among the two unvoted items, followed c beats newer a.
    const out = sortVersions(base, 'foryou', new Set(['c']), NOW);
    expect(out.map((v) => v.authorId)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const copy = [...base];
    sortVersions(base, 'foryou', new Set(), NOW);
    expect(base).toEqual(copy);
  });
});
