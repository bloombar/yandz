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
import React, { useCallback, useEffect, useState } from 'react';
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
  const [sort, setSort] = useState<'hot' | 'top' | 'new'>('hot');
  const [view, setView] = useState<View>({ name: 'versions' });
  const [consented, setConsented] = useState(true);
  // The version to highlight as selected in the list (e.g. just after saving).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** Send a message to the content script in the active tab. */
  const messageTab = useCallback(async (payload: unknown) => {
    const { id } = await getActiveTab();
    if (id !== undefined) await browser.tabs.sendMessage(id, payload).catch(() => {});
  }, []);

  useEffect(() => {
    void getToken().then((t) => setAuthed(!!t));
  }, []);

  const refresh = useCallback(async () => {
    const tab = await getActiveTab();
    setUrl(tab.url);
    if (!tab.url) return;
    try {
      const data = await Api.getVersionsForUrl(tab.url, sort);
      setVersions(data.versions);
    } catch {
      setVersions([]);
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
        {view.name === 'versions' && (
          <>
            <button className="btn" onClick={() => setView({ name: 'editor' })}>
              Edit
            </button>
            <button className="btn" aria-label="Settings" onClick={() => setView({ name: 'settings' })}>
              <SettingsIcon size={14} />
            </button>
          </>
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
            {(['hot', 'top', 'new'] as const).map((s) => (
              <button key={s} className="tab" role="tab" aria-selected={sort === s} onClick={() => setSort(s)}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="list">
            <VersionList
              versions={versions}
              selectedId={selectedId}
              onVote={onVote}
              onApply={(v) => messageTab({ type: 'yandz:apply-version', versionId: v.id })}
              onRevert={() => messageTab({ type: 'yandz:revert' })}
              onOpenProfile={(userId) => setView({ name: 'profile', userId })}
              onOpenComments={(v) => setView({ name: 'comments', versionId: v.id })}
              onFork={(v) => setView({ name: 'editor', baseVersionId: v.id })}
            />
            {versions.length === 0 && <p className="muted">No modifications yet for this page.</p>}
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
          onClose={() => setView({ name: 'versions' })}
        />
      )}
    </div>
  );
}
