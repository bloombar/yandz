/**
 * In-place text editing. Makes a picked element directly editable on the page
 * (contentEditable), selects its text, and captures the result as a {from, to}
 * pair on commit. Enter (or blur) commits; Escape cancels and restores the
 * original text. This is the WYSIWYG alternative to editing text in the sidebar.
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
    node.removeEventListener('blur', onBlur, true);

    const to = node.textContent ?? '';
    if (!commit) node.textContent = from; // revert on cancel
    else if (to !== from) handlers.onCommit({ from, to });
    handlers.onEnd?.();
  }

  // Enter commits (Shift+Enter inserts a newline); Escape cancels.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  }
  function onBlur(): void {
    finish(true);
  }

  node.addEventListener('keydown', onKey, true);
  node.addEventListener('blur', onBlur, true);
}
