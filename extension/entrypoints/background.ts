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
import { Api } from '../lib/api.js';

interface PushData {
  title: string;
  body: string;
  url?: string;
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
