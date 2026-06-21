/**
 * Reusable header for closable panels (Settings, Profile, Comments, Editor). Shows a
 * title on the left and an X close icon at the top-right of the panel content. The
 * close action pops the view stack (returns to the previous view) — replacing the old
 * per-panel "Close"/"Back" buttons.
 */
import React from 'react';
import { X } from 'lucide-react';

interface Props {
  title: React.ReactNode;
  onClose: () => void;
  /** Optional extra controls rendered between the title and the close icon. */
  children?: React.ReactNode;
}

export function PanelHeader({ title, onClose, children }: Props): React.JSX.Element {
  return (
    <div className="panel-header">
      <strong style={{ flex: 1 }}>{title}</strong>
      {children}
      <button className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
