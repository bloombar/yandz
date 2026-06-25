/**
 * User profile: u/handle with an inline Follow icon, a kebab menu for mute/block, and
 * the user's modifications grouped into This page / This site / Global scope tabs (the
 * tabs that don't apply to the current browser context are disabled). Newest first.
 */
import React, { useEffect, useState } from 'react';
import { UserPlus, UserCheck, MoreVertical } from 'lucide-react';
import { Api, type FeedItem, type FeedScope } from '../../../lib/api.js';
import { shareVersion } from '../../../lib/share.js';
import { PanelHeader } from './PanelHeader.js';
import { VersionRow } from './VersionRow.js';

interface ProfileData {
  user: { id: string; handle: string };
  modifications: FeedItem[];
  relationship: { following: boolean; muted: boolean; blocked: boolean };
}

interface Props {
  userId: string;
  /** Normalized key of the active page (enables the This page tab), or null. */
  currentPageKey: string | null;
  /** Host of the active page (enables the This site tab), or null. */
  currentHost: string | null;
  currentUserId: string | null;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
  onOpenComments: (version: FeedItem) => void;
  onOpenChanges: (version: FeedItem) => void;
  onOpenDetails: (version: FeedItem) => void;
  /** Apply (page) or activate (site/global) a version — same handler as the feed. */
  onApply: (version: FeedItem) => void;
}

/** The lowercased host of a normalized urlKey, or '' if unparseable. */
function hostOf(urlKey: string): string {
  try {
    return new URL(urlKey).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function Profile({
  userId,
  currentPageKey,
  currentHost,
  currentUserId,
  onClose,
  onOpenProfile,
  onOpenComments,
  onOpenChanges,
  onOpenDetails,
  onApply,
}: Props): React.JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Default to the most specific scope available for the current context.
  const [scope, setScope] = useState<FeedScope>(currentPageKey ? 'page' : currentHost ? 'site' : 'global');

  useEffect(() => {
    setMenuOpen(false);
    void Api.getProfile(userId).then((d) => setData(d as unknown as ProfileData)).catch(() => setData(null));
  }, [userId]);

  if (!data) return <div className="list">Loading…</div>;
  const rel = data.relationship;

  /** Toggle a relationship and refresh the profile. */
  const toggle = async (kind: 'follow' | 'mute' | 'block', on: boolean) => {
    await Api[kind](userId, on);
    setData((await Api.getProfile(userId)) as unknown as ProfileData);
  };

  // Row actions (mirror the feed) operating on the local modifications list.
  const setMods = (fn: (xs: FeedItem[]) => FeedItem[]) => setData((d) => (d ? { ...d, modifications: fn(d.modifications) } : d));
  const onVote = async (v: FeedItem, value: 1 | -1) => {
    if (v.myVote === value) return; // already voted this way — do nothing
    const tally = await Api.vote(v.id, value).catch(() => null);
    if (tally) setMods((xs) => xs.map((x) => (x.id === v.id ? { ...x, ...tally } : x)));
  };
  const onToggleBookmark = async (v: FeedItem) => {
    const on = !v.bookmarked;
    await Api.toggleBookmark(v.id, on).catch(() => {});
    setMods((xs) => xs.map((x) => (x.id === v.id ? { ...x, bookmarked: on } : x)));
  };
  const onDelete = async (v: FeedItem) => {
    await Api.deleteVersion(v.id).catch(() => {});
    setMods((xs) => xs.filter((x) => x.id !== v.id));
  };

  // The three scope tabs; This page / This site are disabled without a current page/site.
  const TABS: { key: FeedScope; label: string; disabled: boolean }[] = [
    { key: 'page', label: 'This page', disabled: !currentPageKey },
    { key: 'site', label: 'This site', disabled: !currentHost },
    { key: 'global', label: 'Global', disabled: false },
  ];

  // Versions for the selected scope (already newest-first from the server).
  const shown = data.modifications.filter((m) => {
    if (m.scope !== scope) return false;
    if (scope === 'page') return m.page.urlKey === currentPageKey;
    if (scope === 'site') return hostOf(m.page.urlKey) === currentHost;
    return true; // global
  });

  return (
    <div className="list">
      <PanelHeader
        title={
          <span className="profile-name">
            u/{data.user.handle}
            <button
              className={`icon-btn ${rel.following ? 'active' : ''}`}
              title={rel.following ? 'Unfollow' : 'Follow'}
              onClick={() => toggle('follow', !rel.following)}
            >
              {rel.following ? <UserCheck size={16} /> : <UserPlus size={16} />}
              {rel.following && <span className="follow-label">Following</span>}
            </button>
          </span>
        }
        onClose={onClose}
      >
        <div className="kebab">
          <button className="icon-btn" aria-label="More" title="More" onClick={() => setMenuOpen((o) => !o)}>
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="kebab-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button className="kebab-item" onClick={() => toggle('mute', !rel.muted)}>
                {rel.muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="kebab-item" onClick={() => toggle('block', !rel.blocked)}>
                {rel.blocked ? 'Unblock' : 'Block'}
              </button>
            </div>
          )}
        </div>
      </PanelHeader>

      {/* Scope tabs (This page / This site / Global), same as the feeds. */}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            className="tab"
            role="tab"
            aria-selected={scope === t.key}
            disabled={t.disabled}
            title={t.disabled ? 'Open a web page to see these' : undefined}
            onClick={() => setScope(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {shown.map((v) => (
        <VersionRow
          key={v.id}
          version={v}
          currentUserId={currentUserId}
          onApply={onApply}
          onVote={onVote}
          onOpenProfile={onOpenProfile}
          onOpenComments={(x) => onOpenComments(x)}
          onToggleBookmark={onToggleBookmark}
          onShare={(x) => void shareVersion(x.page.urlKey, x.id, x.name)}
          onDelete={onDelete}
          onOpenChanges={onOpenChanges}
          onOpenDetails={onOpenDetails}
        />
      ))}
      {shown.length === 0 && <p className="muted">No modifications in this scope.</p>}
    </div>
  );
}
