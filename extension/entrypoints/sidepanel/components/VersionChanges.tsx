/**
 * Read-only version panel (for versions the viewer doesn't own): a header with the
 * title, author, and any fork attribution, then two tabs — Comments and Changes (N).
 * Defaults to Comments. The Changes tab lists the changes (clicking one highlights
 * its element on the page); there are no editing affordances.
 */
import React, { useState } from 'react';
import { GitFork } from 'lucide-react';
import type { FeedItem } from '../../../lib/api.js';
import { PanelHeader } from './PanelHeader.js';
import { PanelTabs, type VersionTab } from './PanelTabs.js';
import { CommentBoard } from './CommentBoard.js';
import { ChangeItem } from './ChangeItem.js';

interface Props {
  version: FeedItem;
  initialTab?: VersionTab;
  messageTab: (payload: unknown) => Promise<boolean> | void;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
}

export function VersionChanges({
  version: v,
  initialTab = 'comments',
  messageTab,
  onClose,
  onOpenProfile,
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<VersionTab>(initialTab);

  return (
    <div className="list">
      <PanelHeader title={`“${v.name}”`} onClose={onClose} />

      {/* Author + fork attribution. */}
      <div className="muted" style={{ padding: '0 12px 6px' }}>
        by{' '}
        <span className="handle" onClick={() => onOpenProfile(v.author.id)}>
          u/{v.author.handle}
        </span>
        {v.parentAuthor && (
          <>
            {' '}
            · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> based on “{v.parentName ?? 'a version'}” by{' '}
            <span className="handle" onClick={() => onOpenProfile(v.parentAuthor!.id)}>
              u/{v.parentAuthor.handle}
            </span>
          </>
        )}
      </div>

      <PanelTabs tab={tab} setTab={setTab} changeCount={v.patches.length} />

      <div className="panel-body">
        {tab === 'comments' ? (
          <CommentBoard versionId={v.id} onOpenProfile={onOpenProfile} />
        ) : (
          <>
            {v.patches
              .map((p, i) => ({ p, i }))
              .reverse()
              .map(({ p, i }) => (
                <ChangeItem
                  key={i}
                  patch={p}
                  onHighlight={() => void messageTab({ type: 'yandz:highlight-element', target: p.target })}
                />
              ))}
            {v.patches.length === 0 && <p className="muted">No changes.</p>}
          </>
        )}
      </div>
    </div>
  );
}
