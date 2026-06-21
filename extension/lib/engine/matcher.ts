/**
 * Multi-strategy element matcher — the core of patch resilience.
 *
 * A patch stores several independent fingerprints of its target element. At apply
 * time we try them in priority order and accept the first that resolves to exactly
 * one element above a confidence threshold. If none do, the patch is "unresolved"
 * (surfaced in the panel) rather than applied to the wrong node. See §4 of the plan.
 */
import type { ElementTarget } from '@yandz/shared';

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
