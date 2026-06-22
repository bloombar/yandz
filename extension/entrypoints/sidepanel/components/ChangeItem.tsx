/**
 * One row in a "Changes" list (editable or read-only). Clicking the description
 * highlights the element on the page AND toggles an expanded detail view showing
 * the original → new content (or the settings that were changed). Clicking again
 * collapses it. An optional delete button is shown in the editable editor.
 */
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnyPatch, PatchScope } from '@yandz/shared';
import { describePatch } from '../../../lib/describe-patch.js';

/** Scope options for the per-change dropdown, in menu order. */
const SCOPE_OPTIONS: { value: PatchScope; label: string }[] = [
  { value: 'page', label: 'This page' },
  { value: 'site', label: 'All pages on this site' },
  { value: 'global', label: 'All web sites' },
];

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
  onScopeChange,
}: {
  patch: AnyPatch;
  onHighlight: () => void;
  onDelete?: () => void;
  /** Owner-only: change where this patch applies. Omit ⇒ the dropdown is shown disabled. */
  onScopeChange?: (scope: PatchScope) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const scope = patch.scope ?? 'page';
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
        {/* Where this change applies. Disabled for non-owners (read-only viewers). */}
        <select
          className="scope-select"
          aria-label="Where this change applies"
          title="Where this change applies"
          value={scope}
          disabled={!onScopeChange}
          onChange={(e) => onScopeChange?.(e.target.value as PatchScope)}
        >
          {SCOPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
