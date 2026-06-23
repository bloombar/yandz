/**
 * Account settings, in three tabs:
 *  - People: the viewer's Following / Muted / Blocked lists (each undoable).
 *  - Changes to all sites: the viewer's global-scoped changes; deleting one demotes it
 *    to apply only across the site it was made on.
 *  - Site-specific changes: the viewer's site-scoped changes grouped by site; deleting
 *    one (or all for a site) demotes it to apply only on its original page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api, type PublicUser, type ScopedPatchEntry } from '../../../lib/api.js';
import { describePatch } from '../../../lib/describe-patch.js';
import { ITEMS_PER_PAGE_DEFAULT, ITEMS_PER_PAGE_MIN, ITEMS_PER_PAGE_MAX } from '../../../lib/config.js';
import { PanelHeader } from './PanelHeader.js';

interface Props {
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
  /** Tell the loaded page to re-fetch + re-apply the personal layer (after a demote). */
  messageTab: (payload: unknown) => Promise<boolean> | void;
}

type SettingsTab = 'people' | 'global' | 'site' | 'prefs';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'global', label: 'Changes to all sites' },
  { key: 'site', label: 'Site-specific changes' },
  { key: 'prefs', label: 'Preferences' },
];

export function Settings({ onOpenProfile, onClose, messageTab }: Props): React.JSX.Element {
  /** After demoting a scoped change, remove its effect from the loaded page now. */
  const refreshPage = () => void messageTab({ type: 'yandz:refresh-personal' });

  const [tab, setTab] = useState<SettingsTab>('people');
  const [following, setFollowing] = useState<PublicUser[]>([]);
  const [muted, setMuted] = useState<PublicUser[]>([]);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  const [globalPatches, setGlobalPatches] = useState<ScopedPatchEntry[]>([]);
  const [sitePatches, setSitePatches] = useState<ScopedPatchEntry[]>([]);
  const [itemsPerPage, setItemsPerPage] = useState<number>(ITEMS_PER_PAGE_DEFAULT);

  const loadPeople = useCallback(async () => {
    const [f, m, b] = await Promise.all([Api.following(), Api.muted(), Api.blocked()]);
    setFollowing(f);
    setMuted(m);
    setBlocked(b);
  }, []);
  const loadGlobal = useCallback(async () => setGlobalPatches((await Api.getMyGlobalPatches()).patches), []);
  const loadSite = useCallback(async () => setSitePatches((await Api.getMySitePatches()).patches), []);

  useEffect(() => {
    void loadPeople();
    void loadGlobal();
    void loadSite();
    void browser.storage.local.get('itemsPerPage').then((o) => {
      if (o.itemsPerPage !== undefined) setItemsPerPage(Number(o.itemsPerPage) || ITEMS_PER_PAGE_DEFAULT);
    });
  }, [loadPeople, loadGlobal, loadSite]);

  /** Persist the items-per-page preference (App picks it up via storage.onChanged). */
  const saveItemsPerPage = (n: number) => {
    const clamped = Math.min(ITEMS_PER_PAGE_MAX, Math.max(ITEMS_PER_PAGE_MIN, Math.floor(n) || ITEMS_PER_PAGE_DEFAULT));
    setItemsPerPage(clamped);
    void browser.storage.local.set({ itemsPerPage: clamped });
  };

  /** Render one People list with an undo action per row. */
  const peopleList = (title: string, users: PublicUser[], undo: (id: string) => Promise<unknown>, label: string) => (
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
                await loadPeople();
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

  /** One scoped-change card with a delete (demote) button. */
  const patchCard = (e: ScopedPatchEntry, onDelete: () => void) => (
    <div className="card" key={`${e.versionId}:${e.order}`}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {describePatch(e.patch)}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            from “{e.versionName}” · {e.site || 'unknown site'}
          </div>
        </div>
        <button className="icon-btn" aria-label="Delete this change" title="Delete this change" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );

  // Group site-scoped changes by the site they apply to.
  const bySite = sitePatches.reduce<Record<string, ScopedPatchEntry[]>>((acc, e) => {
    (acc[e.site] ??= []).push(e);
    return acc;
  }, {});

  return (
    <div className="list">
      <PanelHeader title="Settings" onClose={onClose} />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} className="tab" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'people' && (
          <>
            {peopleList('Following', following, (id) => Api.follow(id, false), 'Unfollow')}
            {peopleList('Muted', muted, (id) => Api.mute(id, false), 'Unmute')}
            {peopleList('Blocked', blocked, (id) => Api.block(id, false), 'Unblock')}
          </>
        )}

        {tab === 'global' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Changes you apply to every web site. Deleting one keeps it on the site it was made on.
            </p>
            {globalPatches.map((e) =>
              patchCard(e, async () => {
                await Api.setPatchScope(e.versionId, e.order, 'site');
                refreshPage();
                await loadGlobal();
                await loadSite();
              }),
            )}
            {globalPatches.length === 0 && <p className="muted">None.</p>}
          </>
        )}

        {tab === 'site' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Changes you apply across a whole site. Deleting one keeps it on the page it was made on.
            </p>
            {Object.entries(bySite).map(([site, entries]) => (
              <div key={site}>
                <div className="row" style={{ marginTop: 8 }}>
                  <h3 className="muted" style={{ flex: 1, margin: 0 }}>
                    {site || 'unknown site'}
                  </h3>
                  <button
                    className="btn"
                    onClick={async () => {
                      await Api.demoteSitePatches(site);
                      refreshPage();
                      await loadSite();
                    }}
                  >
                    Delete all
                  </button>
                </div>
                {entries.map((e) =>
                  patchCard(e, async () => {
                    await Api.setPatchScope(e.versionId, e.order, 'page');
                    refreshPage();
                    await loadSite();
                  }),
                )}
              </div>
            ))}
            {sitePatches.length === 0 && <p className="muted">None.</p>}
          </>
        )}

        {tab === 'prefs' && (
          <div className="field">
            <label htmlFor="items-per-page">Items per page</label>
            <input
              id="items-per-page"
              type="number"
              min={ITEMS_PER_PAGE_MIN}
              max={ITEMS_PER_PAGE_MAX}
              value={itemsPerPage}
              onChange={(e) => setItemsPerPage(Number(e.target.value))}
              onBlur={(e) => saveItemsPerPage(Number(e.target.value))}
            />
            <p className="field-hint muted">
              How many results each feed loads per page as you scroll ({ITEMS_PER_PAGE_MIN}–{ITEMS_PER_PAGE_MAX}).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
