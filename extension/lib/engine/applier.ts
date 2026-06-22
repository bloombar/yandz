/**
 * Apply a patch list to the live DOM and support full revert. Each applied patch
 * records an undo closure so switching versions / reverting to original is exact.
 *
 * Client-side re-validation/sanitization is a defense-in-depth layer: even though
 * the server validated on save, we never trust transit. textReplace/annotation
 * text is sanitized again via DOMPurify before insertion.
 */
import DOMPurify from 'dompurify';
import { validatePatch, type AnyPatch, type Patch } from '@yandz/shared';
import { matchTarget, type MatchResult } from './matcher.js';

export interface ApplyOutcome {
  applied: number;
  unresolved: AnyPatch[];
}

interface AppliedRecord {
  undo: () => void;
}

/** Sanitize a plain-text replacement (no markup permitted). */
function cleanText(s: string): string {
  return DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Engine instance for one page. Holds applied-patch undo records so a version can
 * be cleanly removed before another is applied (version switching) or reverted.
 */
export class PatchEngine {
  private applied: AppliedRecord[] = [];
  private styleEl: HTMLStyleElement | null = null;

  /** Apply a full patch list; returns counts + any unresolved patches. */
  apply(patches: AnyPatch[], doc: Document = document): ApplyOutcome {
    const unresolved: AnyPatch[] = [];
    let applied = 0;
    for (const patch of [...patches].sort((a, b) => a.order - b.order)) {
      // Re-validate against the whitelist before touching the DOM.
      if (!validatePatch(patch).ok) {
        unresolved.push(patch);
        continue;
      }
      const match = matchTarget(patch.target, doc);
      const ok = this.applyOne(patch, match, doc);
      if (ok) applied++;
      else unresolved.push(patch);
    }
    return { applied, unresolved };
  }

  /** Revert every applied patch in reverse order and reset state. */
  revertAll(): void {
    for (let i = this.applied.length - 1; i >= 0; i--) this.applied[i]!.undo();
    this.applied = [];
    this.styleEl?.remove();
    this.styleEl = null;
  }

  /** Apply a single patch; returns false if it couldn't be resolved/applied. */
  private applyOne(patch: AnyPatch, match: MatchResult, doc: Document): boolean {
    // cssOverride is the one op that doesn't strictly need a resolved element if a
    // selector is present — it's injected as a scoped stylesheet.
    if (patch.op === 'cssOverride') return this.applyCss(patch as Patch<'cssOverride'>, doc);

    if (!match.element) return false;
    const el = match.element;

    switch (patch.op) {
      case 'textReplace': {
        const prev = el.textContent ?? '';
        // Only replace when the original still matches, to avoid clobbering.
        if (patch.payload.from && !(el.textContent ?? '').includes(patch.payload.from)) return false;
        el.textContent = cleanText(patch.payload.to);
        this.applied.push({ undo: () => (el.textContent = prev) });
        return true;
      }
      case 'imageSwap': {
        if (!(el instanceof HTMLImageElement)) return false;
        const prevSrc = el.getAttribute('src');
        const prevSrcset = el.getAttribute('srcset');
        // `srcset` (and <picture> <source> srcset) takes precedence over `src`, so we
        // must clear it for the swap to actually take effect on responsive images.
        el.removeAttribute('srcset');
        const sources = el.closest('picture')
          ? Array.from(el.closest('picture')!.querySelectorAll('source'))
          : [];
        const prevSources = sources.map((s) => ({ s, srcset: s.getAttribute('srcset') }));
        sources.forEach((s) => s.removeAttribute('srcset'));
        el.src = patch.payload.newAssetUrl;
        this.applied.push({
          undo: () => {
            if (prevSrc === null) el.removeAttribute('src');
            else el.setAttribute('src', prevSrc);
            if (prevSrcset !== null) el.setAttribute('srcset', prevSrcset);
            prevSources.forEach(({ s, srcset }) => srcset !== null && s.setAttribute('srcset', srcset));
          },
        });
        return true;
      }
      case 'attrChange': {
        const { attr, value } = patch.payload;
        const prev = el.getAttribute(attr);
        el.setAttribute(attr, value);
        this.applied.push({
          undo: () => (prev === null ? el.removeAttribute(attr) : el.setAttribute(attr, prev)),
        });
        return true;
      }
      case 'drawingOverlay':
      case 'annotation':
        // Visual overlays are rendered by the overlay layer, not by mutating host
        // DOM; they resolve their anchor element via the same matcher. Treated as
        // applied here so they count toward the outcome.
        return true;
      default:
        return false;
    }
  }

  /** Inject cssOverride declarations as a single scoped <style> element. */
  private applyCss(patch: Patch<'cssOverride'>, doc: Document): boolean {
    const selector = patch.target.cssSelector ?? patch.target.domPath;
    if (!selector) return false;
    if (!this.styleEl) {
      this.styleEl = doc.createElement('style');
      this.styleEl.dataset.yandz = 'overrides';
      doc.head.appendChild(this.styleEl);
    }
    const body = Object.entries(patch.payload.declarations)
      .map(([k, v]) => `${k}: ${v};`)
      .join(' ');
    this.styleEl.appendChild(doc.createTextNode(`${selector} { ${body} }\n`));
    return true;
  }
}
