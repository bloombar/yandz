/**
 * Tiny pure helpers for drag-and-drop list reordering (by value/id), kept dependency-free
 * so they're trivially unit-testable and reusable across components.
 */

/**
 * Move `srcId` to the position immediately before `targetId` in `list`. Returns a NEW array
 * (or the original, unchanged, when it's a no-op: src === target, or either id is absent).
 */
export function moveBefore<T>(list: T[], srcId: T, targetId: T): T[] {
  if (srcId === targetId || !list.includes(srcId) || !list.includes(targetId)) return list;
  const without = list.filter((x) => x !== srcId);
  const idx = without.indexOf(targetId);
  return [...without.slice(0, idx), srcId, ...without.slice(idx)];
}
