/**
 * Pure helpers for the element style editor (the "Style" tool's friendly controls and
 * the patch transforms behind them). Kept dependency-free so they're unit-testable
 * without React or the DOM.
 */
import type { AnyPatch, ElementTarget } from '@yandz/shared';

/** Stable signature for matching patches to a picked element (mirrors upsertDrawing). */
export function targetSig(t: ElementTarget): string {
  return t.cssSelector ?? t.domPath ?? '';
}

/**
 * Merge CSS declarations into the single `cssOverride` patch for a target (creating it
 * if absent). A declaration whose value is '' is removed; emptying the patch drops it.
 * Returns a new patch list (the original is untouched).
 */
export function mergeStyle(patches: AnyPatch[], target: ElementTarget, partial: Record<string, string>): AnyPatch[] {
  const sig = targetSig(target);
  const idx = patches.findIndex((p) => p.op === 'cssOverride' && targetSig(p.target) === sig);
  if (idx >= 0) {
    const cur = patches[idx] as Extract<AnyPatch, { op: 'cssOverride' }>;
    const declarations: Record<string, string> = { ...cur.payload.declarations };
    for (const [k, v] of Object.entries(partial)) {
      if (v === '') delete declarations[k];
      else declarations[k] = v;
    }
    const next = [...patches];
    if (Object.keys(declarations).length) next[idx] = { ...cur, payload: { declarations } };
    else next.splice(idx, 1);
    return next;
  }
  const declarations: Record<string, string> = {};
  for (const [k, v] of Object.entries(partial)) if (v !== '') declarations[k] = v;
  return Object.keys(declarations).length
    ? [...patches, { op: 'cssOverride', target, payload: { declarations }, order: patches.length } as AnyPatch]
    : patches;
}

/** Set an HTML attribute on a target — one `attrChange` patch per attr (replaces value). */
export function upsertAttr(
  patches: AnyPatch[],
  target: ElementTarget,
  attr: string,
  value: string,
  from?: string,
): AnyPatch[] {
  const sig = targetSig(target);
  const idx = patches.findIndex((p) => p.op === 'attrChange' && targetSig(p.target) === sig && p.payload.attr === attr);
  const patch = { op: 'attrChange', target, payload: { attr, value, from }, order: idx >= 0 ? patches[idx]!.order : patches.length } as AnyPatch;
  return idx >= 0 ? patches.map((p, i) => (i === idx ? patch : p)) : [...patches, patch];
}

/** Remove an attribute change for a target. */
export function removeAttr(patches: AnyPatch[], target: ElementTarget, attr: string): AnyPatch[] {
  return patches.filter((p) => !(p.op === 'attrChange' && targetSig(p.target) === targetSig(target) && p.payload.attr === attr));
}

/**
 * Set the text of a target via a single `textReplace` patch (one per element). `from` is
 * the element's ORIGINAL text; reverting `to` back to `from` drops the patch entirely.
 */
export function setTextPatch(patches: AnyPatch[], target: ElementTarget, from: string, to: string): AnyPatch[] {
  const sig = targetSig(target);
  const idx = patches.findIndex((p) => p.op === 'textReplace' && targetSig(p.target) === sig);
  if (to === from) return idx >= 0 ? patches.filter((_, i) => i !== idx) : patches;
  const patch = { op: 'textReplace', target, payload: { from, to }, order: idx >= 0 ? patches[idx]!.order : patches.length } as AnyPatch;
  return idx >= 0 ? patches.map((p, i) => (i === idx ? patch : p)) : [...patches, patch];
}

/** Step a CSS `font-size` (e.g. "16px") by `deltaPx`, clamped to a sensible minimum. */
export function stepFontSize(current: string, deltaPx: number, min = 8): string {
  const n = parseFloat(current);
  const base = Number.isFinite(n) ? n : 16;
  return `${Math.max(min, Math.round(base + deltaPx))}px`;
}

/**
 * Convert a CSS color to `#rrggbb` for an `<input type="color">`. Accepts hex (#rgb /
 * #rrggbb) and rgb()/rgba(); returns `fallback` when the color is transparent or can't
 * be parsed (so the picker still shows a sensible swatch).
 */
export function cssColorToHex(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return ('#' + v.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  }
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha === 0) return fallback; // fully transparent → no meaningful swatch
    const hex = [m[1], m[2], m[3]]
      .map((x) => Math.max(0, Math.min(255, parseInt(x, 10))).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return fallback;
}

/** Whether a CSS `font-weight` value counts as bold (keyword or numeric ≥ 700). */
export function isBoldWeight(value: string | undefined): boolean {
  if (!value) return false;
  if (value === 'bold' || value === 'bolder') return true;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 700;
}
