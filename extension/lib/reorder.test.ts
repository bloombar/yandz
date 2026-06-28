import { describe, it, expect } from 'vitest';
import { moveBefore } from './reorder.js';

describe('moveBefore', () => {
  it('moves an item to just before the target (downward)', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'a', 'd')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item to just before the target (upward)', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when src === target or an id is missing', () => {
    const list = ['a', 'b', 'c'];
    expect(moveBefore(list, 'b', 'b')).toBe(list);
    expect(moveBefore(list, 'x', 'b')).toBe(list);
    expect(moveBefore(list, 'a', 'x')).toBe(list);
  });

  it('reorders to the front when targeting the first item', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });
});
