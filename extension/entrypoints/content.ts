/**
 * Content script — the in-page surface of Y and Z.
 *
 * On every page it:
 *  1. Fetches the ranked versions for the current URL.
 *  2. If versions exist, mounts a discrete floating icon (in a Shadow DOM so page
 *     CSS can't break it and it isn't itself a patch target).
 *  3. Applies the top-ranked version automatically — but ONLY after the user grants a
 *     one-time GLOBAL consent (the first-run modal). Without consent it applies no
 *     patches on any page.
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

/** The viewer's opted-in site/global versions to auto-apply on this URL (via background). */
async function getActivations(url: string): Promise<VersionSummary[]> {
  try {
    const res = (await browser.runtime.sendMessage({ type: 'yandz:get-activations', url })) as VersionSummary[] | null;
    return res ?? [];
  } catch {
    return [];
  }
}
import { PatchEngine } from '../lib/engine/applier.js';
import { fingerprintElement } from '../lib/engine/fingerprint.js';
import { matchTarget } from '../lib/engine/matcher.js';
import { mergeScopedPatches } from '../lib/engine/layer.js';
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
import { CONSENT_KEY, getConsent, setConsent, showConsentModal, dismissConsentModal } from '../lib/ui/consent-modal.js';
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
  // Run in EVERY frame so each cross-origin iframe is patched as its own page (its own
  // URL, its own versions) — the Same-Origin Policy makes reaching into them from the
  // top frame impossible, so each frame patches itself. Top-frame-only surfaces (the
  // floating icon, consent modal, and panel-driven editing) are guarded by `isTop`.
  allFrames: true,
  async main(ctx) {
    // Whether this instance is the top-level page (vs. an embedded iframe).
    const isTop = window === window.top;
    const engine = new PatchEngine();
    const overlay = new OverlayRenderer();
    // A page shows up to three versions at once, one per scope, layered bottom→top:
    // global (bottom) under site under page (top). Each slot holds the applied version
    // (or null) and an on/off toggle. The page slot comes from this page's ranked
    // versions; the site/global slots from the viewer's opted-in activations.
    type Scope = 'global' | 'site' | 'page';
    const SCOPE_ORDER: Scope[] = ['global', 'site', 'page']; // bottom → top (page wins)
    interface Layer {
      version: VersionSummary | null;
      on: boolean;
    }
    const layers: Record<Scope, Layer> = {
      global: { version: null, on: true },
      site: { version: null, on: true },
      page: { version: null, on: true },
    };

    // The merged patches currently applied to the DOM, plus the asset map (original
    // image URL → inlined data: URL). The MutationObserver re-applies THESE.
    let currentPatches: AnyPatch[] = [];
    let currentAssets: Map<string, string> = new Map();
    // Holds the fetched page versions once loaded (null until then / on failure).
    let data: PageVersions | null = null;
    // The viewer's opted-in site/global versions for this URL (fetched once on load).
    let activations: VersionSummary[] = [];
    // Stops the active page-side tool (drawing), so it can be torn down when the
    // editor closes or another tool starts.
    let activeStop: (() => void) | null = null;

    // GLOBAL consent gate: Y and Z applies NO patches on ANY page until the user has
    // granted consent (once, via the first-run modal). Mirrors storage so cross-tab /
    // settings changes take effect live.
    let consented = false;

    /** The versions currently applied, by scope (drives the panel's applied bar +
     *  per-page highlight). Includes versions auto-applied on load, before the panel
     *  was open. Persisted to shared session storage (reliable regardless of message
     *  timing) and also broadcast for live updates. */
    function appliedSet(): { scope: Scope; versionId: string; name: string }[] {
      return SCOPE_ORDER.filter((s) => layers[s].on && layers[s].version).map((s) => ({
        scope: s,
        versionId: layers[s].version!.id,
        name: layers[s].version!.name,
      }));
    }

    function notifyApplied(): void {
      const urlKey = data?.page.urlKey;
      const applied = appliedSet();
      if (urlKey) void browser.storage.session.set({ [`applied:${urlKey}`]: applied }).catch(() => {});
      void browser.runtime.sendMessage({ type: 'yandz:applied', urlKey: urlKey ?? null, applied }).catch(() => {});
    }

    /** Merge the active layers' patches bottom→top (global, site, page) into one list,
     *  rewriting each patch's `order` so a page patch overrides a site patch overrides a
     *  global patch on a shared element (see mergeScopedPatches). */
    function effectivePatches(): AnyPatch[] {
      const active = SCOPE_ORDER.filter((s) => layers[s].on && layers[s].version).map((s) => ({
        patches: layers[s].version!.patches,
      }));
      return mergeScopedPatches(active);
    }

    /** Rebuild the page from the current layer set — the single source of truth for what
     *  is on the page. Resolve assets BEFORE reverting so a MutationObserver re-apply
     *  during the async gap can't flash an unresolved (loopback) image, then revert
     *  everything and apply the merged set. Every layer change goes through here. */
    async function reapplyAll(): Promise<void> {
      if (!consented) return; // no patching without consent
      const eff = effectivePatches();
      const assets = await resolveAssets(eff);
      engine.revertAll();
      overlay.clear();
      currentPatches = eff;
      currentAssets = assets;
      if (eff.length) {
        engine.apply(eff, document, assets);
        overlay.render(eff); // drawings + annotations
      }
      notifyApplied();
    }

    /** Set the page-scope layer to a version (or null) and rebuild. */
    function setPageVersion(version: VersionSummary | null): Promise<void> {
      layers.page = { version, on: true };
      return reapplyAll();
    }

    /** Editor preview: show an arbitrary draft patch set as the page layer (keeping the
     *  applied version's identity for the bar), then rebuild. */
    function previewPatches(patches: AnyPatch[]): Promise<void> {
      const base = layers.page.version;
      const preview = { ...(base ?? { id: 'preview', name: 'Draft', scope: 'page' }), patches } as VersionSummary;
      layers.page = { version: preview, on: true };
      return reapplyAll();
    }

    /** Re-fetch the viewer's activations for this URL and reseed the site/global layers,
     *  then rebuild. Called after an activate/deactivate/replace from the panel. */
    async function refreshActivations(): Promise<void> {
      const active = await getActivations(location.href);
      layers.site = { version: active.find((v) => v.scope === 'site') ?? null, on: true };
      layers.global = { version: active.find((v) => v.scope === 'global') ?? null, on: true };
      await reapplyAll();
    }

    /** "Revert to original": turn every layer off (transient) and strip the DOM back to
     *  the published page. Reverts directly (NOT via reapplyAll) so it also works when
     *  consent has just been revoked — reapplyAll is consent-gated, but reverting must
     *  always succeed. Activations are NOT removed: the next load (or a re-grant) re-applies
     *  them, and the bar can toggle a layer back on. Permanent removal is via settings. */
    function revertToOriginal(): void {
      for (const s of SCOPE_ORDER) layers[s].on = false;
      engine.revertAll();
      overlay.clear();
      currentPatches = [];
      currentAssets = new Map();
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

    // Messages from the side panel (switch version, revert, pick, draw, etc.) drive the
    // editing UI, which is top-frame only. Subframes patch themselves automatically and
    // don't participate in panel-driven editing, so they skip this listener.
    if (isTop)
    browser.runtime.onMessage.addListener((msg: any) => {
      switch (msg?.type) {
        case 'yandz:apply-version': {
          // Apply a page-scoped version in place (the page layer). Site/global versions
          // apply via activations (yandz:refresh-activations), not here.
          const found = data?.versions.find((v) => v.id === msg.versionId);
          if (found) {
            void setPageVersion(found);
          } else {
            // A just-created version won't be in our cached list — re-fetch, then apply.
            void getVersions(location.href)
              .then((fresh) => {
                if (!fresh) return;
                data = fresh;
                const v = fresh.versions.find((x) => x.id === msg.versionId);
                if (v) void setPageVersion(v);
              })
              .catch(() => {});
          }
          break;
        }
        case 'yandz:revert':
          revertToOriginal();
          break;
        case 'yandz:toggle-scope':
          // Bar toggle: turn one layer on/off (transient). For site/global the panel
          // also persists the change via activate/deactivate; for page it's session-only.
          if (msg.scope === 'global' || msg.scope === 'site' || msg.scope === 'page') {
            layers[msg.scope as Scope].on = !!msg.on;
            void reapplyAll();
          }
          break;
        case 'yandz:refresh-activations':
          // An activation changed (opt in/out in the feed, the bar, or account settings)
          // — re-fetch the viewer's active site/global versions and re-apply so the page
          // reflects it immediately, without a reload.
          void refreshActivations();
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
          // Editor preview (e.g. after deleting a change) — re-apply the new draft set.
          void previewPatches(msg.patches as AnyPatch[]);
          break;
        case 'yandz:get-applied':
          // The panel asks which versions are currently applied (per scope) to drive the
          // applied bar + row highlighting.
          return Promise.resolve(appliedSet());
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

    /** Seed all three layers and apply. The site/global slots come from the viewer's
     *  activations; the page slot from this page's ranked versions (a shared link
     *  `#yandz-v=<id>` or a queued "pending apply" pins an exact version, else the
     *  top-ranked one). No-op without consent (reapplyAll also hard-gates). */
    async function applyForPage(): Promise<void> {
      if (!consented) return;
      // Site/global layers from opt-in activations (already fetched into `activations`).
      layers.site = { version: activations.find((v) => v.scope === 'site') ?? null, on: true };
      layers.global = { version: activations.find((v) => v.scope === 'global') ?? null, on: true };

      // Page layer from this page's ranked versions.
      let pageVersion: VersionSummary | null = null;
      if (data && data.versions.length > 0) {
        const hashMatch = location.hash.match(/yandz-v=([a-f0-9]+)/i);
        const pendingKey = `pendingApply:${data.page.urlKey}`;
        const pendingId =
          hashMatch?.[1] ?? ((await browser.storage.local.get(pendingKey))[pendingKey] as string | undefined);
        if (pendingId) {
          await browser.storage.local.remove(pendingKey);
          pageVersion = data.versions.find((v) => v.id === pendingId) ?? data.versions[0]!;
        } else {
          pageVersion = data.versions[0]!;
        }
      }
      layers.page = { version: pageVersion, on: true };
      await reapplyAll();
    }

    // React to consent changes (the first-run modal, the Settings toggle, or another
    // tab): granting applies this page; revoking reverts it to the original.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CONSENT_KEY]) return;
      const granted = changes[CONSENT_KEY].newValue === 'granted';
      if (granted === consented) return;
      consented = granted;
      dismissConsentModal();
      if (granted) void applyForPage();
      else revertToOriginal();
    });

    // Only real web documents are patch-able. Subframes are often about:blank / data:
    // / tiny tracker iframes — skip those entirely (no fetch, no apply) to avoid
    // needless requests. (The top frame is always an http(s) page.)
    if (!/^https?:\/\//.test(location.href)) return;

    // Fetch this frame's versions + personal layer and (top frame) mount the floating
    // icon REGARDLESS of consent (these are reads, not modifications). Done BEFORE any
    // modal await so a consent grant (modal or another tab) has data ready to apply.
    // Each frame fetches for ITS OWN URL, so cross-origin iframes get their own page's
    // versions independently of the outer page.
    try {
      data = await getVersions(location.href);
    } catch {
      return; // backend unreachable
    }
    activations = await getActivations(location.href);
    if (isTop && data && data.versions.length > 0) {
      mountFloatingIcon({
        count: data.versions.length,
        onClick: () => browser.runtime.sendMessage({ type: 'yandz:open-panel' }),
      });
    }

    // Determine consent. Already granted → apply now. First run (no decision yet, top
    // frame only) → prompt with the in-page modal; the storage listener applies once
    // the user chooses (or consent is granted elsewhere). Subframes never prompt — they
    // apply automatically once the top-frame decision grants consent. Declined → nothing.
    const decision = await getConsent();
    if (decision === 'granted') {
      consented = true;
      await applyForPage();
    } else if (decision === undefined && isTop) {
      const granted = await showConsentModal();
      await setConsent(granted ? 'granted' : 'declined'); // storage listener applies on grant
    }
  },
});
