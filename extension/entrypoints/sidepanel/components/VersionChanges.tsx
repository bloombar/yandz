/**
 * Read-only view of a version's changes (for versions the viewer doesn't own).
 * Mirrors the editor's "Changes" panel layout — header with the version title,
 * author, and any "based on" attribution, then the list of changes — but without
 * any editing affordances. Clicking a change highlights its element on the page.
 */
import React from 'react';
import { GitFork } from 'lucide-react';
import type { FeedItem } from '../../../lib/api.js';
import { describePatch } from '../../../lib/describe-patch.js';
import { PanelHeader } from './PanelHeader.js';

interface Props {
  version: FeedItem;
  messageTab: (payload: unknown) => Promise<boolean> | void;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
}

export function VersionChanges({ version: v, messageTab, onClose, onOpenProfile }: Props): React.JSX.Element {
  return (
    <div className="list">
      <PanelHeader title={`“${v.name}”`} onClose={onClose} />

      <div className="panel-body">
        {/* Author + fork attribution. */}
        <div className="muted" style={{ marginBottom: 8 }}>
          by{' '}
          <span className="handle" onClick={() => onOpenProfile(v.author.id)}>
            u/{v.author.handle}
          </span>
          {v.parentAuthor && (
            <>
              {' '}
              · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> based on{' '}
              <span className="handle" onClick={() => onOpenProfile(v.parentAuthor!.id)}>
                u/{v.parentAuthor.handle}
              </span>
              ’s version
            </>
          )}
        </div>

        <h3 className="muted">Changes ({v.patches.length})</h3>
        {/* Newest first, matching the editor. */}
        {v.patches
          .map((p, i) => ({ p, i }))
          .reverse()
          .map(({ p, i }) => (
            <div className="change-row" key={i}>
              <span
                className="change-desc"
                role="button"
                title="Highlight on the page"
                onClick={() => void messageTab({ type: 'yandz:highlight-element', target: p.target })}
              >
                {describePatch(p)}
              </span>
            </div>
          ))}
        {v.patches.length === 0 && <p className="muted">No changes.</p>}
      </div>
    </div>
  );
}
