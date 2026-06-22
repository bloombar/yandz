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
}: Props): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const isAuthor = !!currentUserId && currentUserId === v.author.id;
  return (
    <div className="version-row">
      {/* Top line: the PAGE TITLE (prominent, link-like) + comment/bookmark/share. */}
      <div className="vr-line">
        <div
          className="page-link"
          role="button"
          aria-pressed={active}
          title="Apply this modification to the page"
          onClick={() => onApply(v)}
        >
          {active && <Check size={12} style={{ verticalAlign: 'middle' }} />} {v.page.title || 'Untitled page'}
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
          {/* Author-only menu (same kebab style as block/mute) with Delete. */}
          {isAuthor && (
            <div className="kebab">
              <button className="icon-btn" aria-label="More" title="More" onClick={() => setMenuOpen((o) => !o)}>
                <MoreVertical size={14} />
              </button>
              {menuOpen && (
                <div className="kebab-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <button
                    className="kebab-item"
                    onClick={() => {
                      setMenuOpen(false);
                      if (confirm('Delete this version? This can’t be undone.')) onDelete(v);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Secondary line: the version's own title (gray, less prominent) + the site
          URL (muted). Both are clickable to apply, but not styled as links. */}
      <div className="muted vr-sub" title={v.page.urlKey}>
        <span className="version-name" role="button" onClick={() => onApply(v)}>
          {v.name}
        </span>{' '}
        · <span className="url-text" role="button" onClick={() => onApply(v)}>{shortUrl(v.page.urlKey)}</span>
      </div>

      {/* Bottom line: author/date (left) + votes (down · net · up), right-aligned
          under the action icons. */}
      <div className="vr-line">
        <div className="muted">
          <span className="handle" onClick={() => onOpenProfile(v.author.id)}>
            u/{v.author.handle}
          </span>{' '}
          · {new Date(v.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
          {v.parentAuthor && (
            <>
              {' '}
              · <GitFork size={11} style={{ verticalAlign: 'middle' }} /> based on{' '}
              <span className="handle" onClick={() => onOpenProfile(v.parentAuthor!.id)}>
                u/{v.parentAuthor.handle}
              </span>
              ’s
            </>
          )}
        </div>
        <span className="votes">
          <button
            className={`icon-btn vote-down ${v.myVote === -1 ? 'active' : ''}`}
            aria-label="downvote"
            aria-pressed={v.myVote === -1}
            onClick={() => onVote(v, -1)}
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
            onClick={() => onVote(v, 1)}
          >
            <ChevronUp size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}
