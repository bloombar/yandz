/**
 * Pure geometry shared by the live drawing capture and the saved-overlay renderer.
 *
 * A drawing stroke's points are stored as PERCENTAGES of its anchor element's bounding
 * box, so the drawing can be re-positioned relative to that element as the page scrolls
 * or reflows. These helpers convert those percentages back to pixels.
 */

/** The bits of a DOMRect we need (so it's testable without the DOM). */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A stored stroke point: [xPercent, yPercent, pressure?]. */
export type PctPoint = [number, number, number?];

/** Map a percentage point to absolute (viewport) client coordinates for an anchor rect. */
export function pctToClient(point: PctPoint, rect: AnchorRect): [number, number] {
  const [xp, yp] = point;
  return [rect.left + (xp / 100) * rect.width, rect.top + (yp / 100) * rect.height];
}

/** Map a whole stroke's points to client coordinates. */
export function strokeToClient(points: PctPoint[], rect: AnchorRect): Array<[number, number]> {
  return points.map((p) => pctToClient(p, rect));
}
