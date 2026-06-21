/**
 * Side panel root. Orchestrates navigation between views and bridges to the active
 * tab's content script:
 *  - versions: ranked list for the active URL (vote / apply / revert / fork / comment).
 *  - editor: build & save a new version or a fork.
 *  - comments: real-time threaded board for a version.
 *  - profile / settings: social graph.
 *
 * After sign-in it asks the background SW to register for push, and reflects the
 * per-origin auto-apply consent in a banner.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api, getToken, setToken, type VersionSummary, type PublicUser } from '../../lib/api.js';
import { AuthForm } from './components/AuthForm.js';
import { VersionList } from './components/VersionList.js';
import { Profile } from './components/Profile.js';
import { Comments } from './components/Comments.js';
import { Editor } from './components/Editor.js';
import { Settings } from './components/Settings.js';

type View =
  | { name: 'versions' }
  | { name: 'profile'; userId: string }
  | { name: 'comments'; versionId: string }
  | { name: 'editor'; baseVersionId?: string }
  | { name: 'settings' };

/** Get the active tab's URL + id so we can scope versions and message the page. */
async function getActiveTab(): Promise<{ id?: number; url?: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url };
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [sort, setSort] = useState<'foryou' | 'latest'>('foryou');
  const [view, setView] = useState<View>({ name: 'versions' });
  const [consented, setConsented] = useState(true);
  // The version to highlight as selected in the list (e.g. just after saving).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Surfaces why the list is empty (fetch error) instead of silently blanking.
  const [listError, setListError] = useState<string | null>(null);

  /**
   * Send a message to the content script in the active tab. Returns false if the
   * content script isn't reachable (e.g. the page was open before the extension
   * (re)loaded and needs a refresh, or it's a chrome:// / store page where content
   * scripts can't run) so callers can show actionable guidance.
   */
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
    // Always resolve auth state — never leave the panel stuck on the blank
    // (authed === null) screen if storage access throws.
    void getToken()
      .then((t) => setAuthed(!!t))
      .catch(() => setAuthed(false));
  }, []);

  // Tracks the last URL we loaded, so a tab/page change clears the applied-version
  // selection (the applied modification is page-specific).
  const lastUrlRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const tab = await getActiveTab();
    if (tab.url !== lastUrlRef.current) {
      lastUrlRef.current = tab.url;
      setSelectedId(null);
    }
    setUrl(tab.url);
    if (!tab.url) {
      setVersions([]);
      setListError(null);
      return;
    }
    try {
      const data = await Api.getVersionsForUrl(tab.url, sort);
      setVersions(data.versions);
      setListError(null);
    } catch (err) {
      setVersions([]);
      setListError((err as Error).message || 'Could not reach the server');
    }
    try {
      const origin = new URL(tab.url).origin;
      const key = `consent:${origin}`;
      setConsented(!!(await browser.storage.local.get(key))[key]);
    } catch {
      /* file:// or opaque origin */
    }
  }, [sort]);

  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  // Re-fetch the list whenever the user switches tabs or the active tab finishes
  // navigating — otherwise the panel stays stuck on whatever it loaded at mount
  // (e.g. an empty result from a blank tab after a restart).
  useEffect(() => {
    if (!authed) return;
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: { status?: string }, tab: { active?: boolean }) => {
      if (info.status === 'complete' && tab.active) void refresh();
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
      // Register for push now that we have a token.
      void browser.runtime.sendMessage({ type: 'yandz:register-push' });
    });
  };

  const onVote = async (v: VersionSummary, value: 1 | -1) => {
    const tally = await Api.vote(v.id, value).catch(() => null);
    if (tally) setVersions((vs) => vs.map((x) => (x.id === v.id ? { ...x, ...tally } : x)));
  };

  const grantConsent = async () => {
    // Persist consent from the panel itself (not only via the content script,
    // which may have bailed out early if the backend was unreachable on load),
    // so it survives sort/tab switches and future page loads.
    const tab = await getActiveTab();
    if (tab.url) {
      try {
        const origin = new URL(tab.url).origin;
        await browser.storage.local.set({ [`consent:${origin}`]: true });
      } catch {
        /* opaque origin (e.g. file://) — skip persistence */
      }
    }
    await messageTab({ type: 'yandz:grant-consent' });
    setConsented(true);
  };

  if (authed === null) return <div className="app" />;
  if (!authed) return <AuthForm onAuthed={onAuthed} />;

  return (
    <div className="app">
      <header className="header">
        <h1>Y and Z</h1>
        {view.name !== 'versions' && (
          <button className="btn" onClick={() => setView({ name: 'versions' })}>
            ← Back
          </button>
        )}
        {/* Edit is always available (except while already editing). If a modification
            is currently applied, Edit forks it; otherwise it starts a new version. */}
        {view.name !== 'editor' && (
          <button
            className="btn"
            onClick={() => setView({ name: 'editor', baseVersionId: selectedId ?? undefined })}
          >
            {selectedId ? 'Edit (fork)' : 'Edit'}
          </button>
        )}
        {view.name === 'versions' && (
          <button className="btn" aria-label="Settings" onClick={() => setView({ name: 'settings' })}>
            <SettingsIcon size={14} />
          </button>
        )}
      </header>

      {view.name === 'versions' && (
        <>
          {/* Page-level consent prompt — shown once above the tabs (not per tab). */}
          {!consented && versions.length > 0 && (
            <div className="banner">
              Other users have modified this page. Apply the top version on this site?
              <div style={{ marginTop: 6 }}>
                <button className="btn primary" onClick={grantConsent}>
                  Apply &amp; remember for {url ? new URL(url).host : 'this site'}
                </button>
              </div>
            </div>
          )}
          <div className="tabs" role="tablist">
            {([
              { key: 'foryou', label: 'For you' },
              { key: 'latest', label: 'Latest' },
            ] as const).map((t) => (
              <button
                key={t.key}
                className="tab"
                role="tab"
                aria-selected={sort === t.key}
                onClick={() => setSort(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="list">
            <VersionList
              versions={versions}
              selectedId={selectedId}
              onVote={onVote}
              onApply={(v) => {
                setSelectedId(v.id);
                void messageTab({ type: 'yandz:apply-version', versionId: v.id });
              }}
              onRevert={() => {
                setSelectedId(null);
                void messageTab({ type: 'yandz:revert' });
              }}
              onOpenProfile={(userId) => setView({ name: 'profile', userId })}
              onOpenComments={(v) => setView({ name: 'comments', versionId: v.id })}
            />
            {versions.length === 0 &&
              (listError ? (
                <p className="error">Couldn’t load modifications: {listError}</p>
              ) : (
                <p className="muted">
                  No modifications yet for {url ? new URL(url).host : 'this page'}.
                </p>
              ))}
          </div>
        </>
      )}

      {view.name === 'profile' && <Profile userId={view.userId} onClose={() => setView({ name: 'versions' })} />}
      {view.name === 'comments' && (
        <Comments versionId={view.versionId} onClose={() => setView({ name: 'versions' })} />
      )}
      {view.name === 'settings' && (
        <Settings
          onOpenProfile={(userId) => setView({ name: 'profile', userId })}
          onClose={() => setView({ name: 'versions' })}
        />
      )}
      {view.name === 'editor' && url && (
        <Editor
          url={url}
          baseVersionId={view.baseVersionId}
          messageTab={messageTab}
          onSaved={async (newId) => {
            // Return to the list, refresh it, then select + apply the new version.
            await refresh();
            setSelectedId(newId);
            setView({ name: 'versions' });
            await messageTab({ type: 'yandz:apply-version', versionId: newId });
          }}
          onClose={() => {
            // Auto-save may have already persisted a version; refresh so it shows.
            setView({ name: 'versions' });
            void refresh();
          }}
        />
      )}
    </div>
  );
}
