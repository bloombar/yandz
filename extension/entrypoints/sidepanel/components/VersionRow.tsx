/**
 * Compact, row-like version item shared by every feed and by profiles. Bottom border
 * only (no card chrome). Layout:
 *
 *   [ [scope] where-it-applies                           💬  🔖  ↗ ]
 *   [ discreet: version name · context · N changes                 ]
 *   [ discreet: u/handle · date · based on u/other        ↑ score ↓ ]
 *
 * "Where it applies" is scope-aware so it isn't misleading: a PAGE version shows the
 * page it edits; a SITE version shows its host (it applies across the whole site); a
 * GLOBAL version shows "All sites" (it applies everywhere — its authoring page URL is
 * incidental and deliberately not surfaced).
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

/** The lowercased host of a normalized urlKey, or the raw key if unparseable. */
function hostOf(urlKey: string): string {
  try {
    return new URL(urlKey).hostname.toLowerCase();
  } catch {
    return urlKey;
  }
}

const SCOPE_LABEL = { page: 'Page', site: 'Site', global: 'Global' } as const;

/**
 * Scope-aware "where this version applies", split into a prominent headline and a
 * discreet sub-line note. A global version is never tied to a specific URL here.
 */
function appliesTo(v: FeedItem): { headline: string; note: string } {
  const host = hostOf(v.page.urlKey);
  if (v.scope === 'global') return { headline: 'All sites', note: 'applies everywhere' };
  if (v.scope === 'site') return { headline: host, note: 'applies across this site' };
  return { headline: v.page.title || 'Untitled page', note: shortUrl(v.page.urlKey) };
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
  const applies = appliesTo(v);
  // Sub-controls call stop() so they don't also trigger the row's "apply" click.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className={`version-row ${active ? 'active' : ''}`}
      data-vid={v.id}
      role="button"
      title="Apply this modification to the page"
      onClick={() => onApply(v)}
    >
      {/* Large vertical vote rail (up · net · down) on the left of the whole item. */}
      <div className="vote-rail">
        <button
          className={`vote-btn vote-up ${v.myVote === 1 ? 'active' : ''}`}
          aria-label="upvote"
          aria-pressed={v.myVote === 1}
          onClick={stop(() => onVote(v, 1))}
        >
          <ChevronUp size={26} />
        </button>
        <strong className={`vote-count ${v.myVote === 1 ? 'vote-up-text' : v.myVote === -1 ? 'vote-down-text' : ''}`}>
          {v.up - v.down}
        </strong>
        <button
          className={`vote-btn vote-down ${v.myVote === -1 ? 'active' : ''}`}
          aria-label="downvote"
          aria-pressed={v.myVote === -1}
          onClick={stop(() => onVote(v, -1))}
        >
          <ChevronDown size={26} />
        </button>
      </div>

      {/* The rest of the item (stacked lines), to the right of the vote rail. */}
      <div className="vr-body">
      {/* Top line: scope chip + where-it-applies (prominent) + comment/bookmark/share. */}
      <div className="vr-line">
        <div className="page-link" aria-pressed={active}>
          {active && <Check size={12} style={{ verticalAlign: 'middle' }} />}{' '}
          <span className={`scope-chip scope-${v.scope}`}>{SCOPE_LABEL[v.scope]}</span> {applies.headline}
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

      {/* Secondary line: version name + scope-aware context note + changes link. */}
      <div className="muted vr-sub" title={v.scope === 'page' ? v.page.urlKey : applies.note}>
        <span className="version-name">{v.name}</span> · <span className="url-text">{applies.note}</span> ·{' '}
        <span className="changes-link" role="button" title="View this version's changes" onClick={stop(() => onOpenChanges(v))}>
          {v.patches.length} change{v.patches.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Bottom line: author/date (left) + "see details" (right). */}
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
      </div>
      </div>
    </div>
  );
}
