/**
 * Side panel root. Renders the three scope feeds (This page / This site / Global), each
 * filtered (All / Following / Mine / Bookmarked) and sorted (Your feed / Latest), with
 * an "applied to this page" bar above the tabs showing the versions currently layered on
 * the open page. Orchestrates a navigation STACK of panels (profile / comments / editor /
 * settings) where closing pops back to the previous view. The top nav holds icon tools
 * (select element, draw) that start an editing session, plus settings.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon, Type, Brush } from 'lucide-react';
import { browser } from 'wxt/browser';
import {
  Api,
  getToken,
  setToken,
  getCurrentUser,
  type FeedItem,
  type FeedResult,
  type FeedScope,
  type FeedFilter,
  type FeedSort,
  type PublicUser,
} from '../../lib/api.js';
import type { VersionScope } from '@yandz/shared';
import {
  ITEMS_PER_PAGE_DEFAULT,
  ITEMS_PER_PAGE_MIN,
  ITEMS_PER_PAGE_MAX,
  FEED_WINDOW_PAGES,
  FEED_SCROLL_THRESHOLD_PX,
} from '../../lib/config.js';
import { useWindowedFeed } from './useWindowedFeed.js';
import { applyVersionAnywhere } from '../../lib/apply.js';
import { shareVersion } from '../../lib/share.js';
import { AuthForm } from './components/AuthForm.js';
import { VersionRow } from './components/VersionRow.js';
import { AppliedBar, type AppliedEntry } from './components/AppliedBar.js';
import { Profile } from './components/Profile.js';
import { Editor } from './components/Editor.js';
import { Settings } from './components/Settings.js';
import { VersionChanges } from './components/VersionChanges.js';
import type { VersionTab } from './components/PanelTabs.js';

type View =
  | { name: 'feed' }
  | { name: 'profile'; userId: string }
  | { name: 'changes'; version: FeedItem; initialTab: VersionTab }
  | {
      name: 'editor';
      // Editing the viewer's OWN existing version (update it, no new version).
      editVersionId?: string;
      editName?: string;
      editScope?: VersionScope;
      editCommentCount?: number;
      // Deriving from another user's version (creates a new attributed version).
      baseVersionId?: string;
      baseAuthorHandle?: string;
      baseName?: string;
      initialTab?: VersionTab;
      initialTool?: 'pick' | 'draw';
    }
  | { name: 'settings' };

const SCOPE_TABS: { key: FeedScope; label: string }[] = [
  { key: 'page', label: 'This page' },
  { key: 'site', label: 'This site' },
  { key: 'global', label: 'Global' },
];
const FILTERS: { key: FeedFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'following', label: 'Following' },
  { key: 'mine', label: 'Mine' },
  { key: 'bookmarked', label: 'Bookmarked' },
];

async function getActiveTab(): Promise<{ id?: number; url?: string; title?: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url, title: tab?.title };
}

/** Whether a URL is a normal web page (content scripts + this-page/site scope apply). */
function isWebUrl(url?: string): boolean {
  return !!url && /^https?:\/\//.test(url);
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [pageTitle, setPageTitle] = useState<string | undefined>();
  // Feed controls: the scope tab, the in-tab filter, and the sort.
  const [scope, setScope] = useState<FeedScope>('global');
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [sort, setSort] = useState<FeedSort>('foryou');
  const [currentPageKey, setCurrentPageKey] = useState<string | null>(null);
  // The versions currently applied to the open page, per scope (drives the applied bar
  // and row highlighting). Reported by the content script.
  const [applied, setApplied] = useState<AppliedEntry[]>([]);
  // Full feed items for the viewer's active site/global versions, so the applied bar can
  // open their details even when they aren't in the current tab's list.
  const [appliedItems, setAppliedItems] = useState<FeedItem[]>([]);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(ITEMS_PER_PAGE_DEFAULT);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // Live feed search: `searchInput` is the raw field value; `search` is the debounced
  // value actually queried (so each keystroke doesn't fire a request).
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Navigation stack — closing a panel pops back to the previous view.
  const [stack, setStack] = useState<View[]>([{ name: 'feed' }]);
  const view = stack[stack.length - 1]!;
  const push = (v: View) => setStack((s) => [...s, v]);
  const close = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const appliedIds = new Set(applied.map((a) => a.versionId));

  /** Message the content script in the active tab; false if unreachable. */
  const messageTab = useCallback(async (payload: unknown): Promise<boolean> => {
    const { id } = await getActiveTab();
    if (id === undefined) return false;
    try {
      await browser.tabs.sendMessage(id, payload);
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Ask the active tab's content script which versions are currently applied (per scope). */
  const queryApplied = useCallback(async (): Promise<AppliedEntry[]> => {
    const { id } = await getActiveTab();
    if (id === undefined) return [];
    try {
      return ((await browser.tabs.sendMessage(id, { type: 'yandz:get-applied' })) as AppliedEntry[]) ?? [];
    } catch {
      return [];
    }
  }, []);

  // Kept in a ref so the (mount-once) applied-version listener sees the live value.
  const currentPageKeyRef = useRef<string | null>(null);
  currentPageKeyRef.current = currentPageKey;

  useEffect(() => {
    void getToken()
      .then((t) => setAuthed(!!t))
      .catch(() => setAuthed(false));
    void getCurrentUser().then((u) => setCurrentUserId(u?.id ?? null));
  }, [authed]);

  const lastUrlRef = useRef<string | undefined>(undefined);

  // Page metadata for the active tab (url/title). The feed LIST itself is fetched +
  // windowed by useWindowedFeed below (reset whenever resetKey changes).
  const refresh = useCallback(async () => {
    const active = await getActiveTab();
    lastUrlRef.current = active.url;
    setUrl(active.url);
    setPageTitle(active.title);
  }, []);

  // The page/site scope tabs need a real web page; off one, force the Global tab.
  useEffect(() => {
    if (!isWebUrl(url) && scope !== 'global') setScope('global');
  }, [url, scope]);

  // One page of the active feed (scope/filter/sort/url/search), for the windowed list.
  const fetchPage = useCallback(
    (offset: number, limit: number): Promise<FeedResult> => {
      const effScope: FeedScope = isWebUrl(url) ? scope : 'global';
      if (filter === 'bookmarked') return Api.getBookmarksFeed(effScope, url, search, offset, limit);
      return Api.getFeed(effScope, filter, sort, url, search, offset, limit);
    },
    [scope, filter, sort, url, search],
  );

  // After the first page loads: surface currentPageKey and reflect whatever the content
  // script currently has applied (from shared session storage, else query).
  const onFirstPage = useCallback(
    (res: FeedResult) => {
      setCurrentPageKey(res.currentPageKey);
      void (async () => {
        let list: AppliedEntry[] = [];
        if (res.currentPageKey) {
          const k = `applied:${res.currentPageKey}`;
          const obj = (await browser.storage.session.get(k).catch(() => ({}))) as Record<string, unknown>;
          const stored = obj[k];
          list = Array.isArray(stored) ? (stored as AppliedEntry[]) : await queryApplied();
        } else {
          list = await queryApplied();
        }
        setApplied(list);
      })();
    },
    [queryApplied],
  );

  const feed = useWindowedFeed({
    fetchPage,
    pageSize,
    windowPages: FEED_WINDOW_PAGES,
    thresholdPx: FEED_SCROLL_THRESHOLD_PX,
    resetKey: `${scope}|${filter}|${sort}|${search}|${url ?? ''}|${pageSize}`,
    enabled: authed === true,
    onFirstPage,
  });
  const items = feed.items;
  const setItems = feed.mutate; // in-place window updates (vote/delete/bookmark)

  // Keep full feed items for the viewer's active site/global versions (for the bar's
  // "view details"). Refreshed when the page changes or activations change.
  const loadAppliedItems = useCallback(() => {
    if (!isWebUrl(url)) {
      setAppliedItems([]);
      return;
    }
    void Api.getActivations(url!)
      .then((r) => setAppliedItems(r.versions))
      .catch(() => setAppliedItems([]));
  }, [url]);
  useEffect(() => {
    if (authed) loadAppliedItems();
  }, [authed, loadAppliedItems]);

  // Reflect late auto-applies / live layer changes: the content script broadcasts the
  // full applied set, which may arrive after our initial query.
  useEffect(() => {
    const listener = (msg: { type?: string; urlKey?: string | null; applied?: AppliedEntry[] }) => {
      if (msg?.type === 'yandz:applied' && (!msg.urlKey || msg.urlKey === currentPageKeyRef.current)) {
        setApplied(Array.isArray(msg.applied) ? msg.applied : []);
      }
    };
    browser.runtime.onMessage.addListener(listener as never);
    return () => browser.runtime.onMessage.removeListener(listener as never);
  }, []);

  // Debounce the search field → committed `search` (drives the feed reset).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Items-per-page preference: read once, then track live changes from Settings.
  useEffect(() => {
    const clamp = (n: unknown) =>
      Math.min(ITEMS_PER_PAGE_MAX, Math.max(ITEMS_PER_PAGE_MIN, Math.floor(Number(n) || ITEMS_PER_PAGE_DEFAULT)));
    void browser.storage.local.get('itemsPerPage').then((o) => {
      if (o.itemsPerPage !== undefined) setPageSize(clamp(o.itemsPerPage));
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes.itemsPerPage) setPageSize(clamp(changes.itemsPerPage.newValue));
    };
    browser.storage.onChanged.addListener(onChanged as never);
    return () => browser.storage.onChanged.removeListener(onChanged as never);
  }, []);

  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  // Re-fetch when the active tab changes / finishes navigating.
  useEffect(() => {
    if (!authed) return;
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: { status?: string }, t: { active?: boolean }) => {
      if (info.status === 'complete' && t.active) void refresh();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [authed, refresh]);

  const onAuthed = (_user: PublicUser, token: string) => {
    void setToken(token).then(() => {
      setAuthed(true);
      void browser.runtime.sendMessage({ type: 'yandz:register-push' });
    });
  };

  // --- Row actions ---------------------------------------------------------
  const onVote = async (v: FeedItem, value: 1 | -1) => {
    if (v.myVote === value) return; // already voted this way — do nothing
    const tally = await Api.vote(v.id, value).catch(() => null);
    if (tally) setItems((xs) => xs.map((x) => (x.id === v.id ? { ...x, ...tally } : x)));
  };

  /** Apply / activate a version. Page versions apply in place (or navigate to their
   *  page); site/global versions are opted in (persisted) and then auto-apply. */
  const onApply = (v: FeedItem) => {
    if (v.scope === 'page') {
      setApplied((xs) => [...xs.filter((a) => a.scope !== 'page'), { scope: 'page', versionId: v.id, name: v.name }]);
      void applyVersionAnywhere(v.id, v.page.urlKey, currentPageKey);
      return;
    }
    void (async () => {
      const r = await Api.activate(v.id).catch(() => null);
      if (!r) return;
      // The new version replaces whatever held its scope slot.
      setAppliedItems((xs) => [v, ...xs.filter((x) => x.id !== v.id && x.id !== r.replacedVersionId)]);
      setApplied((xs) => [
        ...xs.filter((a) => a.scope !== v.scope && a.versionId !== r.replacedVersionId),
        { scope: v.scope, versionId: v.id, name: v.name },
      ]);
      await messageTab({ type: 'yandz:refresh-activations' });
    })();
  };

  /** Turn an applied version off from the bar. Page = transient (this view); site/global
   *  = deactivate the opt-in so it stops auto-applying. */
  const onToggleOff = (e: AppliedEntry) => {
    setApplied((xs) => xs.filter((a) => a.versionId !== e.versionId));
    if (e.scope === 'page') {
      void messageTab({ type: 'yandz:toggle-scope', scope: 'page', on: false });
    } else {
      setAppliedItems((xs) => xs.filter((x) => x.id !== e.versionId));
      void Api.deactivate(e.versionId).catch(() => {});
      void messageTab({ type: 'yandz:refresh-activations' });
    }
  };

  /** "View details" from the applied bar: open the version's read-only changes panel. */
  const onAppliedDetails = (e: AppliedEntry) => {
    const known = items.find((i) => i.id === e.versionId) ?? appliedItems.find((i) => i.id === e.versionId);
    if (known) {
      openDetails(known);
      return;
    }
    // Fallback: fetch the version and open it with minimal page context.
    void Api.getVersion(e.versionId)
      .then((v) => {
        const item: FeedItem = {
          id: v.id,
          name: v.name,
          author: { id: v.authorId, handle: '' },
          patches: v.patches,
          scope: v.scope,
          parentVersionId: v.parentVersionId,
          up: 0,
          down: 0,
          hotScore: 0,
          commentCount: 0,
          createdAt: '',
          page: { urlKey: currentPageKey ?? '', title: '' },
          bookmarked: false,
          myVote: 0,
          parentAuthor: null,
          parentName: null,
        };
        openDetails(item);
      })
      .catch(() => {});
  };

  const onToggleBookmark = async (v: FeedItem) => {
    const on = !v.bookmarked;
    await Api.toggleBookmark(v.id, on).catch(() => {});
    setItems((xs) =>
      filter === 'bookmarked' && !on
        ? xs.filter((x) => x.id !== v.id)
        : xs.map((x) => (x.id === v.id ? { ...x, bookmarked: on } : x)),
    );
  };

  const onShare = async (v: FeedItem) => {
    const res = await shareVersion(v.page.urlKey, v.id, v.name);
    if (res.method === 'copied') {
      setShareNote('Link copied');
      setTimeout(() => setShareNote(null), 2000);
    }
  };

  const onDelete = async (v: FeedItem) => {
    await Api.deleteVersion(v.id).catch(() => {});
    setItems((xs) => xs.filter((x) => x.id !== v.id));
    if (appliedIds.has(v.id)) {
      setApplied((xs) => xs.filter((a) => a.versionId !== v.id));
      void messageTab({ type: v.scope === 'page' ? 'yandz:revert' : 'yandz:refresh-activations' });
    }
  };

  /** Open the version panel (Comments + Changes tabs). Editable editor if you own
   *  the version, read-only otherwise; `tab` selects the initial tab. */
  const openVersionPanel = (v: FeedItem, tab: VersionTab) => {
    if (currentUserId && v.author.id === currentUserId)
      push({
        name: 'editor',
        editVersionId: v.id,
        editName: v.name,
        editScope: v.scope,
        editCommentCount: v.commentCount,
        initialTab: tab,
      });
    else push({ name: 'changes', version: v, initialTab: tab });
  };

  /** "See details": open the panel on the Changes tab. */
  const openDetails = (v: FeedItem) => openVersionPanel(v, 'changes');

  /** Start (or continue) an editing session with a tool. */
  const startTool = (tool: 'pick' | 'draw') => {
    if (view.name === 'editor') {
      void messageTab(
        tool === 'pick' ? { type: 'yandz:start-picker' } : { type: 'yandz:start-draw', color: '#e11' },
      );
    } else {
      // Decide what an edit session does, based on the PAGE version that's applied:
      //  - my own applied version → keep editing THAT version (no new version);
      //  - another user's applied version → new derivative (attributed);
      //  - nothing applied (original) → new version.
      const pageEntry = applied.find((a) => a.scope === 'page');
      const base = pageEntry
        ? items.find((i) => i.id === pageEntry.versionId) ?? appliedItems.find((i) => i.id === pageEntry.versionId)
        : undefined;
      const editingOwn = base && currentUserId && base.author.id === currentUserId;
      push({
        name: 'editor',
        ...(editingOwn
          ? { editVersionId: base!.id, editName: base!.name, editScope: base!.scope }
          : base
            ? { baseVersionId: base.id, baseAuthorHandle: base.author.handle, baseName: base.name }
            : {}),
        initialTool: tool,
      });
    }
  };

  if (authed === null) return <div className="app" />;
  if (!authed) return <AuthForm onAuthed={onAuthed} />;

  const webUrl = isWebUrl(url);
  const showSort = filter === 'all' || filter === 'following';

  return (
    <div className="app">
      <header className="header">
        <h1>Y and Z</h1>
        {/* Centered, bordered, labeled cluster of page-editing tools. */}
        <div className="edit-tools">
          <span className="edit-tools-label">Edit this page:</span>
          <button className="icon-btn" aria-label="Select an element to edit its text" title="Edit text" onClick={() => startTool('pick')}>
            <Type size={16} />
          </button>
          <button className="icon-btn" aria-label="Draw freehand on the page" title="Draw" onClick={() => startTool('draw')}>
            <Brush size={16} />
          </button>
        </div>
        <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => push({ name: 'settings' })}>
          <SettingsIcon size={16} />
        </button>
      </header>

      {view.name === 'feed' && (
        <>
          {/* Versions currently applied to the open page (all scopes), with toggles. */}
          {webUrl && <AppliedBar applied={applied} onToggleOff={onToggleOff} onDetails={onAppliedDetails} />}

          {/* Scope tabs: This page / This site / Global. Page/site need a real web page. */}
          <div className="tabs" role="tablist">
            {SCOPE_TABS.map((t) => {
              const disabled = !webUrl && t.key !== 'global';
              return (
                <button
                  key={t.key}
                  className="tab"
                  role="tab"
                  aria-selected={scope === t.key}
                  disabled={disabled}
                  title={disabled ? 'Open a web page to see its versions' : undefined}
                  onClick={() => setScope(t.key)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* In-tab filter chips + sort. */}
          <div className="feed-controls">
            <div className="pills">
              {FILTERS.map((f) => (
                <button key={f.key} className={`pill ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            {showSort && (
              <select className="sort-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as FeedSort)}>
                <option value="foryou">Your feed</option>
                <option value="latest">Latest</option>
              </select>
            )}
          </div>

          {shareNote && <div className="muted" style={{ margin: '6px 12px 0' }}>{shareNote}</div>}

          {/* Live search over the list: version title, page title, or u/username. */}
          <div className="search-bar">
            <input
              className="search-input"
              type="search"
              placeholder="Search versions, pages, or u/username"
              aria-label="Search the list"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <div className="list" ref={feed.listRef} onScroll={feed.onScroll}>
            {feed.loadingBefore && <p className="muted feed-sentinel">Loading…</p>}
            {items.map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                active={appliedIds.has(v.id)}
                currentUserId={currentUserId}
                onApply={onApply}
                onVote={onVote}
                onOpenProfile={(userId) => push({ name: 'profile', userId })}
                onOpenComments={(x) => openVersionPanel(x, 'comments')}
                onToggleBookmark={onToggleBookmark}
                onShare={onShare}
                onDelete={onDelete}
                onOpenChanges={(x) => openVersionPanel(x, 'changes')}
                onOpenDetails={openDetails}
              />
            ))}
            {feed.loadingAfter && items.length > 0 && <p className="muted feed-sentinel">Loading…</p>}
            {items.length === 0 &&
              !feed.loadingAfter &&
              (feed.error ? (
                <p className="error">Couldn’t load the feed: {feed.error}</p>
              ) : search ? (
                <p className="muted">No matches for “{search}”.</p>
              ) : (
                <p className="muted">
                  {filter === 'bookmarked'
                    ? 'No bookmarks in this scope yet.'
                    : filter === 'mine'
                      ? 'You haven’t made any versions in this scope yet.'
                      : 'No modifications to show.'}
                </p>
              ))}
          </div>
        </>
      )}

      {view.name === 'profile' && <Profile userId={view.userId} onClose={close} onOpenProfile={(userId) => push({ name: 'profile', userId })} onOpenComments={(v) => openVersionPanel(v, 'comments')} onOpenChanges={(v) => openVersionPanel(v, 'changes')} onOpenDetails={openDetails} onApply={onApply} currentPageKey={currentPageKey} currentHost={webUrl ? new URL(url!).hostname.toLowerCase() : null} currentUserId={currentUserId} />}
      {view.name === 'changes' && (
        <VersionChanges
          version={view.version}
          initialTab={view.initialTab}
          messageTab={messageTab}
          onClose={close}
          onOpenProfile={(userId) => push({ name: 'profile', userId })}
        />
      )}
      {view.name === 'settings' && (
        <Settings onOpenProfile={(userId) => push({ name: 'profile', userId })} onClose={close} messageTab={messageTab} onOpenChanges={openDetails} />
      )}
      {view.name === 'editor' && url && (
        <Editor
          url={url}
          pageTitle={pageTitle}
          editVersionId={view.editVersionId}
          editName={view.editName}
          editScope={view.editScope}
          commentCount={view.editCommentCount ?? 0}
          baseVersionId={view.baseVersionId}
          baseAuthorHandle={view.baseAuthorHandle}
          baseName={view.baseName}
          initialTab={view.initialTab}
          initialTool={view.initialTool}
          messageTab={messageTab}
          onSaved={async (newId, savedScope) => {
            await refresh();
            close();
            if (savedScope === 'page') {
              await messageTab({ type: 'yandz:apply-version', versionId: newId });
            } else {
              await Api.activate(newId).catch(() => {});
              await messageTab({ type: 'yandz:refresh-activations' });
              loadAppliedItems();
            }
          }}
          onClose={() => {
            close();
            void refresh();
          }}
          onOpenProfile={(userId) => push({ name: 'profile', userId })}
        />
      )}
    </div>
  );
}
