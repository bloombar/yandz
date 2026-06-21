/**
 * The ranked list of versions for the current page. Each row shows the author
 * (u/handle, clickable → profile), the modification date, the net vote score with
 * up/down controls, a comment count, and Apply (switch the live page to this
 * version). Selecting a row applies it; Revert restores the original page.
 */
import React, { useState } from 'react';
import { ChevronUp, ChevronDown, MessageSquare, GitFork } from 'lucide-react';
import type { VersionSummary } from '../../../lib/api.js';

interface Props {
  versions: VersionSummary[];
  onVote: (v: VersionSummary, value: 1 | -1) => void;
  onApply: (v: VersionSummary) => void;
  onRevert: () => void;
  onOpenProfile: (userId: string) => void;
  onOpenComments: (v: VersionSummary) => void;
  onFork: (v: VersionSummary) => void;
}

export function VersionList({
  versions,
  onVote,
  onApply,
  onRevert,
  onOpenProfile,
  onOpenComments,
  onFork,
}: Props): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <div>
      {activeId && (
        <button className="btn" style={{ marginBottom: 8 }} onClick={() => { setActiveId(null); onRevert(); }}>
          Revert to original
        </button>
      )}
      {versions.map((v) => (
        <div className="card" key={v.id}>
          <div className="row">
            <div className="votes">
              <button className="btn" aria-label="upvote" onClick={() => onVote(v, 1)}>
                <ChevronUp size={14} />
              </button>
              <strong>{v.up - v.down}</strong>
              <button className="btn" aria-label="downvote" onClick={() => onVote(v, -1)}>
                <ChevronDown size={14} />
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <div>{v.name}</div>
              <div className="muted">
                <span className="handle" onClick={() => onOpenProfile(v.author.id)}>
                  u/{v.author.handle}
                </span>{' '}
                · {new Date(v.createdAt).toLocaleDateString()}
                {v.parentVersionId && (
                  <>
                    {' '}
                    · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> forked
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className={`btn ${activeId === v.id ? 'primary' : ''}`}
              onClick={() => { setActiveId(v.id); onApply(v); }}
            >
              {activeId === v.id ? 'Applied' : 'Apply'}
            </button>
            <button className="btn" onClick={() => onFork(v)} title="Fork this version">
              <GitFork size={12} /> Fork
            </button>
            <button
              className="btn"
              onClick={() => onOpenComments(v)}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <MessageSquare size={12} /> {v.commentCount}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
