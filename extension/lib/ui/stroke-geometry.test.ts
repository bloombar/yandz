/**
 * Unit tests for stroke geometry — the percentage→pixel mapping that anchors a drawing
 * to its target element so it tracks the element as the page scrolls.
 */
import { describe, it, expect } from 'vitest';
import { pctToClient, strokeToClient, type AnchorRect } from './stroke-geometry.js';

describe('stroke geometry', () => {
  it('maps a percentage point to client coordinates within the anchor rect', () => {
    const rect: AnchorRect = { left: 100, top: 50, width: 200, height: 400 };
    expect(pctToClient([0, 0], rect)).toEqual([100, 50]); // top-left of the anchor
    expect(pctToClient([100, 100], rect)).toEqual([300, 450]); // bottom-right
    expect(pctToClient([50, 25], rect)).toEqual([200, 150]); // center-x, quarter-y
  });

  it('shifts with the anchor when it scrolls (same percentages, moved rect)', () => {
    const before: AnchorRect = { left: 0, top: 300, width: 100, height: 100 };
    const afterScrollUp: AnchorRect = { left: 0, top: 100, width: 100, height: 100 }; // scrolled 200px up
    const p: [number, number] = [50, 50];
    expect(pctToClient(p, before)).toEqual([50, 350]);
    expect(pctToClient(p, afterScrollUp)).toEqual([50, 150]); // moved up by 200, tracking the element
  });

  it('maps a whole stroke and ignores the optional pressure component', () => {
    const rect: AnchorRect = { left: 0, top: 0, width: 100, height: 100 };
    expect(strokeToClient([[10, 20, 0.5], [30, 40]], rect)).toEqual([[10, 20], [30, 40]]);
  });
});
