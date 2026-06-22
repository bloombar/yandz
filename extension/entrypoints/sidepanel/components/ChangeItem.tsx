/**
 * One row in a "Changes" list (editable or read-only). Clicking the description
 * highlights the element on the page AND toggles an expanded detail view showing
 * the original → new content (or the settings that were changed). Clicking again
 * collapses it. An optional delete button is shown in the editable editor.
 */
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnyPatch } from '@yandz/shared';
import { describePatch } from '../../../lib/describe-patch.js';

/** Expanded before/after (or settings) detail for a change. */
function ChangeDetails({ patch }: { patch: AnyPatch }): React.JSX.Element {
  switch (patch.op) {
    case 'textReplace':
      return (
        <div className="change-details">
          <div>
            <span className="muted">Original:</span> {patch.payload.from || '(empty)'}
          </div>
          <div>
            <span className="muted">New:</span> {patch.payload.to || '(empty)'}
          </div>
        </div>
      );
    case 'imageSwap':
      return (
        <div className="change-details">
          <div className="muted">Original image</div>
          <div className="break">{patch.payload.originalSrcHash || '(none)'}</div>
          <div className="muted">New image</div>
          <div className="break">{patch.payload.newAssetUrl}</div>
        </div>
      );
    case 'attrChange':
      return (
        <div className="change-details">
          <div>
            <span className="muted">{patch.payload.attr}:</span> {patch.payload.from ?? '(unset)'} →{' '}
            {patch.payload.value || '(empty)'}
          </div>
        </div>
      );
    case 'cssOverride':
      return (
        <div className="change-details">
          {Object.entries(patch.payload.declarations).map(([k, val]) => (
            <div key={k}>
              {k}: {val}
            </div>
          ))}
        </div>
      );
    case 'drawingOverlay':
      return <div className="change-details muted">{patch.payload.strokes.length} freehand stroke(s)</div>;
    case 'annotation':
      return (
        <div className="change-details">
          <span className="muted">{patch.payload.kind}</span>
          {patch.payload.body ? ` — ${patch.payload.body}` : ''}
        </div>
      );
    default:
      return <></>;
  }
}

export function ChangeItem({
  patch,
  onHighlight,
  onDelete,
}: {
  patch: AnyPatch;
  onHighlight: () => void;
  onDelete?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="change-row">
        <span
          className="change-desc"
          role="button"
          aria-expanded={open}
          title="Highlight on the page (click to expand details)"
          onClick={() => {
            onHighlight();
            setOpen((o) => !o);
          }}
        >
          {describePatch(patch)}
        </span>
        {onDelete && (
          <button className="icon-btn" aria-label="Delete this change" title="Delete this change" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {open && <ChangeDetails patch={patch} />}
    </div>
  );
}
