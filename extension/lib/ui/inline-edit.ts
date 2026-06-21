/**
 * In-place text editing. Makes a picked element directly editable on the page
 * (contentEditable), selects its text, and captures the result as a {from, to}
 * pair on commit.
 *
 * While editing, ALL navigation is locked: link clicks, click-driven JavaScript
 * navigation, and form submissions are swallowed in the capture phase so the page
 * can't navigate away mid-edit. The edit ends only via:
 *   - Enter            → commit
 *   - Escape           → cancel (restore original text)
 *   - click on an element that is NOT a container (ancestor) of the edited element
 *                      → commit
 * Clicks inside the edited element (caret placement) and on its ancestors keep the
 * edit active.
 *
 * While an inline edit is active, isInlineEditing() returns true so the content
 * script's MutationObserver doesn't re-apply patches over the user's typing.
 */

let editing = false;

/** True while an in-place edit is in progress (used to pause patch re-application). */
export function isInlineEditing(): boolean {
  return editing;
}

export interface InlineEditHandlers {
  /** Called on commit with the original and new text (only if it changed). */
  onCommit: (result: { from: string; to: string }) => void;
  /** Called when the edit ends (commit OR cancel), e.g. to resume observers. */
  onEnd?: () => void;
}

/** Begin editing an element's text in place. */
export function startInlineEdit(el: Element, handlers: InlineEditHandlers): void {
  const node = el as HTMLElement;
  const from = node.textContent ?? '';
  const prevEditable = node.getAttribute('contenteditable');
  const prevOutline = node.style.outline;

  editing = true;
  node.setAttribute('contenteditable', 'true');
  node.style.outline = '2px solid #4c9ffe';
  node.focus();

  // Select the element's full text so typing replaces it immediately.
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  let done = false;
  function finish(commit: boolean): void {
    if (done) return;
    done = true;
    editing = false;
    node.style.outline = prevOutline;
    if (prevEditable === null) node.removeAttribute('contenteditable');
    else node.setAttribute('contenteditable', prevEditable);

    node.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('beforeunload', onBeforeUnload);

    const to = node.textContent ?? '';
    if (!commit) node.textContent = from; // revert on cancel
    else if (to !== from) handlers.onCommit({ from, to });
    handlers.onEnd?.();
  }

  // Enter commits (Shift+Enter inserts a newline); Escape cancels.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }

  // Keep focus in the editor when the user presses on something outside it (so an
  // outside click doesn't steal focus before we decide what to do with it).
  function onMouseDown(e: MouseEvent): void {
    if (!node.contains(e.target as Node)) e.preventDefault();
  }

  // Lock navigation: swallow every click during the edit. Clicks inside the edited
  // element or on its ancestors keep editing; any other click commits.
  function onClick(e: MouseEvent): void {
    const target = e.target as Node;
    e.preventDefault();
    e.stopPropagation();
    if (node.contains(target)) return; // inside the edited element → caret, keep editing
    // An ancestor/container of the edited element → keep editing.
    if (target instanceof Node && target.contains(node)) return;
    finish(true); // a non-container element → commit
  }

  // Block link/JS navigation triggered other than by a plain click.
  function onSubmit(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
  }
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    e.preventDefault();
    e.returnValue = '';
  }

  node.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  window.addEventListener('beforeunload', onBeforeUnload);
}
