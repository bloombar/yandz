/**
 * Multi-strategy element matcher — the core of patch resilience.
 *
 * A patch stores several independent fingerprints of its target element. At apply
 * time we try them in priority order and accept the first that resolves to exactly
 * one element above a confidence threshold. If none do, the patch is "unresolved"
 * (surfaced in the panel) rather than applied to the wrong node. See §4 of the plan.
 */
import type { AnyPatch, ElementTarget } from '@yandz/shared';
import { ownText, classSignature } from './fingerprint.js';

export interface MatchResult {
  element: Element | null;
  /** Which strategy resolved it, or 'none'. */
  strategy: 'cssSelector' | 'xpath' | 'attrFingerprint' | 'textFingerprint' | 'domPath' | 'none';
  /** 0..1 confidence; below ACCEPT_THRESHOLD the match is rejected. */
  confidence: number;
}

export const ACCEPT_THRESHOLD = 0.5;

/** Normalize text for fingerprint comparison: collapse whitespace, trim, lowercase. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Resolve a CSS selector; only a UNIQUE match counts (ambiguity → reject). */
function byCss(root: ParentNode, selector: string): Element | null {
  let nodes: NodeListOf<Element>;
  try {
    nodes = root.querySelectorAll(selector);
  } catch {
    return null; // invalid selector
  }
  return nodes.length === 1 ? nodes[0]! : null;
}

/** Resolve an XPath to a single element within a document. */
function byXPath(doc: Document, xpath: string): Element | null {
  try {
    const r = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = r.singleNodeValue;
    return node && node.nodeType === 1 ? (node as Element) : null;
  } catch {
    return null;
  }
}

/**
 * Find the element whose stable attributes best match the fingerprint. Returns
 * the unique best match and a score = matched-attrs / total-attrs.
 */
function byAttrs(root: ParentNode, attrs: Record<string, string>): { el: Element | null; score: number } {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return { el: null, score: 0 };
  const candidates = Array.from(root.querySelectorAll('*'));
  let best: Element | null = null;
  let bestScore = 0;
  let bestCount = 0;
  for (const el of candidates) {
    let matched = 0;
    for (const k of keys) if (el.getAttribute(k) === attrs[k]) matched++;
    const score = matched / keys.length;
    if (score > bestScore) {
      bestScore = score;
      best = el;
      bestCount = 1;
    } else if (score === bestScore && score > 0) {
      bestCount++;
    }
  }
  // Ambiguous ties don't count as a confident match.
  return bestCount === 1 ? { el: best, score: bestScore } : { el: null, score: 0 };
}

/** Find a unique element whose normalized text equals the fingerprint. */
function byText(root: ParentNode, fingerprint: string): Element | null {
  const target = normalizeText(fingerprint);
  if (!target) return null;
  const matches = Array.from(root.querySelectorAll('*')).filter(
    (el) => normalizeText(el.textContent ?? '') === target,
  );
  // Prefer the deepest (most specific) unique match.
  if (matches.length === 0) return null;
  const leaves = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
  return leaves.length === 1 ? leaves[0]! : null;
}

/**
 * Resolve a target to a concrete element using the strategy cascade. `root` is
 * normally `document`. Confidence is 1 for exact-structural hits (css/xpath/text)
 * and the attr match ratio for attribute-based hits.
 */
/**
 * Strip positional pseudo-classes so a uniquely-matching finder selector becomes a
 * FAMILY selector: `.card:nth-child(2) > h2` → `.card > h2` (every card title).
 */
export function generalizeSelector(sel: string): string {
  return sel
    .replace(
      /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)(?:\([^)]*\))?/g,
      '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A bare single-tag selector (no class/id/attr/combinator) is too broad to be a
 *  "template family" — it would match every <div>/<span> on the page. */
function tooGeneric(sel: string): boolean {
  return !/[.#[>~+ ]/.test(sel);
}

/** Whether a candidate element passes the patch's content gate (so siblings with
 *  different original content aren't modified). See the plan's gate table. */
function passesGate(patch: AnyPatch, el: Element): boolean {
  const mode = patch.template!;
  const t = patch.target;
  const wantText = mode === 'text' || mode === 'both' || (mode === 'auto' && patch.op === 'textReplace');
  const wantStyles = mode === 'styles' || mode === 'both' || (mode === 'auto' && patch.op === 'cssOverride');
  if (wantText && t.ownText !== undefined && normalizeText(ownText(el)) !== normalizeText(t.ownText)) return false;
  if (wantStyles && t.classSig !== undefined && classSignature(el) !== t.classSig) return false;
  if (mode === 'auto') {
    if (patch.op === 'attrChange') {
      const { attr, from } = patch.payload;
      if (from !== undefined && el.getAttribute(attr) !== from) return false;
    }
    if (patch.op === 'imageSwap') {
      const orig = patch.payload.originalSrcHash;
      if (orig && el.getAttribute('src') !== orig) return false;
    }
  }
  return true;
}

/**
 * Resolve all "same template" instances a `template` patch should apply to: the
 * structural family (generalized selector) filtered by the content gate. Falls back to
 * the single matched element when there's no usable family selector.
 */
export function matchTemplate(patch: AnyPatch, doc: Document = document): Element[] {
  const single = (): Element[] => {
    const el = matchTarget(patch.target, doc).element;
    return el ? [el] : [];
  };
  const sel = patch.target.cssSelector;
  if (!sel) return single();
  const general = generalizeSelector(sel);
  if (!general || tooGeneric(general)) return single();
  let family: Element[];
  try {
    family = Array.from(doc.querySelectorAll(general));
  } catch {
    return single();
  }
  if (family.length === 0) return single();
  // Gate the family; an empty result means nothing currently matches the original
  // content (e.g. already applied) → no-op, which is correct.
  const gated = family.filter((el) => passesGate(patch, el));
  // Safety net: the family is found ONLY via the generalized css selector, so if that
  // selector drifted off the original element, the primary target can be missing from the
  // family even though it resolves fine via the fuller strategy cascade. Resolve it that
  // way and include it when it passes the gate — so "apply to all" is never LESS accurate
  // than a single apply.
  const primary = matchTarget(patch.target, doc).element;
  if (primary && passesGate(patch, primary) && !gated.includes(primary)) gated.unshift(primary);
  return gated;
}

export function matchTarget(target: ElementTarget, doc: Document = document): MatchResult {
  if (target.cssSelector) {
    const el = byCss(doc, target.cssSelector);
    if (el) return { element: el, strategy: 'cssSelector', confidence: 1 };
  }
  if (target.xpath) {
    const el = byXPath(doc, target.xpath);
    if (el) return { element: el, strategy: 'xpath', confidence: 0.9 };
  }
  if (target.attrFingerprint) {
    const { el, score } = byAttrs(doc, target.attrFingerprint);
    if (el && score >= ACCEPT_THRESHOLD) return { element: el, strategy: 'attrFingerprint', confidence: score };
  }
  if (target.textFingerprint) {
    const el = byText(doc, target.textFingerprint);
    if (el) return { element: el, strategy: 'textFingerprint', confidence: 0.7 };
  }
  if (target.domPath) {
    const el = byCss(doc, target.domPath);
    if (el) return { element: el, strategy: 'domPath', confidence: 0.55 };
  }
  return { element: null, strategy: 'none', confidence: 0 };
}
