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
import React, { useState } from 'react';
import { ChevronUp, ChevronDown, MessageSquare, Bookmark, Share2, GitFork, Check, MoreVertical } from 'lucide-react';
import type { FeedItem } from '../../../lib/api.js';

interface Props {
  version: FeedItem;
  /** True when this version is the one currently applied on the active tab. */
  active?: boolean;
  /** The viewer's user id, so the author gets a delete menu on their own versions. */
  currentUserId?: string | null;
  onApply: (v: FeedItem) => void;
  onVote: (v: FeedItem, value: 1 | -1) => void;
  onOpenProfile: (userId: string) => void;
  onOpenComments: (v: FeedItem) => void;
  onToggleBookmark: (v: FeedItem) => void;
  onShare: (v: FeedItem) => void;
  onDelete: (v: FeedItem) => void;
  /** Open the version's changes panel (editable if owned, read-only otherwise). */
  onOpenChanges: (v: FeedItem) => void;
  /** Open the version panel with the smart default tab (hover "See details"). */
  onOpenDetails: (v: FeedItem) => void;
}

/** Middle-truncate a long URL so the host and tail stay visible. */
function shortUrl(urlKey: string): string {
  const stripped = urlKey.replace(/^https?:\/\//, '');
  return stripped.length > 48 ? `${stripped.slice(0, 28)}…${stripped.slice(-16)}` : stripped;
}

export function VersionRow({
  version: v,
  active,
  currentUserId,
  onApply,
  onVote,
  onOpenProfile,
  onOpenComments,
  onToggleBookmark,
  onShare,
  onDelete,
  onOpenChanges,
  onOpenDetails,
}: Props): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const isAuthor = !!currentUserId && currentUserId === v.author.id;
  // Sub-controls call stop() so they don't also trigger the row's "apply" click.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className={`version-row ${active ? 'active' : ''}`}
      role="button"
      title="Apply this modification to the page"
      onClick={() => onApply(v)}
    >
      {/* Top line: the PAGE TITLE (prominent) + comment/bookmark/share. */}
      <div className="vr-line">
        <div className="page-link" aria-pressed={active}>
          {active && <Check size={12} style={{ verticalAlign: 'middle' }} />} {v.page.title || 'Untitled page'}
        </div>
        <div className="row-actions">
          <button className="icon-btn" title="Comments" onClick={stop(() => onOpenComments(v))}>
            <MessageSquare size={14} />
            <span className="count">{v.commentCount}</span>
          </button>
          <button
            className={`icon-btn ${v.bookmarked ? 'active' : ''}`}
            title={v.bookmarked ? 'Remove bookmark' : 'Bookmark'}
            onClick={stop(() => onToggleBookmark(v))}
          >
            <Bookmark size={14} fill={v.bookmarked ? 'currentColor' : 'none'} />
          </button>
          <button className="icon-btn" title="Share" onClick={stop(() => onShare(v))}>
            <Share2 size={14} />
          </button>
          {/* Author-only menu (same kebab style as block/mute) with Delete. */}
          {isAuthor && (
            <div className="kebab">
              <button className="icon-btn" aria-label="More" title="More" onClick={stop(() => setMenuOpen((o) => !o))}>
                <MoreVertical size={14} />
              </button>
              {menuOpen && (
                <div className="kebab-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <button className="kebab-item" onClick={stop(() => { setMenuOpen(false); onDelete(v); })}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Secondary line: version title (link) + site URL + changes link. */}
      <div className="muted vr-sub" title={v.page.urlKey}>
        <span className="version-name">{v.name}</span> · <span className="url-text">{shortUrl(v.page.urlKey)}</span> ·{' '}
        <span className="changes-link" role="button" title="View this version's changes" onClick={stop(() => onOpenChanges(v))}>
          {v.patches.length} change{v.patches.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Bottom line: author/date (left) + votes (down · net · up), right-aligned. */}
      <div className="vr-line">
        <div className="muted">
          <span className="handle" onClick={stop(() => onOpenProfile(v.author.id))}>
            u/{v.author.handle}
          </span>{' '}
          · {new Date(v.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
          {v.parentAuthor && (
            <>
              {' '}
              · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> based on{' '}
              <span className="handle" onClick={stop(() => onOpenProfile(v.parentAuthor!.id))}>
                u/{v.parentAuthor.handle}
              </span>
              ’s
            </>
          )}
        </div>
        {/* Revealed on row hover; opens the details panel (smart default tab). */}
        <span className="see-details" role="button" title="See details" onClick={stop(() => onOpenDetails(v))}>
          See details
        </span>
        <span className="votes">
          <button
            className={`icon-btn vote-down ${v.myVote === -1 ? 'active' : ''}`}
            aria-label="downvote"
            aria-pressed={v.myVote === -1}
            onClick={stop(() => onVote(v, -1))}
          >
            <ChevronDown size={14} />
          </button>
          {/* Net score, colored to match the viewer's own vote. */}
          <strong className={v.myVote === 1 ? 'vote-up-text' : v.myVote === -1 ? 'vote-down-text' : ''}>
            {v.up - v.down}
          </strong>
          <button
            className={`icon-btn vote-up ${v.myVote === 1 ? 'active' : ''}`}
            aria-label="upvote"
            aria-pressed={v.myVote === 1}
            onClick={stop(() => onVote(v, 1))}
          >
            <ChevronUp size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}
