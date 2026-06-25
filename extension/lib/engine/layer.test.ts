/**
 * Unit tests for layer merging — the precedence rule that makes page override site
 * override global when scopes touch the same element.
 */
import { describe, it, expect } from 'vitest';
import { mergeScopedPatches } from './layer.js';
import type { AnyPatch } from '@yandz/shared';

const css = (sel: string, color: string, order = 0): AnyPatch =>
  ({ op: 'cssOverride', target: { cssSelector: sel }, order, payload: { declarations: { color } } }) as AnyPatch;

describe('mergeScopedPatches', () => {
  it('flattens layers bottom→top with a monotonic, gapless order', () => {
    const merged = mergeScopedPatches([
      { patches: [css('h1', 'red', 0), css('h2', 'red', 1)] }, // global
      { patches: [css('h3', 'green', 0)] }, // site
      { patches: [css('h4', 'blue', 0)] }, // page
    ]);
    expect(merged.map((p) => p.order)).toEqual([0, 1, 2, 3]);
    // Bottom layer first, top layer last.
    expect(merged.map((p) => p.target.cssSelector)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('gives the top (page) layer the higher order on a shared element, so it wins', () => {
    const merged = mergeScopedPatches([
      { patches: [css('h1', 'global-color', 5)] }, // global, originally order 5
      { patches: [css('h1', 'site-color', 0)] }, // site
      { patches: [css('h1', 'page-color', 0)] }, // page
    ]);
    // The page patch applies last (highest order), regardless of original per-version order.
    const last = merged[merged.length - 1]!;
    expect(last.op === 'cssOverride' && last.payload.declarations.color).toBe('page-color');
    expect(merged.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it('ignores the original per-patch order (rewrites it entirely)', () => {
    const merged = mergeScopedPatches([{ patches: [css('a', 'x', 99), css('b', 'y', 99)] }]);
    expect(merged.map((p) => p.order)).toEqual([0, 1]);
  });

  it('returns an empty list for no layers', () => {
    expect(mergeScopedPatches([])).toEqual([]);
  });
});
