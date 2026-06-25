/**
 * Layer merging for the content script. A page can show up to three versions at once,
 * one per scope, layered bottom→top: global (bottom) under site under page (top).
 *
 * The patch engine applies patches in `order`, NOT array order, so simply concatenating
 * the layers isn't enough to make page override site override global on a shared element.
 * `mergeScopedPatches` flattens the active layers in bottom→top order and REWRITES each
 * patch's `order` to one monotonic sequence, so the engine's order-sort preserves the
 * intended precedence (later layers win — page beats site beats global).
 */
import type { AnyPatch } from '@yandz/shared';

/** A layer's patch list, given in apply order (bottom layer first, top layer last). */
export interface ScopedLayer {
  patches: AnyPatch[];
}

/**
 * Flatten layers bottom→top into a single patch list with a rewritten monotonic `order`.
 * Pass layers in precedence order (global, site, page) so the last layer wins.
 */
export function mergeScopedPatches(layers: ScopedLayer[]): AnyPatch[] {
  const out: AnyPatch[] = [];
  let order = 0;
  for (const layer of layers) {
    for (const p of layer.patches) out.push({ ...p, order: order++ } as AnyPatch);
  }
  return out;
}
