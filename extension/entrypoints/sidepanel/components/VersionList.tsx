/**
 * The ranked list of versions for the current page. Each card shows the
 * modification title (click it to APPLY that version to the live page) and the
 * author (u/handle → profile) on the left, with the up/down vote control and net
 * score on the right. A secondary row offers Fork and the comment board. Revert
 * restores the original page.
 */
import React, { useState } from 'react';
import { ChevronUp, ChevronDown, MessageSquare, GitFork, Check } from 'lucide-react';
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
      {versions.map((v) => {
        const active = activeId === v.id;
        return (
          <div className="card" key={v.id}>
            <div className="row">
              <div style={{ flex: 1 }}>
                {/* Title doubles as the "apply this version" action. */}
                <div
                  className="version-title"
                  role="button"
                  aria-pressed={active}
                  title="Apply this modification to the page"
                  onClick={() => { setActiveId(v.id); onApply(v); }}
                >
                  {active && <Check size={12} style={{ verticalAlign: 'middle' }} />} {v.name}
                </div>
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
              {/* Votes on the right, aligned with the title + author. */}
              <div className="votes votes-right">
                <button className="btn" aria-label="upvote" onClick={() => onVote(v, 1)}>
                  <ChevronUp size={14} />
                </button>
                <strong>{v.up - v.down}</strong>
                <button className="btn" aria-label="downvote" onClick={() => onVote(v, -1)}>
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
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
        );
      })}
    </div>
  );
}
