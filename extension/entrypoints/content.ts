/**
 * Content script — the in-page surface of Y and Z.
 *
 * On every page it:
 *  1. Fetches the ranked versions for the current URL.
 *  2. If versions exist, mounts a discrete floating icon (in a Shadow DOM so page
 *     CSS can't break it and it isn't itself a patch target).
 *  3. Applies the top-ranked version automatically AFTER a one-time per-origin
 *     consent (the apply model the user chose). Until consent, it only offers a
 *     prompt — it never silently mutates a page on first visit.
 *  4. Keeps patches applied across SPA/async DOM changes via a debounced
 *     MutationObserver.
 *  5. Hosts the element picker used by the editor (driven by panel messages).
 *
 * Runs at document_start; cssOverride patches apply before paint to avoid flash.
 */
import { defineContentScript } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import { Api, type VersionSummary } from '../lib/api.js';
import { PatchEngine } from '../lib/engine/applier.js';
import { fingerprintElement } from '../lib/engine/fingerprint.js';
import { mountFloatingIcon } from '../lib/ui/floating-icon.js';
import { startPicker } from '../lib/ui/picker.js';
import { OverlayRenderer } from '../lib/ui/overlay-renderer.js';
import { startDrawing } from '../lib/ui/draw-capture.js';

/** Capture the editable state of a picked element so the panel can prefill an editor. */
function elementSnapshot(el: Element): Record<string, unknown> {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  return {
    tagName: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').slice(0, 500),
    src: el instanceof HTMLImageElement ? el.src : undefined,
    attrs,
  };
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main(ctx) {
    const engine = new PatchEngine();
    const overlay = new OverlayRenderer();
    let current: VersionSummary | null = null;

    // Per-origin consent key for the auto-apply gate.
    const consentKey = `consent:${location.origin}`;
    const hasConsent = async (): Promise<boolean> =>
      ((await browser.storage.local.get(consentKey))[consentKey] as boolean) ?? false;

    /** Apply a version's patches (DOM mutations + visual overlay), replacing any current one. */
    function applyVersion(version: VersionSummary | null): void {
      engine.revertAll();
      overlay.clear();
      current = version;
      if (version) {
        engine.apply(version.patches);
        overlay.render(version.patches); // drawings + annotations
      }
    }

    // IMPORTANT: register the message listener and the MutationObserver
    // UNCONDITIONALLY (before any early exit), so the editor's "Pick element" /
    // "Draw" work even on pages that have no modifications yet — i.e. when you're
    // creating the very first version. Only the floating icon and auto-apply
    // depend on there being existing versions.

    // Re-apply on DOM churn (SPA navigations, lazy content). Debounced.
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (current) engine.apply(current.patches);
      });
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    ctx.onInvalidated(() => observer.disconnect());

    // Holds the fetched versions once loaded (null until then / on failure).
    let data: Awaited<ReturnType<typeof Api.getVersionsForUrl>> | null = null;

    // Messages from the side panel: switch version, revert, grant consent, pick, draw.
    browser.runtime.onMessage.addListener((msg: any) => {
      switch (msg?.type) {
        case 'yandz:apply-version': {
          const found = data?.versions.find((v) => v.id === msg.versionId);
          if (found) {
            applyVersion(found);
          } else {
            // A just-created version won't be in our cached list — re-fetch, then apply.
            void Api.getVersionsForUrl(location.href)
              .then((fresh) => {
                data = fresh;
                const v = fresh.versions.find((x) => x.id === msg.versionId);
                if (v) applyVersion(v);
              })
              .catch(() => {});
          }
          break;
        }
        case 'yandz:revert':
          applyVersion(null);
          break;
        case 'yandz:grant-consent':
          void browser.storage.local.set({ [consentKey]: true });
          if (data?.versions[0]) applyVersion(data.versions[0]);
          break;
        case 'yandz:start-picker':
          // Open the inspector; on selection, return the element's fingerprint and a
          // snapshot so the panel can open the right editor prefilled.
          startPicker((el) => {
            void browser.runtime.sendMessage({
              type: 'yandz:element-picked',
              target: fingerprintElement(el),
              snapshot: elementSnapshot(el),
            });
          });
          break;
        case 'yandz:start-draw':
          // Freehand draw over the page; on finish, send strokes anchored to <body>.
          startDrawing({
            color: msg.color,
            onFinish: (strokes) => {
              if (strokes.length === 0) return;
              void browser.runtime.sendMessage({
                type: 'yandz:drawing-captured',
                target: fingerprintElement(document.body),
                strokes,
              });
            },
          });
          break;
      }
    });

    // Fetch existing versions (best-effort; a failure or empty result just means
    // no floating icon / nothing to auto-apply — editing still works via the panel).
    try {
      data = await Api.getVersionsForUrl(location.href);
    } catch {
      return; // backend unreachable
    }
    if (!data || data.versions.length === 0) return;

    // Mount the floating icon with the version count.
    mountFloatingIcon({
      count: data.versions.length,
      onClick: () => browser.runtime.sendMessage({ type: 'yandz:open-panel' }),
    });

    // A "pending apply" flag (set when a profile card is clicked) takes priority:
    // apply that exact version once, regardless of consent, then clear the flag.
    const pendingKey = `pendingApply:${data.page.urlKey}`;
    const pendingId = (await browser.storage.local.get(pendingKey))[pendingKey] as string | undefined;
    if (pendingId) {
      await browser.storage.local.remove(pendingKey);
      const requested = data.versions.find((v) => v.id === pendingId);
      if (requested) applyVersion(requested);
      else if (await hasConsent()) applyVersion(data.versions[0]!);
    } else if (await hasConsent()) {
      // Otherwise auto-apply the top version only after one-time per-site consent.
      applyVersion(data.versions[0]!);
    }
  },
});
