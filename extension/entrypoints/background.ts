/**
 * Background service worker. Responsibilities:
 *  - Configure the toolbar action to open the side panel (Chromium).
 *  - Open the panel when the in-page floating icon asks (via runtime message).
 *  - Receive Web Push events and surface them as OS notifications; clicking a
 *    notification opens the relevant page.
 *
 * Engine-agnostic: all surface differences are delegated to lib/browser-surface.
 */
import { defineBackground } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import { configurePanelBehavior, openPanel } from '../lib/browser-surface.js';
import { registerPush } from '../lib/push.js';
import { Api, getToken } from '../lib/api.js';

interface PushData {
  title: string;
  body: string;
  url?: string;
}

/**
 * Fetch a (possibly loopback/http) asset and return it as a base64 `data:` URL.
 * Runs in the service worker, which can reach loopback and isn't subject to the
 * page's mixed-content rules. `FileReader` isn't available in SWs, so we encode
 * via `btoa` over the bytes (chunked to avoid call-stack limits on large images).
 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return `data:${contentType};base64,${btoa(binary)}`;
}

export default defineBackground(() => {
  // On install/startup, make the action click open the panel (Chromium).
  configurePanelBehavior();

  // Allow content scripts to read storage.session (where the auth token lives) so
  // their API calls can be authenticated. Defaults to trusted-only otherwise.
  const session = (browser.storage as { session?: { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } })
    .session;
  void session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

  // The content-script floating icon posts this to toggle the panel.
  browser.runtime.onMessage.addListener((msg: unknown, sender: { tab?: { windowId?: number } }) => {
    const m = msg as { type?: string; url?: string; title?: string };
    if (m?.type === 'yandz:open-panel') {
      void openPanel(sender.tab?.windowId);
    } else if (m?.type === 'yandz:register-push') {
      // Panel fires this after sign-in; subscribe the SW to push and register it.
      void registerPush();
    } else if (m?.type === 'yandz:get-versions' && m.url) {
      // Proxy the page-versions fetch for content scripts: a content script runs in
      // the page's origin and Chrome's Private Network Access blocks it from reaching
      // a loopback backend (localhost). The background runs in the extension context
      // and can. Returning a Promise responds to the sender.
      return Api.getVersionsForUrl(m.url, 'foryou', m.title).catch(() => null);
    } else if (m?.type === 'yandz:fetch-asset' && m.url) {
      // Proxy a swapped-image fetch for the SAME reason: the page can't load an asset
      // hosted on loopback (PNA) or an http asset on an https page (mixed content).
      // The background fetches it and returns a data: URL the page can render inline.
      return fetchAsDataUrl(m.url).catch(() => null);
    } else if (m?.type === 'yandz:get-activations' && m.url) {
      // The viewer's opted-in site/global versions to auto-apply on this URL. Proxied
      // (PNA) and authenticated (the background holds the session token). Skip the
      // request entirely when logged out (avoids a 401 on every page load).
      const u = m.url;
      return getToken().then((t) =>
        t
          ? Api.getActivations(u)
              .then((r) => r.versions)
              .catch(() => [])
          : [],
      );
    }
    return undefined;
  });

  // Web Push delivery (Chromium): wake → show a notification. The SW push event
  // type isn't in the default libs here, so we read it structurally.
  self.addEventListener('push', (event: Event) => {
    const pushEvent = event as Event & { data?: { json(): unknown } };
    let data: PushData = { title: 'Y and Z', body: 'New activity' };
    try {
      if (pushEvent.data) data = pushEvent.data.json() as PushData;
    } catch {
      /* keep default */
    }
    void browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png' as never),
      title: data.title,
      message: data.body,
      // Stash the target URL so the click handler can open it.
      contextMessage: data.url ?? '',
    });
  });

  // Open the page associated with a clicked notification.
  browser.notifications.onClicked.addListener(async (id) => {
    const all = await browser.notifications.getAll();
    void id;
    void all;
    // (URL is carried in contextMessage; a production build would map id→url in
    // storage. Kept minimal here.)
  });
});
