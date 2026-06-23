/**
 * Account settings, in three tabs:
 *  - People: the viewer's Following / Muted / Blocked lists (each undoable).
 *  - Changes to all sites: the viewer's global-scoped changes; deleting one demotes it
 *    to apply only across the site it was made on.
 *  - Site-specific changes: the viewer's site-scoped changes grouped by site; deleting
 *    one (or all for a site) demotes it to apply only on its original page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRight, MoreVertical } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api, type PublicUser, type ScopedPatchEntry } from '../../../lib/api.js';
import type { PatchScope } from '@yandz/shared';
import { ITEMS_PER_PAGE_DEFAULT, ITEMS_PER_PAGE_MIN, ITEMS_PER_PAGE_MAX } from '../../../lib/config.js';
import { getConsent, setConsent } from '../../../lib/ui/consent-modal.js';
import { ChangeItem } from './ChangeItem.js';
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
  const [patchingAllowed, setPatchingAllowed] = useState(false);
  const [siteSearch, setSiteSearch] = useState('');
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set()); // collapsed by default
  const [openMenu, setOpenMenu] = useState<string | null>(null); // which site's kebab menu is open
  const toggleSite = (site: string) =>
    setExpandedSites((prev) => {
      const next = new Set(prev);
      next.has(site) ? next.delete(site) : next.add(site);
      return next;
    });

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
    void getConsent().then((d) => setPatchingAllowed(d === 'granted'));
  }, [loadPeople, loadGlobal, loadSite]);

  /** Toggle global consent to patch web pages (content scripts react via storage). */
  const togglePatching = (allowed: boolean) => {
    setPatchingAllowed(allowed);
    void setConsent(allowed ? 'granted' : 'declined');
  };

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

  /** Reflect a scope change/demotion across both lists + the loaded page. */
  const afterScope = async () => {
    refreshPage();
    await Promise.all([loadGlobal(), loadSite()]);
  };

  /** One scoped change, rendered with the SAME expandable layout as the editor's change
   *  list (click to see details, scope dropdown). `demoteTo` is the scope the trash
   *  reduces it to (global→site, site→page). */
  const changeRow = (e: ScopedPatchEntry, demoteTo: PatchScope) => (
    <ChangeItem
      key={`${e.versionId}:${e.order}`}
      patch={e.patch}
      onHighlight={() => {}}
      onDelete={async () => {
        await Api.setPatchScope(e.versionId, e.order, demoteTo);
        await afterScope();
      }}
      onScopeChange={async (scope) => {
        await Api.setPatchScope(e.versionId, e.order, scope);
        await afterScope();
      }}
    />
  );

  // Group site-scoped changes by the site they apply to, filtered by the site search.
  const bySite = sitePatches.reduce<Record<string, ScopedPatchEntry[]>>((acc, e) => {
    (acc[e.site] ??= []).push(e);
    return acc;
  }, {});
  const siteQuery = siteSearch.trim().toLowerCase();
  const filteredSites = Object.entries(bySite).filter(([site]) => site.toLowerCase().includes(siteQuery));

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
            {globalPatches.map((e) => changeRow(e, 'site'))}
            {globalPatches.length === 0 && <p className="muted">None.</p>}
          </>
        )}

        {tab === 'site' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Changes you apply across a whole site. Deleting one keeps it on the page it was made on.
            </p>
            <input
              className="search-input"
              type="search"
              placeholder="Search sites"
              aria-label="Search sites"
              value={siteSearch}
              onChange={(e) => setSiteSearch(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            {filteredSites.map(([site, entries]) => {
              const open = expandedSites.has(site);
              return (
                <div className="site-group" key={site}>
                  <div
                    className="site-group-header"
                    role="button"
                    aria-expanded={open}
                    title={open ? 'Collapse' : 'Expand'}
                    onClick={() => toggleSite(site)}
                  >
                    <ChevronRight size={14} className={`site-chevron ${open ? 'open' : ''}`} />
                    <span className="site-host">{site || 'unknown site'}</span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {entries.length}
                    </span>
                    {/* Kebab menu — keeps "Delete all" out of sight until needed. */}
                    <div className="kebab" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        className="icon-btn"
                        aria-label="More"
                        title="More"
                        onClick={() => setOpenMenu((m) => (m === site ? null : site))}
                      >
                        <MoreVertical size={14} />
                      </button>
                      {openMenu === site && (
                        <div className="kebab-menu" onMouseLeave={() => setOpenMenu(null)}>
                          <button
                            className="kebab-item"
                            onClick={async () => {
                              setOpenMenu(null);
                              await Api.demoteSitePatches(site);
                              refreshPage();
                              await loadSite();
                            }}
                          >
                            Delete all on this site
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {open && entries.map((e) => changeRow(e, 'page'))}
                </div>
              );
            })}
            {sitePatches.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              filteredSites.length === 0 && <p className="muted">No sites matching “{siteSearch}”.</p>
            )}
          </>
        )}

        {tab === 'prefs' && (
          <>
          <div className="field">
            <label htmlFor="allow-patching">Modify web pages</label>
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input
                id="allow-patching"
                type="checkbox"
                checked={patchingAllowed}
                onChange={(e) => togglePatching(e.target.checked)}
              />
              <span>Allow Y and Z to apply modifications to the pages you visit</span>
            </label>
            <p className="field-hint muted">
              When off, no page is modified anywhere until you turn this back on.
            </p>
          </div>
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
          </>
        )}
      </div>
    </div>
  );
}
