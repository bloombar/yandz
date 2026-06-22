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
  let blurTimer = 0;
  function finish(commit: boolean): void {
    if (done) return;
    done = true;
    editing = false;
    clearTimeout(blurTimer);
    node.style.outline = prevOutline;
    if (prevEditable === null) node.removeAttribute('contenteditable');
    else node.setAttribute('contenteditable', prevEditable);

    node.removeEventListener('keydown', onKey, true);
    node.removeEventListener('blur', onBlur);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('beforeunload', onBeforeUnload);

    const to = node.textContent ?? '';
    if (!commit) node.textContent = from; // revert on cancel
    else if (to !== from) handlers.onCommit({ from, to });
    handlers.onEnd?.();
  }

  // Enter completes the edit; Shift/Ctrl/Cmd+Enter inserts a line break instead.
  // Escape cancels.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // Insert a newline (captured in textContent) rather than completing.
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const nl = document.createTextNode('\n');
          range.insertNode(nl);
          range.setStartAfter(nl);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        finish(true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }

  // Retain focus only when pressing on an ANCESTOR (we want to stay in edit mode
  // there). For a non-parent element we let the press behave normally so the
  // following click cleanly commits the edit.
  function onMouseDown(e: MouseEvent): void {
    const t = e.target as Node;
    if (!node.contains(t) && t instanceof Node && t.contains(node)) e.preventDefault();
  }

  // Lock navigation: swallow every click during the edit. Clicks inside the edited
  // element or on its ancestors keep editing; clicking any other (non-parent)
  // element completes the edit.
  function onClick(e: MouseEvent): void {
    const target = e.target as Node;
    if (node.contains(target)) {
      // Inside the edited element → caret placement; block nested link nav.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (target instanceof Node && target.contains(node)) {
      // An ancestor/container → keep editing (block its nav).
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // A non-parent element → complete the edit (and block its navigation).
    e.preventDefault();
    e.stopPropagation();
    finish(true);
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

  // Focus left the edited element — the user clicked into the extension sidebar, the
  // browser chrome, another tab/app, or any element that takes focus. Commit so the
  // edit (and its highlight) doesn't linger. Deferred so that an in-page click on a
  // non-parent commits via onClick FIRST (which also blocks that element's
  // navigation); the `done` guard makes the later blur finish a harmless no-op. For a
  // pure focus loss (no page click follows) the deferred finish is what ends the edit.
  function onBlur(): void {
    clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => finish(true), 0);
  }

  node.addEventListener('keydown', onKey, true);
  node.addEventListener('blur', onBlur);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('beforeunload', onBeforeUnload);
}
