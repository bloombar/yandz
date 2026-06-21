/**
 * Server-side sanitization, mirrored on the client. Two layers:
 *  1. Structural validation against the op/attr whitelist (shared, pure).
 *  2. DOMPurify on any free-text field that could carry markup (text/annotation body).
 *
 * Defense-in-depth: this runs on save; the client re-sanitizes before apply.
 */
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { validatePatchList, type AnyPatch } from '@yandz/shared';

// DOMPurify needs a DOM; jsdom provides one server-side. The cast bridges jsdom's
// window type to the WindowLike shape DOMPurify expects.
const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

/** Strip all markup from a plain-text field (no tags allowed). */
export function sanitizeText(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

export interface SanitizeResult {
  ok: boolean;
  reason?: string;
  patches?: AnyPatch[];
}

/**
 * Validate + sanitize a list of patches for storage. Rejects the whole list on
 * the first whitelist violation; sanitizes text payloads in place.
 */
export function sanitizePatchList(patches: AnyPatch[]): SanitizeResult {
  const result = validatePatchList(patches);
  if (!result.ok) return { ok: false, reason: result.reason };

  const cleaned = patches.map((p): AnyPatch => {
    if (p.op === 'textReplace') {
      return { ...p, payload: { from: p.payload.from, to: sanitizeText(p.payload.to) } };
    }
    if (p.op === 'annotation' && p.payload.body !== undefined) {
      return { ...p, payload: { ...p.payload, body: sanitizeText(p.payload.body) } };
    }
    return p;
  });
  return { ok: true, patches: cleaned };
}
