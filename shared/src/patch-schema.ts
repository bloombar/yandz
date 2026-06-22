/**
 * Patch schema — the structured representation of a single page modification.
 *
 * A Version is an ordered list of Patches. Each Patch targets a DOM element via a
 * multi-strategy fingerprint (so it survives page changes / SPAs) and carries a
 * typed, sanitizable payload. There is deliberately NO generic "innerHTML" op:
 * every op is a constrained, whitelistable mutation. See §4 and §10 of the plan.
 */

export type PatchOp =
  | 'textReplace'
  | 'imageSwap'
  | 'cssOverride'
  | 'attrChange'
  | 'drawingOverlay'
  | 'annotation';

/** How a Version's patches are scoped to URLs. */
export type UrlMatchMode = 'exact' | 'path' | 'pattern';

/**
 * Per-patch personal application scope. `page` (default) is the normal behavior: the
 * patch applies only on the version's own page. `site` and `global` make the patch
 * ALSO auto-apply, for the creating user only, on every page of the same host or on
 * every site respectively. Other users see the chosen scope but it doesn't broaden
 * application for them.
 */
export type PatchScope = 'page' | 'site' | 'global';

export interface UrlMatch {
  mode: UrlMatchMode;
  /** For 'exact'/'path': the urlKey; for 'pattern': a glob-ish pattern. */
  value: string;
}

/**
 * Multi-strategy element fingerprint. The patch engine tries these in priority
 * order (cssSelector → xpath → attrFingerprint → textFingerprint → domPath) and
 * marks a patch "unresolved" rather than mis-applying below a confidence threshold.
 */
export interface ElementTarget {
  /** @medv/finder selector, with dynamic/hashed classes stripped. */
  cssSelector?: string;
  /** Structural fallback. */
  xpath?: string;
  /** Normalized innerText of the target (+ a little ancestor context). */
  textFingerprint?: string;
  /** Stable attributes: id, role, aria-label, name, alt, data-*, href host. */
  attrFingerprint?: Record<string, string>;
  /** tagName chain + sibling indices — last resort. */
  domPath?: string;
  /** Position relative to viewport/anchor, in percentages — for drawings/notes. */
  boundingHintPct?: { xPct: number; yPct: number; wPct: number; hPct: number };
}

export interface DrawingStroke {
  /** perfect-freehand input points: [xPct, yPct, pressure?]. Percentages of anchor box. */
  points: Array<[number, number, number?]>;
  color: string;
  /** Stroke size as a fraction of anchor width (responsive). */
  sizePct: number;
}

export type AnnotationKind = 'highlight' | 'note';

export interface PatchPayloadMap {
  textReplace: { from: string; to: string };
  imageSwap: { originalSrcHash: string; newAssetUrl: string };
  cssOverride: { declarations: Record<string, string> };
  /** `from` is the original attribute value (for display/diff), if any. */
  attrChange: { attr: string; value: string; from?: string };
  drawingOverlay: { strokes: DrawingStroke[] };
  annotation: { kind: AnnotationKind; color: string; body?: string };
}

export interface Patch<Op extends PatchOp = PatchOp> {
  op: Op;
  target: ElementTarget;
  payload: PatchPayloadMap[Op];
  /** Order within the Version's patch list. */
  order: number;
  /** Personal application scope (defaults to 'page' when absent). See PatchScope. */
  scope?: PatchScope;
}

export type AnyPatch = { [K in PatchOp]: Patch<K> }[PatchOp];

// ---------------------------------------------------------------------------
// Sanitization whitelists (enforced on save server-side AND before apply client-side)
// ---------------------------------------------------------------------------

/** Attributes a user is allowed to set via attrChange. Everything else is rejected. */
export const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'alt',
  'title',
  'aria-label',
  'aria-hidden',
  'role',
  'class',
  'href',
  'src',
  'width',
  'height',
  'colspan',
  'rowspan',
  'lang',
  'dir',
]);

/** Attribute names that are NEVER allowed (event handlers, dangerous overrides). */
export function isForbiddenAttr(attr: string): boolean {
  const a = attr.toLowerCase();
  return a.startsWith('on') || a === 'srcdoc' || a === 'style';
}

/** URL-bearing attributes whose values must be safe URLs. */
export const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src']);

const DANGEROUS_URL_SCHEME = /^\s*(javascript|data|vbscript|file)\s*:/i;

export function isSafeUrl(value: string): boolean {
  return !DANGEROUS_URL_SCHEME.test(value);
}

/** CSS tokens that can execute / exfiltrate and must be stripped from declarations. */
const DANGEROUS_CSS = /(expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:|@import)/i;

export function isSafeCssValue(value: string): boolean {
  return !DANGEROUS_CSS.test(value);
}

export interface ValidationResult {
  ok: boolean;
  /** Reason when ok === false. */
  reason?: string;
}

/**
 * Validate a single patch against the whitelists. Pure & dependency-free so it
 * runs identically on client and server. (HTML sanitization via DOMPurify happens
 * separately on text/markup-bearing fields.)
 */
export function validatePatch(patch: AnyPatch): ValidationResult {
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'missing patch' };
  if (!patch.target || typeof patch.target !== 'object') {
    return { ok: false, reason: 'missing target' };
  }

  switch (patch.op) {
    case 'attrChange': {
      const { attr, value } = patch.payload;
      if (isForbiddenAttr(attr)) return { ok: false, reason: `forbidden attribute: ${attr}` };
      if (!ALLOWED_ATTRS.has(attr.toLowerCase())) {
        return { ok: false, reason: `attribute not allowed: ${attr}` };
      }
      if (URL_ATTRS.has(attr.toLowerCase()) && !isSafeUrl(value)) {
        return { ok: false, reason: 'unsafe url value' };
      }
      return { ok: true };
    }
    case 'cssOverride': {
      for (const [prop, val] of Object.entries(patch.payload.declarations)) {
        if (!isSafeCssValue(prop) || !isSafeCssValue(val)) {
          return { ok: false, reason: `unsafe css: ${prop}` };
        }
      }
      return { ok: true };
    }
    case 'imageSwap': {
      if (!isSafeUrl(patch.payload.newAssetUrl)) {
        return { ok: false, reason: 'unsafe image url' };
      }
      return { ok: true };
    }
    case 'textReplace':
    case 'drawingOverlay':
    case 'annotation':
      return { ok: true };
    default:
      return { ok: false, reason: `unknown op: ${(patch as AnyPatch).op}` };
  }
}

/** Validate an ordered list of patches; returns the first failure. */
export function validatePatchList(patches: AnyPatch[]): ValidationResult {
  for (const p of patches) {
    const r = validatePatch(p);
    if (!r.ok) return r;
  }
  return { ok: true };
}
