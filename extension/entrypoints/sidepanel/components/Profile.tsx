/**
 * User profile: the u/handle, follow/mute/block toggles, and a reverse-chronological
 * list of the pages this user has modified. Toggling a relationship calls the
 * corresponding API and optimistically updates the button state.
 */
import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api } from '../../../lib/api.js';

/**
 * Navigate the CURRENT tab to a page with a specific version queued to auto-apply
 * (no new tab). We stash the target versionId under a per-urlKey storage flag; the
 * content script reads and clears it on load (see entrypoints/content.ts), applying
 * that version even without prior consent — the click is an explicit request to
 * view this mod.
 */
async function openWithVersion(urlKey: string, versionId: string): Promise<void> {
  await browser.storage.local.set({ [`pendingApply:${urlKey}`]: versionId });
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: urlKey });
}

interface ProfileData {
  user: { id: string; handle: string };
  modifications: Array<{ versionId: string; urlKey: string; name: string; createdAt: string }>;
  relationship: { following: boolean; muted: boolean; blocked: boolean };
}

export function Profile({ userId, onClose }: { userId: string; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);

  useEffect(() => {
    void Api.getProfile(userId).then(setData).catch(() => setData(null));
  }, [userId]);

  if (!data) return <div className="list">Loading…</div>;

  const rel = data.relationship;

  /** Toggle a relationship and refresh from the server. */
  const toggle = async (kind: 'follow' | 'mute' | 'block', on: boolean) => {
    await Api[kind](userId, on);
    const fresh = await Api.getProfile(userId);
    setData(fresh);
  };

  return (
    <div className="list">
      <h2>u/{data.user.handle}</h2>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className={`btn ${rel.following ? 'primary' : ''}`} onClick={() => toggle('follow', !rel.following)}>
          {rel.following ? 'Following' : 'Follow'}
        </button>
        <button className="btn" onClick={() => toggle('mute', !rel.muted)}>
          {rel.muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn" onClick={() => toggle('block', !rel.blocked)}>
          {rel.blocked ? 'Unblock' : 'Block'}
        </button>
      </div>
      <h3 className="muted">Modifications</h3>
      {data.modifications.map((m) => (
        <div
          className="card card-link"
          key={m.versionId}
          role="button"
          title="Open this page with this modification applied"
          onClick={() => openWithVersion(m.urlKey, m.versionId)}
        >
          <div className="version-title">
            {m.name} <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
          </div>
          <div className="muted">
            {m.urlKey} · {new Date(m.createdAt).toLocaleDateString()}
          </div>
        </div>
      ))}
      {data.modifications.length === 0 && <p className="muted">No modifications yet.</p>}
      <button className="btn" style={{ marginTop: 10 }} onClick={onClose}>
        Close
      </button>
    </div>
  );
}
