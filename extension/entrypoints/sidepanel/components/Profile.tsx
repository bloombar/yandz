/**
 * User profile: u/handle with an inline Follow icon, a kebab menu for mute/block,
 * and the user's modifications rendered with the same VersionRow used by the feeds.
 */
import React, { useEffect, useState } from 'react';
import { UserPlus, UserCheck, MoreVertical } from 'lucide-react';
import { Api, type FeedItem } from '../../../lib/api.js';
import { applyVersionAnywhere } from '../../../lib/apply.js';
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
  currentPageKey: string | null;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
  onOpenComments: (version: FeedItem) => void;
}

export function Profile({ userId, currentPageKey, onClose, onOpenProfile, onOpenComments }: Props): React.JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
    const tally = await Api.vote(v.id, value).catch(() => null);
    if (tally) setMods((xs) => xs.map((x) => (x.id === v.id ? { ...x, ...tally } : x)));
  };
  const onToggleBookmark = async (v: FeedItem) => {
    const on = !v.bookmarked;
    await Api.toggleBookmark(v.id, on).catch(() => {});
    setMods((xs) => xs.map((x) => (x.id === v.id ? { ...x, bookmarked: on } : x)));
  };

  return (
    <div className="list">
      <PanelHeader
        title={
          <span className="profile-name">
            u/{data.user.handle}
            <button
              className={`icon-btn ${rel.following ? 'active' : ''}`}
              title={rel.following ? 'Following' : 'Follow'}
              onClick={() => toggle('follow', !rel.following)}
            >
              {rel.following ? <UserCheck size={16} /> : <UserPlus size={16} />}
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

      {data.modifications.map((v) => (
        <VersionRow
          key={v.id}
          version={v}
          onApply={(x) => void applyVersionAnywhere(x.id, x.page.urlKey, currentPageKey)}
          onVote={onVote}
          onOpenProfile={onOpenProfile}
          onOpenComments={(x) => onOpenComments(x)}
          onToggleBookmark={onToggleBookmark}
          onShare={(x) => void shareVersion(x.page.urlKey, x.id, x.name)}
        />
      ))}
      {data.modifications.length === 0 && <p className="muted">No modifications yet.</p>}
    </div>
  );
}
