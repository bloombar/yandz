/**
 * Two-tab switcher used by the version panel: Changes (N) | Comments (M).
 * Defaults to Changes. Reuses the feed `.tabs`/`.tab` styles.
 */
import React from 'react';

export type VersionTab = 'comments' | 'changes';

export function PanelTabs({
  tab,
  setTab,
  changeCount,
  commentCount,
}: {
  tab: VersionTab;
  setTab: (t: VersionTab) => void;
  changeCount: number;
  commentCount: number;
}): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      <button className="tab" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>
        Changes{changeCount > 0 ? ` (${changeCount})` : ''}
      </button>
      <button className="tab" role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
        Comments{commentCount > 0 ? ` (${commentCount})` : ''}
      </button>
    </div>
  );
}
