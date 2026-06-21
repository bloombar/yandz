import { describe, it, expect } from 'vitest';
import {
  hotBase,
  wilson,
  rankForViewer,
  sortVersions,
  FOLLOW_BOOST,
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

describe('rankForViewer', () => {
  it('adds FOLLOW_BOOST when the viewer follows the author', () => {
    expect(rankForViewer(2, true)).toBe(2 + FOLLOW_BOOST);
    expect(rankForViewer(2, false)).toBe(2);
  });
});

describe('sortVersions', () => {
  const base: Rankable[] = [
    { hotScore: 1, wilsonScore: 0.9, createdAtMs: 300, authorId: 'a' },
    { hotScore: 2, wilsonScore: 0.5, createdAtMs: 100, authorId: 'b' },
    { hotScore: 0.5, wilsonScore: 0.7, createdAtMs: 200, authorId: 'c' },
  ];

  it('foryou: orders by personalized hot score by default', () => {
    const out = sortVersions(base, 'foryou', new Set());
    expect(out.map((v) => v.authorId)).toEqual(['b', 'a', 'c']);
  });

  it('foryou: follow-boost can lift a followed author above a higher base score', () => {
    const out = sortVersions(base, 'foryou', new Set(['a']));
    expect(out[0]!.authorId).toBe('a'); // 1 + 1.5 = 2.5 > 2
  });

  it('latest: orders by recency', () => {
    const out = sortVersions(base, 'latest', new Set());
    expect(out.map((v) => v.authorId)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const copy = [...base];
    sortVersions(base, 'foryou', new Set());
    expect(base).toEqual(copy);
  });
});
