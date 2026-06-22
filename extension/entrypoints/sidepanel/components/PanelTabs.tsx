/**
 * Two-tab switcher used by the version panel: Comments | Changes (N).
 * Reuses the feed `.tabs`/`.tab` styles for a consistent look.
 */
import React from 'react';

export type VersionTab = 'comments' | 'changes';

export function PanelTabs({
  tab,
  setTab,
  changeCount,
}: {
  tab: VersionTab;
  setTab: (t: VersionTab) => void;
  changeCount: number;
}): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      <button className="tab" role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
        Comments
      </button>
      <button className="tab" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>
        Changes ({changeCount})
      </button>
    </div>
  );
}
