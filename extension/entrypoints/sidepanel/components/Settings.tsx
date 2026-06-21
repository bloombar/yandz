/**
 * Account settings: the viewer's Following, Muted, and Blocked lists. Each entry is
 * undoable (unfollow / unmute / unblock) and clicking a handle opens that profile.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Api, type PublicUser } from '../../../lib/api.js';
import { PanelHeader } from './PanelHeader.js';

interface Props {
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
}

export function Settings({ onOpenProfile, onClose }: Props): React.JSX.Element {
  const [following, setFollowing] = useState<PublicUser[]>([]);
  const [muted, setMuted] = useState<PublicUser[]>([]);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);

  const load = useCallback(async () => {
    const [f, m, b] = await Promise.all([Api.following(), Api.muted(), Api.blocked()]);
    setFollowing(f);
    setMuted(m);
    setBlocked(b);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Render one list with an undo action per row. */
  const list = (title: string, users: PublicUser[], undo: (id: string) => Promise<unknown>, label: string) => (
    <>
      <h3 className="muted">{title}</h3>
      {users.map((u) => (
        <div className="card" key={u.id}>
          <div className="row">
            <span className="handle" style={{ flex: 1 }} onClick={() => onOpenProfile(u.id)}>
              u/{u.handle}
            </span>
            <button
              className="btn"
              onClick={async () => {
                await undo(u.id);
                await load();
              }}
            >
              {label}
            </button>
          </div>
        </div>
      ))}
      {users.length === 0 && <p className="muted">None.</p>}
    </>
  );

  return (
    <div className="list">
      <PanelHeader title="Settings" onClose={onClose} />
      {list('Following', following, (id) => Api.follow(id, false), 'Unfollow')}
      {list('Muted', muted, (id) => Api.mute(id, false), 'Unmute')}
      {list('Blocked', blocked, (id) => Api.block(id, false), 'Unblock')}
    </div>
  );
}
