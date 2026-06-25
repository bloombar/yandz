/**
 * The "applied to this page" bar, shown above the scope tabs. Lists every version the
 * viewer has activated that is relevant to the open page — all active GLOBAL versions
 * (always), plus SITE versions on this host and PAGE versions on this page — layered
 * together. Each row has a toggle that pauses/resumes the version (keeping it in the
 * list) and a ✕ that removes the opt-in entirely. Clicking the name views its details.
 */
import React from 'react';
import { ToggleRight, ToggleLeft, X } from 'lucide-react';
import type { FeedScope } from '../../../lib/api.js';

/** One activated version relevant to the current page (per the content script). */
export interface AppliedEntry {
  scope: FeedScope;
  versionId: string;
  name: string;
  /** Enabled (applied) vs paused (kept in the list but not applied). */
  on: boolean;
}

const SCOPE_LABEL: Record<FeedScope, string> = { page: 'Page', site: 'Site', global: 'Global' };
// Stable display order: page (top layer) first, then site, then global.
const ORDER: Record<FeedScope, number> = { page: 0, site: 1, global: 2 };

interface Props {
  applied: AppliedEntry[];
  onToggle: (e: AppliedEntry) => void;
  onRemove: (e: AppliedEntry) => void;
  onDetails: (e: AppliedEntry) => void;
}

export function AppliedBar({ applied, onToggle, onRemove, onDetails }: Props): React.JSX.Element | null {
  if (applied.length === 0) return null;
  const rows = [...applied].sort((a, b) => ORDER[a.scope] - ORDER[b.scope]);
  return (
    <div className="applied-bar">
      <span className="applied-bar-label muted">Applied here</span>
      {rows.map((e) => (
        <div className={`applied-row ${e.on ? '' : 'off'}`} key={e.versionId}>
          <span className={`scope-chip scope-${e.scope}`}>{SCOPE_LABEL[e.scope]}</span>
          <span className="applied-name" role="button" title="View details" onClick={() => onDetails(e)}>
            {e.name}
          </span>
          <button
            className="icon-btn applied-toggle"
            aria-pressed={e.on}
            aria-label={e.on ? `Pause ${e.name}` : `Resume ${e.name}`}
            title={e.on ? 'Active — click to pause' : 'Paused — click to apply'}
            onClick={() => onToggle(e)}
          >
            {e.on ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
          </button>
          <button
            className="icon-btn applied-remove"
            aria-label={`Remove ${e.name}`}
            title="Remove from active versions"
            onClick={() => onRemove(e)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
