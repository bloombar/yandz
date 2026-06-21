/**
 * Build a multi-strategy ElementTarget from a live element (at edit time). We
 * capture several independent locators so the matcher can fall back gracefully
 * when the page changes. CSS selectors come from @medv/finder, configured to
 * avoid dynamic/hashed class names that break on SPAs.
 */
import { finder } from '@medv/finder';
import type { ElementTarget } from '@yandz/shared';

/** Heuristic: looks like a build-hashed/utility class we shouldn't anchor to. */
function isVolatileClass(name: string): boolean {
  // e.g. "css-1a2b3c", "sc-bdfBwQ", hashes, or very long random-looking tokens.
  return /^(css-|sc-|jsx-)/.test(name) || /\d{4,}/.test(name) || /^[a-z0-9]{8,}$/i.test(name);
}

/** Absolute-ish XPath using tag + nth-of-type, a structural fallback. */
export function buildXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const idx = sameTag.indexOf(node) + 1;
    parts.unshift(sameTag.length > 1 ? `${tag}[${idx}]` : tag);
    node = parent;
  }
  return '/' + parts.join('/');
}

/** Capture stable identifying attributes (ignoring volatile ones). */
function attrFingerprint(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = ['id', 'role', 'aria-label', 'name', 'alt', 'data-testid'];
  for (const k of keep) {
    const v = el.getAttribute(k);
    if (v) out[k] = v;
  }
  const href = el.getAttribute('href');
  if (href) {
    try {
      out['href-host'] = new URL(href, location.href).host;
    } catch {
      /* ignore malformed href */
    }
  }
  return out;
}

/** Tag + sibling-index path used as a last-resort CSS selector (domPath). */
function buildDomPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const idx = Array.from(parent.children).indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
    node = parent;
  }
  return parts.join(' > ');
}

/** Build the full multi-strategy target for an element. */
export function fingerprintElement(el: Element): ElementTarget {
  let cssSelector: string | undefined;
  try {
    cssSelector = finder(el, {
      className: (name) => !isVolatileClass(name),
      idName: (name) => !isVolatileClass(name),
    });
  } catch {
    cssSelector = undefined; // finder can throw on detached nodes
  }

  return {
    cssSelector,
    xpath: buildXPath(el),
    textFingerprint: (el.textContent ?? '').slice(0, 200),
    attrFingerprint: attrFingerprint(el),
    domPath: buildDomPath(el),
  };
}
