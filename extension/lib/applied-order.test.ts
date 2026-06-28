import { describe, it, expect } from 'vitest';
import { orderAppliedRows } from './applied-order.js';
import type { FeedScope } from './api.js';

const row = (id: string, scope: FeedScope) => ({ id, scope });

describe('orderAppliedRows', () => {
  it('puts a requiring version above its same-scope dependency (applied-after = higher)', () => {
    // Input arrives in application order: dependency A first, then the version B that requires it.
    const ordered = orderAppliedRows([row('a', 'page'), row('b', 'page')]);
    expect(ordered.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('keeps scope priority: page on top, then site, then global', () => {
    const ordered = orderAppliedRows([row('g', 'global'), row('s', 'site'), row('p', 'page')]);
    expect(ordered.map((r) => r.id)).toEqual(['p', 's', 'g']);
  });

  it('a page version sits above a broader-scope dependency it requires', () => {
    // B (page) requires A (global); A arrives first as a dependency.
    const ordered = orderAppliedRows([row('a', 'global'), row('b', 'page')]);
    expect(ordered.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('orders later-applied (winning) activations above earlier ones within a scope', () => {
    const ordered = orderAppliedRows([row('first', 'global'), row('second', 'global')]);
    expect(ordered.map((r) => r.id)).toEqual(['second', 'first']);
  });
});
