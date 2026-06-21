/**
 * Client-side, git-style diff between two versions' patch sets. Patches are keyed
 * by a stable signature of their target so we can classify each as added, removed,
 * or changed, and (for text/css) produce an inline value diff via jsdiff.
 */
import { diffWords } from 'diff';
import type { AnyPatch } from '@yandz/shared';

/** Stable key identifying "the same target + op" across versions. */
export function patchKey(p: AnyPatch): string {
  const t = p.target;
  const locator = t.cssSelector ?? t.xpath ?? t.domPath ?? t.textFingerprint ?? 'unknown';
  return `${p.op}::${locator}`;
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface PatchDiffEntry {
  key: string;
  kind: ChangeKind;
  before?: AnyPatch;
  after?: AnyPatch;
  /** For text/css ops: inline word-diff segments of the payload value. */
  inline?: Array<{ value: string; added?: boolean; removed?: boolean }>;
}

/** Extract a comparable string from a patch payload for inline diffing. */
function payloadText(p: AnyPatch): string {
  if (p.op === 'textReplace') return p.payload.to;
  if (p.op === 'cssOverride') {
    return Object.entries(p.payload.declarations)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  }
  return JSON.stringify(p.payload);
}

/**
 * Diff two patch lists. Returns one entry per distinct patch key, classified and
 * (where meaningful) annotated with an inline word diff. Order is stable: entries
 * follow the union of keys in `after` then `before`.
 */
export function diffVersions(before: AnyPatch[], after: AnyPatch[]): PatchDiffEntry[] {
  const beforeMap = new Map(before.map((p) => [patchKey(p), p]));
  const afterMap = new Map(after.map((p) => [patchKey(p), p]));
  const keys = [...new Set([...afterMap.keys(), ...beforeMap.keys()])];

  return keys.map((key): PatchDiffEntry => {
    const b = beforeMap.get(key);
    const a = afterMap.get(key);
    if (a && !b) return { key, kind: 'added', after: a };
    if (!a && b) return { key, kind: 'removed', before: b };
    // Both present: changed iff the payload text differs.
    const bt = payloadText(b!);
    const at = payloadText(a!);
    if (bt === at) return { key, kind: 'unchanged', before: b, after: a };
    return { key, kind: 'changed', before: b, after: a, inline: diffWords(bt, at) };
  });
}
