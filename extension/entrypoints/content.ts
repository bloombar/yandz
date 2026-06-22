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
import type { PageVersions, VersionSummary } from '../lib/api.js';

/**
 * Fetch page versions via the background SW. A direct fetch from the content
 * script (page origin) to the loopback backend is blocked by Chrome's Private
 * Network Access; the background (extension context) can reach localhost.
 */
async function getVersions(url: string): Promise<PageVersions | null> {
  // Send the page's title so the server can backfill a missing Page.title.
  return (await browser.runtime.sendMessage({
    type: 'yandz:get-versions',
    url,
    title: document.title,
  })) as PageVersions | null;
}
import { PatchEngine } from '../lib/engine/applier.js';
import { fingerprintElement } from '../lib/engine/fingerprint.js';
import { matchTarget } from '../lib/engine/matcher.js';
import type { ElementTarget } from '@yandz/shared';

/** Briefly highlight (and scroll to) an element matched from a patch target. */
function flashHighlight(target: ElementTarget): void {
  const { element } = matchTarget(target);
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const r = element.getBoundingClientRect();
  const box = document.createElement('div');
  box.id = 'yandz-flash';
  box.style.cssText =
    `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
    'border:2px solid #4c9ffe;background:rgba(76,159,254,.2);border-radius:2px;' +
    'z-index:2147483646;pointer-events:none;transition:opacity .3s;';
  document.documentElement.appendChild(box);
  setTimeout(() => (box.style.opacity = '0'), 1200);
  setTimeout(() => box.remove(), 1600);
}
import { mountFloatingIcon } from '../lib/ui/floating-icon.js';
import { startPicker, hasOwnText } from '../lib/ui/picker.js';
import { OverlayRenderer } from '../lib/ui/overlay-renderer.js';
import { startDrawing } from '../lib/ui/draw-capture.js';
import { startInlineEdit, isInlineEditing } from '../lib/ui/inline-edit.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../lib/config.js';

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
    // Holds the fetched versions once loaded (null until then / on failure).
    let data: PageVersions | null = null;
    // Stops the active page-side tool (drawing), so it can be torn down when the
    // editor closes or another tool starts.
    let activeStop: (() => void) | null = null;

    // Per-origin consent key for the auto-apply gate.
    const consentKey = `consent:${location.origin}`;
    const hasConsent = async (): Promise<boolean> =>
      ((await browser.storage.local.get(consentKey))[consentKey] as boolean) ?? false;

    /** Record which version (if any) is currently applied to this page so the side
     *  panel can highlight it — including versions auto-applied on load, before the
     *  panel was open/authenticated. Persisted to shared session storage (reliable
     *  regardless of message timing) and also broadcast for live updates. */
    function notifyApplied(): void {
      const urlKey = data?.page.urlKey;
      if (urlKey) void browser.storage.session.set({ [`applied:${urlKey}`]: current?.id ?? null }).catch(() => {});
      void browser.runtime
        .sendMessage({ type: 'yandz:applied', urlKey: urlKey ?? null, versionId: current?.id ?? null })
        .catch(() => {});
    }

    /** Apply a version's patches (DOM mutations + visual overlay), replacing any current one. */
    function applyVersion(version: VersionSummary | null): void {
      engine.revertAll();
      overlay.clear();
      current = version;
      if (version) {
        engine.apply(version.patches);
        overlay.render(version.patches); // drawings + annotations
      }
      notifyApplied();
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
        // Don't fight the user's in-place typing by re-applying patches over it.
        if (current && !isInlineEditing()) engine.apply(current.patches);
      });
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    ctx.onInvalidated(() => observer.disconnect());

    // Messages from the side panel: switch version, revert, grant consent, pick, draw.
    browser.runtime.onMessage.addListener((msg: any) => {
      switch (msg?.type) {
        case 'yandz:apply-version': {
          const found = data?.versions.find((v) => v.id === msg.versionId);
          if (found) {
            applyVersion(found);
          } else {
            // A just-created version won't be in our cached list — re-fetch, then apply.
            void getVersions(location.href)
              .then((fresh) => {
                if (!fresh) return;
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
        case 'yandz:stop-tools':
          // Editor closed (or switched away) — tear down any active drawing layer.
          activeStop?.();
          activeStop = null;
          break;
        case 'yandz:highlight-element':
          // Clicking a change in the editor flashes its element on the page.
          flashHighlight(msg.target);
          break;
        case 'yandz:get-applied':
          // The panel asks which version is currently applied (to highlight it).
          return Promise.resolve(current?.id ?? null);
        case 'yandz:start-picker':
          activeStop?.(); // stop any active drawing first
          activeStop = null;
          // Open the inspector. If the picked element has its own text, edit it
          // IN PLACE on the page and send the resulting textReplace patch. For
          // textless elements, fall back to the sidebar editor (CSS/attr/image).
          startPicker((el) => {
            if (hasOwnText(el)) {
              startInlineEdit(el, {
                onCommit: ({ from, to }) => {
                  void browser.runtime.sendMessage({
                    type: 'yandz:text-edited',
                    target: fingerprintElement(el),
                    payload: { from, to },
                  });
                },
              });
            } else {
              void browser.runtime.sendMessage({
                type: 'yandz:element-picked',
                target: fingerprintElement(el),
                snapshot: elementSnapshot(el),
              });
            }
          });
          break;
        case 'yandz:start-draw':
          // Freehand draw over the page. Strokes auto-emit after a pause (debounced)
          // and on stop, anchored to <body>, so the drawing is saved without an
          // explicit "finish" step.
          activeStop?.(); // replace any prior drawing session
          activeStop = startDrawing({
            color: msg.color,
            debounceMs: AUTOSAVE_DEBOUNCE_MS,
            // The drawing is anchored to the element the user drew on; fingerprint it
            // so the overlay renders relative to that element (tracking it on scroll).
            onStrokes: (strokes, target) => {
              if (strokes.length === 0) return;
              void browser.runtime.sendMessage({
                type: 'yandz:drawing-captured',
                target: fingerprintElement(target),
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
      data = await getVersions(location.href);
    } catch {
      return; // backend unreachable
    }
    if (!data || data.versions.length === 0) return;

    // Mount the floating icon with the version count.
    mountFloatingIcon({
      count: data.versions.length,
      onClick: () => browser.runtime.sendMessage({ type: 'yandz:open-panel' }),
    });

    // A shared link (`#yandz-v=<id>`) or a "pending apply" flag (set when a profile/
    // feed row is clicked) takes priority: apply that exact version once, regardless
    // of consent. The hash form lets a shared link auto-apply for any recipient.
    const hashMatch = location.hash.match(/yandz-v=([a-f0-9]+)/i);
    const pendingKey = `pendingApply:${data.page.urlKey}`;
    const pendingId =
      hashMatch?.[1] ?? ((await browser.storage.local.get(pendingKey))[pendingKey] as string | undefined);
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
