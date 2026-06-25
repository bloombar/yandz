/**
 * Account settings, in four tabs:
 *  - People: the viewer's Following / Muted / Blocked lists (each undoable).
 *  - Global: versions the viewer has activated on every site; deactivating one stops it
 *    auto-applying.
 *  - Site: versions the viewer has activated across a whole site, grouped by host;
 *    deactivating one stops it auto-applying there.
 *  - Preferences: patching consent + items-per-page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api, type PublicUser, type FeedItem } from '../../../lib/api.js';
import { ITEMS_PER_PAGE_DEFAULT, ITEMS_PER_PAGE_MIN, ITEMS_PER_PAGE_MAX } from '../../../lib/config.js';
import { getConsent, setConsent } from '../../../lib/ui/consent-modal.js';
import { PanelHeader } from './PanelHeader.js';

interface Props {
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
  /** Tell the loaded page to re-fetch + re-apply activations (after a deactivate). */
  messageTab: (payload: unknown) => Promise<boolean> | void;
  /** Open a version's read-only details. */
  onOpenChanges: (version: FeedItem) => void;
}

type SettingsTab = 'people' | 'global' | 'site' | 'prefs';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'global', label: 'Global changes' },
  { key: 'site', label: 'Site changes' },
  { key: 'prefs', label: 'Preferences' },
];

/** The lowercased host of a normalized urlKey, or '' if unparseable. */
function hostOf(urlKey: string): string {
  try {
    return new URL(urlKey).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function Settings({ onOpenProfile, onClose, messageTab, onOpenChanges }: Props): React.JSX.Element {
  /** After deactivating, remove its effect from the loaded page now. */
  const refreshPage = () => void messageTab({ type: 'yandz:refresh-activations' });

  const [tab, setTab] = useState<SettingsTab>('people');
  const [following, setFollowing] = useState<PublicUser[]>([]);
  const [muted, setMuted] = useState<PublicUser[]>([]);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  const [globalVersions, setGlobalVersions] = useState<FeedItem[]>([]);
  const [siteVersions, setSiteVersions] = useState<FeedItem[]>([]);
  const [itemsPerPage, setItemsPerPage] = useState<number>(ITEMS_PER_PAGE_DEFAULT);
  const [patchingAllowed, setPatchingAllowed] = useState(false);
  const [siteSearch, setSiteSearch] = useState('');
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set()); // collapsed by default
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
  const loadActivations = useCallback(async () => {
    const list = await Api.getActivationsList();
    setGlobalVersions(list.global);
    setSiteVersions(list.site);
  }, []);

  useEffect(() => {
    void loadPeople();
    void loadActivations();
    void browser.storage.local.get('itemsPerPage').then((o) => {
      if (o.itemsPerPage !== undefined) setItemsPerPage(Number(o.itemsPerPage) || ITEMS_PER_PAGE_DEFAULT);
    });
    void getConsent().then((d) => setPatchingAllowed(d === 'granted'));
  }, [loadPeople, loadActivations]);

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

  /** Remove a version's activation, then refresh the lists + the loaded page. */
  const deactivate = async (versionId: string) => {
    await Api.removeActivation(versionId).catch(() => {});
    refreshPage();
    await loadActivations();
  };

  /** One active-version row: name (click → details) + a Deactivate action. */
  const versionRow = (v: FeedItem) => (
    <div className="card" key={v.id}>
      <div className="row">
        <span className="handle" style={{ flex: 1 }} title="View details" onClick={() => onOpenChanges(v)}>
          “{v.name}” by u/{v.author.handle}
        </span>
        <button className="btn" onClick={() => void deactivate(v.id)}>
          Deactivate
        </button>
      </div>
    </div>
  );

  // Group site activations by the host they apply to, filtered by the site search.
  const bySite = siteVersions.reduce<Record<string, FeedItem[]>>((acc, v) => {
    (acc[hostOf(v.page.urlKey)] ??= []).push(v);
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
              Versions you’ve activated on every site. Deactivating one stops it auto-applying.
            </p>
            {globalVersions.map(versionRow)}
            {globalVersions.length === 0 && <p className="muted">None.</p>}
          </>
        )}

        {tab === 'site' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Versions you’ve activated across a whole site. Deactivating one stops it auto-applying there.
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
                  </div>
                  {open && entries.map(versionRow)}
                </div>
              );
            })}
            {siteVersions.length === 0 ? (
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
