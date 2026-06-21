/**
 * Side panel root. Renders the global feeds (For you / Latest / Bookmarks) with an
 * All ↔ This page scope toggle, and orchestrates a navigation STACK of panels
 * (profile / comments / editor / settings) where closing pops back to the previous
 * view. The top nav holds icon tools (select element, draw) that start an editing
 * session, plus settings.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon, MousePointerClick, Pencil } from 'lucide-react';
import { browser } from 'wxt/browser';
import {
  Api,
  getToken,
  setToken,
  type FeedItem,
  type FeedScope,
  type FeedSort,
  type PublicUser,
} from '../../lib/api.js';
import { applyVersionAnywhere } from '../../lib/apply.js';
import { shareVersion } from '../../lib/share.js';
import { AuthForm } from './components/AuthForm.js';
import { VersionRow } from './components/VersionRow.js';
import { Profile } from './components/Profile.js';
import { Comments } from './components/Comments.js';
import { Editor } from './components/Editor.js';
import { Settings } from './components/Settings.js';

type View =
  | { name: 'feed' }
  | { name: 'profile'; userId: string }
  | { name: 'comments'; versionId: string }
  | { name: 'editor'; baseVersionId?: string; initialTool?: 'pick' | 'draw' }
  | { name: 'settings' };

type TabKey = 'foryou' | 'latest' | 'bookmarks';

async function getActiveTab(): Promise<{ id?: number; url?: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url };
}

/** Whether a URL is a normal web page (content scripts + this-page scope apply). */
function isWebUrl(url?: string): boolean {
  return !!url && /^https?:\/\//.test(url);
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [tab, setTab] = useState<TabKey>('foryou');
  const [scope, setScope] = useState<FeedScope>('all');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [currentPageKey, setCurrentPageKey] = useState<string | null>(null);
  const [consented, setConsented] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

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

  useEffect(() => {
    void getToken()
      .then((t) => setAuthed(!!t))
      .catch(() => setAuthed(false));
  }, []);

  const lastUrlRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const active = await getActiveTab();
    if (active.url !== lastUrlRef.current) {
      lastUrlRef.current = active.url;
      setSelectedId(null);
    }
    setUrl(active.url);
    // "This page" only applies to real web pages; otherwise force global.
    const effScope: FeedScope = scope === 'page' && isWebUrl(active.url) ? 'page' : 'all';
    try {
      const result =
        tab === 'bookmarks'
          ? await Api.getBookmarksFeed(effScope, active.url)
          : await Api.getFeed(tab as FeedSort, effScope, active.url);
      setItems(result.versions);
      setCurrentPageKey(result.currentPageKey);
      setListError(null);
    } catch (err) {
      setItems([]);
      setListError((err as Error).message || 'Could not reach the server');
    }
    if (isWebUrl(active.url)) {
      try {
        const key = `consent:${new URL(active.url!).origin}`;
        setConsented(!!(await browser.storage.local.get(key))[key]);
      } catch {
        /* opaque origin */
      }
    }
  }, [tab, scope]);

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

  const grantConsent = async () => {
    if (isWebUrl(url)) {
      try {
        await browser.storage.local.set({ [`consent:${new URL(url!).origin}`]: true });
      } catch {
        /* opaque origin */
      }
    }
    await messageTab({ type: 'yandz:grant-consent' });
    setConsented(true);
  };

  /** Start (or continue) an editing session with a tool. */
  const startTool = (tool: 'pick' | 'draw') => {
    if (view.name === 'editor') {
      void messageTab(
        tool === 'pick' ? { type: 'yandz:start-picker' } : { type: 'yandz:start-draw', color: '#e11' },
      );
    } else {
      push({ name: 'editor', baseVersionId: selectedId ?? undefined, initialTool: tool });
    }
  };

  if (authed === null) return <div className="app" />;
  if (!authed) return <AuthForm onAuthed={onAuthed} />;

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'foryou', label: 'For you' },
    { key: 'latest', label: 'Latest' },
    { key: 'bookmarks', label: 'Bookmarks' },
  ];

  return (
    <div className="app">
      <header className="header">
        <h1>Y and Z</h1>
        {/* Centered, bordered, labeled cluster of page-editing tools. */}
        <div className="edit-tools">
          <span className="edit-tools-label">Edit this page:</span>
          <button className="icon-btn" aria-label="Select an element to edit" title="Select an element" onClick={() => startTool('pick')}>
            <MousePointerClick size={16} />
          </button>
          <button className="icon-btn" aria-label="Draw on the page" title="Draw" onClick={() => startTool('draw')}>
            <Pencil size={16} />
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

          {/* All ↔ This page scope toggle, only when a real web page is open. */}
          {isWebUrl(url) && (
            <div className="scope-toggle">
              {(['all', 'page'] as const).map((s) => (
                <button key={s} className={`pill ${scope === s ? 'active' : ''}`} onClick={() => setScope(s)}>
                  {s === 'all' ? 'All' : 'This page'}
                </button>
              ))}
            </div>
          )}

          {!consented && isWebUrl(url) && items.some((v) => v.page.urlKey === currentPageKey) && (
            <div className="banner">
              Other users have modified this page. Apply the top version on this site?
              <div style={{ marginTop: 6 }}>
                <button className="btn primary" onClick={grantConsent}>
                  Apply &amp; remember for {new URL(url!).host}
                </button>
              </div>
            </div>
          )}

          {selectedId && (
            <button
              className="btn"
              style={{ margin: '8px 12px 0' }}
              onClick={() => {
                setSelectedId(null);
                void messageTab({ type: 'yandz:revert' });
              }}
            >
              Revert to original
            </button>
          )}
          {shareNote && <div className="muted" style={{ margin: '6px 12px 0' }}>{shareNote}</div>}

          <div className="list">
            {items.map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                active={v.id === selectedId}
                onApply={onApply}
                onVote={onVote}
                onOpenProfile={(userId) => push({ name: 'profile', userId })}
                onOpenComments={(x) => push({ name: 'comments', versionId: x.id })}
                onToggleBookmark={onToggleBookmark}
                onShare={onShare}
              />
            ))}
            {items.length === 0 &&
              (listError ? (
                <p className="error">Couldn’t load the feed: {listError}</p>
              ) : (
                <p className="muted">
                  {tab === 'bookmarks' ? 'No bookmarks yet.' : 'No modifications to show.'}
                </p>
              ))}
          </div>
        </>
      )}

      {view.name === 'profile' && <Profile userId={view.userId} onClose={close} onOpenProfile={(userId) => push({ name: 'profile', userId })} onOpenComments={(id) => push({ name: 'comments', versionId: id })} currentPageKey={currentPageKey} />}
      {view.name === 'comments' && <Comments versionId={view.versionId} onClose={close} />}
      {view.name === 'settings' && (
        <Settings onOpenProfile={(userId) => push({ name: 'profile', userId })} onClose={close} />
      )}
      {view.name === 'editor' && url && (
        <Editor
          url={url}
          baseVersionId={view.baseVersionId}
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
        />
      )}
    </div>
  );
}
