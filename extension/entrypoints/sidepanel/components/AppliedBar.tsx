/**
 * The "applied to this page" bar, shown above the scope tabs. Lists the versions
 * currently applied to the open page — across all three scopes (page / site / global)
 * layered together — each with a toggle to switch it off and a click target to view
 * its details. Turning off a page version is transient (this view); turning off a site
 * or global version deactivates the opt-in so it stops auto-applying.
 */
import React from 'react';
import { ToggleRight } from 'lucide-react';
import type { FeedScope } from '../../../lib/api.js';

/** One currently-applied version, as reported by the content script (per scope). */
export interface AppliedEntry {
  scope: FeedScope;
  versionId: string;
  name: string;
}

const SCOPE_LABEL: Record<FeedScope, string> = { page: 'Page', site: 'Site', global: 'Global' };
// Stable display order: page (top layer) first, then site, then global.
const ORDER: Record<FeedScope, number> = { page: 0, site: 1, global: 2 };

interface Props {
  applied: AppliedEntry[];
  onToggleOff: (e: AppliedEntry) => void;
  onDetails: (e: AppliedEntry) => void;
}

export function AppliedBar({ applied, onToggleOff, onDetails }: Props): React.JSX.Element | null {
  if (applied.length === 0) return null;
  const rows = [...applied].sort((a, b) => ORDER[a.scope] - ORDER[b.scope]);
  return (
    <div className="applied-bar">
      <span className="applied-bar-label muted">Applied here</span>
      {rows.map((e) => (
        <div className="applied-row" key={e.versionId}>
          <span className={`scope-chip scope-${e.scope}`}>{SCOPE_LABEL[e.scope]}</span>
          <span className="applied-name" role="button" title="View details" onClick={() => onDetails(e)}>
            {e.name}
          </span>
          <button
            className="icon-btn applied-toggle"
            aria-label={`Turn off ${e.name}`}
            title={e.scope === 'page' ? 'Turn off here' : 'Deactivate (stop auto-applying)'}
            onClick={() => onToggleOff(e)}
          >
            <ToggleRight size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
