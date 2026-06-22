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

/** The viewer's own site/global-scoped patches to auto-apply on this URL (via background). */
async function getMyPatches(url: string): Promise<AnyPatch[]> {
  try {
    const res = (await browser.runtime.sendMessage({ type: 'yandz:get-my-patches', url })) as AnyPatch[] | null;
    return res ?? [];
  } catch {
    return [];
  }
}
import { PatchEngine } from '../lib/engine/applier.js';
import { fingerprintElement } from '../lib/engine/fingerprint.js';
import { matchTarget } from '../lib/engine/matcher.js';
import type { AnyPatch, ElementTarget } from '@yandz/shared';

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

/**
 * Resolve an imageSwap asset URL into something the PAGE can actually load.
 *
 * In dev, swapped images live on a loopback/private host (local MinIO); the page
 * origin can't fetch those (Private Network Access), and an http asset on an https
 * page is mixed content. Both are blocked. We proxy such URLs through the background
 * (extension context, which CAN reach loopback) and inline the bytes as a `data:`
 * URL, which bypasses PNA and mixed-content entirely. Public https CDN URLs (prod)
 * are loaded directly. Results are cached per URL so DOM-churn re-applies are cheap.
 */
const assetCache = new Map<string, string>();

function needsAssetProxy(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    const h = u.hostname;
    const isLocal =
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    // http subresource on an https page is mixed content (blocked).
    const mixed = location.protocol === 'https:' && u.protocol === 'http:';
    return isLocal || mixed;
  } catch {
    return false;
  }
}

async function resolveAssetUrl(url: string): Promise<string> {
  if (!needsAssetProxy(url)) return url;
  const cached = assetCache.get(url);
  if (cached) return cached;
  const dataUrl = (await browser.runtime
    .sendMessage({ type: 'yandz:fetch-asset', url })
    .catch(() => null)) as string | null;
  if (dataUrl) assetCache.set(url, dataUrl);
  return dataUrl ?? url;
}

/**
 * Build a map of imageSwap asset URL → loadable display URL (a data: URL) for any
 * asset the page can't fetch directly. Patches are NOT rewritten — the original
 * http(s) URL must survive so the applier's re-validation passes (it rejects
 * data:); the map is handed to engine.apply for display only.
 */
async function resolveAssets(patches: AnyPatch[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    patches.map(async (p) => {
      if (p.op !== 'imageSwap') return;
      const resolved = await resolveAssetUrl(p.payload.newAssetUrl);
      if (resolved !== p.payload.newAssetUrl) map.set(p.payload.newAssetUrl, resolved);
    }),
  );
  return map;
}

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
    // The patches currently applied to the DOM, plus the asset map (original image
    // URL → inlined data: URL) for display. The MutationObserver re-applies THESE.
    let currentPatches: AnyPatch[] = [];
    let currentAssets: Map<string, string> = new Map();
    // The viewer's own patches scoped to this site / all sites (fetched once on load).
    // They auto-apply (silently) layered UNDER whatever version is applied — and even
    // when no version is applied — for the creating user only.
    let personalPatches: AnyPatch[] = [];
    /** A version's patches plus the personal site/global layer, applied together. */
    const withPersonal = (base: AnyPatch[]): AnyPatch[] => (personalPatches.length ? [...base, ...personalPatches] : base);
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

    /** Live-apply an arbitrary patch set (editor preview): revert what's applied and
     *  apply the given patches. Used when a change is deleted/edited so the page
     *  reflects the current change list. Keeps the applied version's identity. */
    async function applyPatches(patches: AnyPatch[]): Promise<void> {
      // Resolve assets BEFORE mutating the live state. Otherwise the async resolve
      // leaves a window where currentPatches points at the new (loopback) image URL
      // but currentAssets is empty, so a MutationObserver re-apply during that gap
      // sets <img> to an unreachable localhost URL and the swap visibly drops.
      const eff = withPersonal(patches);
      const assets = await resolveAssets(eff);
      engine.revertAll();
      overlay.clear();
      currentPatches = eff;
      currentAssets = assets;
      if (eff.length) {
        engine.apply(eff, document, assets);
        overlay.render(eff);
      }
      if (current) current = { ...current, patches: patches as VersionSummary['patches'] };
    }

    /** Apply a version's patches (DOM mutations + visual overlay), replacing any current one. */
    async function applyVersion(version: VersionSummary | null): Promise<void> {
      // Resolve assets first (see applyPatches) so there's no gap where the page
      // shows the original/broken image between revert and re-apply. The personal
      // site/global layer is always applied alongside (or alone, if no version).
      const eff = withPersonal(version ? version.patches : []);
      const assets = await resolveAssets(eff);
      engine.revertAll();
      overlay.clear();
      current = version;
      currentPatches = eff;
      currentAssets = assets;
      if (eff.length) {
        engine.apply(eff, document, assets);
        overlay.render(eff); // drawings + annotations
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
        // Re-assert whatever is currently applied (an active version OR an editor
        // preview). Don't fight the user's in-place typing by re-applying over it.
        if (currentPatches.length && !isInlineEditing()) engine.apply(currentPatches, document, currentAssets);
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
            void applyVersion(found);
          } else {
            // A just-created version won't be in our cached list — re-fetch, then apply.
            void getVersions(location.href)
              .then((fresh) => {
                if (!fresh) return;
                data = fresh;
                const v = fresh.versions.find((x) => x.id === msg.versionId);
                if (v) void applyVersion(v);
              })
              .catch(() => {});
          }
          break;
        }
        case 'yandz:revert':
          void applyVersion(null);
          break;
        case 'yandz:grant-consent':
          void browser.storage.local.set({ [consentKey]: true });
          if (data?.versions[0]) void applyVersion(data.versions[0]);
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
        case 'yandz:apply-patches':
          // Editor preview (e.g. after deleting a change) — re-apply the new set.
          void applyPatches(msg.patches as AnyPatch[]);
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

    // The viewer's own site/global-scoped patches auto-apply silently on every page,
    // independent of shared versions or consent (they're the user's own choices).
    personalPatches = await getMyPatches(location.href);

    if (!data || data.versions.length === 0) {
      // No shared versions here, but the personal layer may still apply on its own.
      if (personalPatches.length) void applyVersion(null);
      return;
    }

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
    let appliedVersion = false;
    if (pendingId) {
      await browser.storage.local.remove(pendingKey);
      const requested = data.versions.find((v) => v.id === pendingId);
      if (requested) {
        void applyVersion(requested);
        appliedVersion = true;
      } else if (await hasConsent()) {
        void applyVersion(data.versions[0]!);
        appliedVersion = true;
      }
    } else if (await hasConsent()) {
      // Otherwise auto-apply the top version only after one-time per-site consent.
      void applyVersion(data.versions[0]!);
      appliedVersion = true;
    }
    // If no shared version auto-applied, still apply the personal site/global layer.
    if (!appliedVersion && personalPatches.length) void applyVersion(null);
  },
});
