/**
 * Element picker — a devtools-style "inspect element" tool. While active, hovering
 * highlights the element under the cursor with an overlay box; clicking selects it
 * (and invokes the callback); Escape cancels. The overlay lives in its own fixed
 * layer and never intercepts the final click target's identity.
 *
 * Editable-target resolution: when the element directly under the cursor has no
 * editable content of its own (no own text, no text-related attribute) — e.g. a
 * wrapper div, or the padding area of a container — the picker drills into its
 * descendants and resolves to the first one that DOES have editable text or a
 * text-related attribute. This makes hovering a container select the meaningful
 * text element inside it rather than an uneditable wrapper.
 */

export type PickCallback = (element: Element) => void;

const OVERLAY_ID = 'yandz-picker-overlay';

/** Text-bearing attributes a user can edit (alt text, tooltips, labels, inputs). */
const TEXT_ATTRS = ['alt', 'title', 'aria-label', 'placeholder', 'value'];

/** True if the element has a direct (non-whitespace) text node of its own. */
export function hasOwnText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

/** True if the element carries a non-empty text-related attribute (or input value). */
function hasTextAttr(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.value.trim() !== '') return true;
  return TEXT_ATTRS.some((a) => (el.getAttribute(a) ?? '').trim() !== '');
}

/** An element is directly editable if it has own text or a text-related attribute. */
function isEditableTarget(el: Element): boolean {
  return hasOwnText(el) || hasTextAttr(el);
}

/** Our own injected UI (floating icon, overlays) — never a valid pick target. */
const OWN_UI_IDS = new Set([
  'yandz-floating-host',
  'yandz-overlay-layer',
  'yandz-picker-overlay',
  'yandz-draw-capture',
]);
function isOwnUi(el: Element | null): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.id && OWN_UI_IDS.has(n.id)) return true;
  }
  return false;
}

/**
 * Resolve the element under the cursor to the best editable target: itself if it
 * has editable content, otherwise the first descendant (document order) that does.
 * Falls back to the original element when no editable descendant exists (so CSS /
 * structural edits on textless elements are still possible).
 */
function resolveEditableTarget(el: Element): Element {
  if (isEditableTarget(el)) return el;
  for (const descendant of Array.from(el.querySelectorAll('*'))) {
    if (isEditableTarget(descendant)) return descendant;
  }
  return el;
}

/** Begin picking. Returns a cancel function; auto-cancels after a pick. */
export function startPicker(onPick: PickCallback): () => void {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4c9ffe;' +
    'background:rgba(76,159,254,.15);border-radius:2px;transition:all .03s;';
  document.documentElement.appendChild(overlay);

  // The raw element last seen under the cursor (to avoid recomputing every move).
  let lastRaw: Element | null = null;

  /** Position the highlight box over an element's bounding rect. */
  function highlight(el: Element): void {
    const r = el.getBoundingClientRect();
    overlay.style.top = `${r.top}px`;
    overlay.style.left = `${r.left}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  }

  function onMove(e: MouseEvent): void {
    // elementFromPoint ignores our pointer-events:none overlay.
    const raw = document.elementFromPoint(e.clientX, e.clientY);
    // Never highlight our own UI (the floating icon / overlays).
    if (!raw || raw === overlay || isOwnUi(raw)) {
      overlay.style.width = '0px';
      overlay.style.height = '0px';
      lastRaw = null;
      return;
    }
    if (raw === lastRaw) return;
    lastRaw = raw;
    // Highlight the resolved editable target, not necessarily the raw element.
    highlight(resolveEditableTarget(raw));
  }

  function onClick(e: MouseEvent): void {
    const raw = document.elementFromPoint(e.clientX, e.clientY);
    // Ignore clicks on our own UI — don't pick it, keep the picker active.
    if (isOwnUi(raw)) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    if (raw) onPick(resolveEditableTarget(raw));
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') cleanup();
  }

  function cleanup(): void {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }

  // Capture phase so we intercept before the page's own handlers.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  return cleanup;
}
