/**
 * Side panel root. Renders the global feeds (For you / Latest / Bookmarks) with an
 * All ↔ This page scope toggle, and orchestrates a navigation STACK of panels
 * (profile / comments / editor / settings) where closing pops back to the previous
 * view. The top nav holds icon tools (select element, draw) that start an editing
 * session, plus settings.
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
  type FeedSort,
  type PublicUser,
} from '../../lib/api.js';
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
      // Deriving from another user's version (creates a new attributed version).
      baseVersionId?: string;
      baseAuthorHandle?: string;
      baseName?: string;
      initialTab?: VersionTab;
      initialTool?: 'pick' | 'draw';
    }
  | { name: 'settings' };

type TabKey = 'foryou' | 'latest' | 'byyou' | 'bookmarks';

async function getActiveTab(): Promise<{ id?: number; url?: string; title?: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url, title: tab?.title };
}

/** Whether a URL is a normal web page (content scripts + this-page scope apply). */
function isWebUrl(url?: string): boolean {
  return !!url && /^https?:\/\//.test(url);
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [pageTitle, setPageTitle] = useState<string | undefined>();
  const [tab, setTab] = useState<TabKey>('foryou');
  const [scope, setScope] = useState<FeedScope>('all');
  const [currentPageKey, setCurrentPageKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  /** Ask the active tab's content script which version is currently applied. */
  const queryApplied = useCallback(async (): Promise<string | null> => {
    const { id } = await getActiveTab();
    if (id === undefined) return null;
    try {
      return (await browser.tabs.sendMessage(id, { type: 'yandz:get-applied' })) as string | null;
    } catch {
      return null;
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

  // One page of the active feed (tab/scope/url/search), for the windowed list.
  const fetchPage = useCallback(
    (offset: number, limit: number): Promise<FeedResult> => {
      const effScope: FeedScope = scope === 'page' && isWebUrl(url) ? 'page' : 'all';
      if (tab === 'bookmarks') return Api.getBookmarksFeed(effScope, url, search, offset, limit);
      if (tab === 'byyou') return Api.getMyFeed(effScope, url, search, offset, limit);
      return Api.getFeed(tab as FeedSort, effScope, url, search, offset, limit);
    },
    [tab, scope, url, search],
  );

  // After the first page loads: surface currentPageKey and reflect whatever the content
  // script currently has applied on the page (from shared session storage, else query).
  const onFirstPage = useCallback(
    (res: FeedResult) => {
      setCurrentPageKey(res.currentPageKey);
      void (async () => {
        if (res.currentPageKey) {
          const k = `applied:${res.currentPageKey}`;
          const obj = (await browser.storage.session.get(k).catch(() => ({}))) as Record<string, unknown>;
          const stored = obj[k] as string | null | undefined;
          setSelectedId(stored !== undefined ? (stored ?? null) : await queryApplied());
        } else {
          setSelectedId(await queryApplied());
        }
      })();
    },
    [queryApplied],
  );

  const feed = useWindowedFeed({
    fetchPage,
    pageSize,
    windowPages: FEED_WINDOW_PAGES,
    thresholdPx: FEED_SCROLL_THRESHOLD_PX,
    resetKey: `${tab}|${scope}|${search}|${url ?? ''}|${pageSize}`,
    enabled: authed === true,
    onFirstPage,
  });
  const items = feed.items;
  const setItems = feed.mutate; // in-place window updates (vote/delete/bookmark)

  // Reflect late auto-applies: the content script broadcasts the applied version
  // when a page loads, which may arrive after our initial query.
  useEffect(() => {
    const listener = (msg: { type?: string; urlKey?: string | null; versionId?: string | null }) => {
      if (msg?.type === 'yandz:applied' && (!msg.urlKey || msg.urlKey === currentPageKeyRef.current)) {
        setSelectedId(msg.versionId ?? null);
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

  const onApply = (v: FeedItem) => {
    setSelectedId(v.id);
    void applyVersionAnywhere(v.id, v.page.urlKey, currentPageKey);
  };

  const onToggleBookmark = async (v: FeedItem) => {
    const on = !v.bookmarked;
    await Api.toggleBookmark(v.id, on).catch(() => {});
    setItems((xs) =>
      tab === 'bookmarks' && !on
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
    if (selectedId === v.id) {
      setSelectedId(null);
      void messageTab({ type: 'yandz:revert' });
    }
  };

  /** Open the version panel (Comments + Changes tabs). Editable editor if you own
   *  the version, read-only otherwise; `tab` selects the initial tab. */
  const openVersionPanel = (v: FeedItem, tab: VersionTab) => {
    if (currentUserId && v.author.id === currentUserId)
      push({ name: 'editor', editVersionId: v.id, editName: v.name, initialTab: tab });
    else push({ name: 'changes', version: v, initialTab: tab });
  };

  /** "See details": open the panel defaulting to Comments if any exist, else Changes. */
  const openDetails = (v: FeedItem) => openVersionPanel(v, v.commentCount > 0 ? 'comments' : 'changes');

  /** Start (or continue) an editing session with a tool. */
  const startTool = (tool: 'pick' | 'draw') => {
    if (view.name === 'editor') {
      void messageTab(
        tool === 'pick' ? { type: 'yandz:start-picker' } : { type: 'yandz:start-draw', color: '#e11' },
      );
    } else {
      // Decide what an edit session does, based on what's applied:
      //  - my own applied version → keep editing THAT version (no new version);
      //  - another user's applied version → new derivative (attributed);
      //  - nothing applied (original) → new version.
      const base = selectedId ? items.find((i) => i.id === selectedId) : undefined;
      const editingOwn = base && currentUserId && base.author.id === currentUserId;
      push({
        name: 'editor',
        ...(editingOwn
          ? { editVersionId: base!.id, editName: base!.name }
          : base
            ? { baseVersionId: base.id, baseAuthorHandle: base.author.handle, baseName: base.name }
            : {}),
        initialTool: tool,
      });
    }
  };

  if (authed === null) return <div className="app" />;
  if (!authed) return <AuthForm onAuthed={onAuthed} />;

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'foryou', label: 'For you' },
    { key: 'latest', label: 'Latest' },
    { key: 'byyou', label: 'By you' },
    { key: 'bookmarks', label: 'Bookmarks' },
  ];

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
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} className="tab" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* All ↔ This page scope toggle (left) + applied-state control (right),
              only when a real web page is open. */}
          {isWebUrl(url) && (
            <div className="scope-toggle">
              <div className="pills">
                {(['all', 'page'] as const).map((s) => (
                  <button key={s} className={`pill ${scope === s ? 'active' : ''}`} onClick={() => setScope(s)}>
                    {s === 'all' ? 'All' : 'This page'}
                  </button>
                ))}
              </div>
              {selectedId ? (
                <span
                  className="revert-link"
                  role="button"
                  title="Revert to the original page"
                  onClick={() => {
                    setSelectedId(null);
                    void messageTab({ type: 'yandz:revert' });
                  }}
                >
                  Revert to original
                </span>
              ) : (
                <span className="muted">Showing original</span>
              )}
            </div>
          )}

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
                active={v.id === selectedId}
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
                  {tab === 'bookmarks'
                    ? 'No bookmarks yet.'
                    : tab === 'byyou'
                      ? 'You haven’t made any versions yet.'
                      : 'No modifications to show.'}
                </p>
              ))}
          </div>
        </>
      )}

      {view.name === 'profile' && <Profile userId={view.userId} onClose={close} onOpenProfile={(userId) => push({ name: 'profile', userId })} onOpenComments={(v) => openVersionPanel(v, 'comments')} onOpenChanges={(v) => openVersionPanel(v, 'changes')} onOpenDetails={openDetails} currentPageKey={currentPageKey} currentUserId={currentUserId} />}
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
        <Settings onOpenProfile={(userId) => push({ name: 'profile', userId })} onClose={close} messageTab={messageTab} />
      )}
      {view.name === 'editor' && url && (
        <Editor
          url={url}
          pageTitle={pageTitle}
          editVersionId={view.editVersionId}
          editName={view.editName}
          baseVersionId={view.baseVersionId}
          baseAuthorHandle={view.baseAuthorHandle}
          baseName={view.baseName}
          initialTab={view.initialTab}
          initialTool={view.initialTool}
          messageTab={messageTab}
          onSaved={async (newId) => {
            await refresh();
            setSelectedId(newId);
            close();
            await messageTab({ type: 'yandz:apply-version', versionId: newId });
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
