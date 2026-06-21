/**
 * Compact, row-like version item shared by all feeds (For you / Latest / Bookmarks)
 * and by profiles. Bottom border only (no card chrome). Layout:
 *
 *   [ title (click → apply)                              ↑ score ↓ ]
 *   [ discreet: page title · site URL                    💬  🔖  ↗ ]
 *   [ discreet: u/handle · date · based on u/other                 ]
 *
 * The page title + site URL always show so a global-feed viewer can tell which page
 * each version modifies.
 */
import React from 'react';
import { ChevronUp, ChevronDown, MessageSquare, Bookmark, Share2, GitFork, Check } from 'lucide-react';
import type { FeedItem } from '../../../lib/api.js';

interface Props {
  version: FeedItem;
  /** True when this version is the one currently applied on the active tab. */
  active?: boolean;
  onApply: (v: FeedItem) => void;
  onVote: (v: FeedItem, value: 1 | -1) => void;
  onOpenProfile: (userId: string) => void;
  onOpenComments: (v: FeedItem) => void;
  onToggleBookmark: (v: FeedItem) => void;
  onShare: (v: FeedItem) => void;
}

/** Middle-truncate a long URL so the host and tail stay visible. */
function shortUrl(urlKey: string): string {
  const stripped = urlKey.replace(/^https?:\/\//, '');
  return stripped.length > 48 ? `${stripped.slice(0, 28)}…${stripped.slice(-16)}` : stripped;
}

export function VersionRow({
  version: v,
  active,
  onApply,
  onVote,
  onOpenProfile,
  onOpenComments,
  onToggleBookmark,
  onShare,
}: Props): React.JSX.Element {
  return (
    <div className="version-row">
      {/* Top line: title (apply) + comment / bookmark / share icons. */}
      <div className="vr-line">
        <div
          className="version-title"
          role="button"
          aria-pressed={active}
          title="Apply this modification to the page"
          onClick={() => onApply(v)}
        >
          {active && <Check size={12} style={{ verticalAlign: 'middle' }} />} {v.name}
        </div>
        <div className="row-actions">
          <button className="icon-btn" title="Comments" onClick={() => onOpenComments(v)}>
            <MessageSquare size={14} />
            <span className="count">{v.commentCount}</span>
          </button>
          <button
            className={`icon-btn ${v.bookmarked ? 'active' : ''}`}
            title={v.bookmarked ? 'Remove bookmark' : 'Bookmark'}
            onClick={() => onToggleBookmark(v)}
          >
            <Bookmark size={14} fill={v.bookmarked ? 'currentColor' : 'none'} />
          </button>
          <button className="icon-btn" title="Share" onClick={() => onShare(v)}>
            <Share2 size={14} />
          </button>
        </div>
      </div>

      {/* The page each version modifies — always shown for global-feed context. */}
      <div className="muted page-ref" title={v.page.urlKey}>
        {v.page.title || 'Untitled page'} · {shortUrl(v.page.urlKey)}
      </div>

      {/* Bottom line: author/date (left) + votes (down · net · up), right-aligned
          under the action icons. */}
      <div className="vr-line">
        <div className="muted">
          <span className="handle" onClick={() => onOpenProfile(v.author.id)}>
            u/{v.author.handle}
          </span>{' '}
          · {new Date(v.createdAt).toLocaleDateString()}
          {v.parentVersionId && (
            <>
              {' '}
              · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> based on another
            </>
          )}
        </div>
        <span className="votes">
          <button className="icon-btn" aria-label="downvote" onClick={() => onVote(v, -1)}>
            <ChevronDown size={14} />
          </button>
          <strong>{v.up - v.down}</strong>
          <button className="icon-btn" aria-label="upvote" onClick={() => onVote(v, 1)}>
            <ChevronUp size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}
