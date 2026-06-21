/**
 * Element picker — a devtools-style "inspect element" tool. While active, hovering
 * highlights the element under the cursor with an overlay box; clicking selects it
 * (and invokes the callback); Escape cancels. The overlay lives in its own fixed
 * layer and never intercepts the final click target's identity.
 */

export type PickCallback = (element: Element) => void;

const OVERLAY_ID = 'yandz-picker-overlay';

/** Begin picking. Returns a cancel function; auto-cancels after a pick. */
export function startPicker(onPick: PickCallback): () => void {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4c9ffe;' +
    'background:rgba(76,159,254,.15);border-radius:2px;transition:all .03s;';
  document.documentElement.appendChild(overlay);

  let hovered: Element | null = null;

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
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== overlay && el !== hovered) {
      hovered = el;
      highlight(el);
    }
  }

  function onClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    cleanup();
    if (el) onPick(el);
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
