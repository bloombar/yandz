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
import type { PageVersions, ActiveItem } from '../lib/api.js';

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

/** The viewer's activations relevant to this URL (each tagged on/off), via background. */
async function getActivations(url: string): Promise<ActiveItem[]> {
  try {
    const res = (await browser.runtime.sendMessage({ type: 'yandz:get-activations', url })) as ActiveItem[] | null;
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
  // A few computed styles so the panel's style controls can show current values.
  const cs = getComputedStyle(el);
  const styles = {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    display: cs.display,
  };
  return {
    tagName: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').slice(0, 500),
    src: el instanceof HTMLImageElement ? el.src : undefined,
    attrs,
    styles,
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
    // A page can show MANY active versions at once, layered bottom→top by scope: globals
    // (bottom), then site versions (matching host), then page versions (matching page,
    // top). Within a scope they layer in activation order. `activeList` is the viewer's
    // activations relevant to THIS url (fetched from the server); each carries an on/off
    // (enabled) flag — paused ones stay in the bar but aren't applied.
    type Scope = 'global' | 'site' | 'page';
    const SCOPE_ORDER: Scope[] = ['global', 'site', 'page']; // bottom → top (page wins)
    interface Active {
      version: ActiveItem;
      scope: Scope;
      on: boolean;
      // Pulled in because an active version requires it (not a direct opt-in): the panel
      // renders these read-only as "required by X".
      dependency: boolean;
      requiredBy: string | null;
    }
    let activeList: Active[] = [];
    // Editor draft, layered on TOP of everything while a version is being edited.
    let preview: AnyPatch[] | null = null;

    // The merged patches currently applied to the DOM, plus the asset map (original
    // image URL → inlined data: URL). The MutationObserver re-applies THESE.
    let currentPatches: AnyPatch[] = [];
    let currentAssets: Map<string, string> = new Map();
    // Holds the fetched page versions once loaded (null until then / on failure).
    let data: PageVersions | null = null;
    // Stops the active page-side tool (drawing), so it can be torn down when the
    // editor closes or another tool starts.
    let activeStop: (() => void) | null = null;

    // GLOBAL consent gate: Y and Z applies NO patches on ANY page until the user has
    // granted consent (once, via the first-run modal). Mirrors storage so cross-tab /
    // settings changes take effect live.
    let consented = false;

    /** The active versions for this page (drives the panel's applied bar + per-page
     *  highlight). Includes PAUSED ones (on=false) so the bar can show them as inactive
     *  until removed. Persisted to shared session storage + broadcast for live updates. */
    function appliedSet(): {
      scope: Scope;
      versionId: string;
      name: string;
      author: { id: string; handle: string };
      on: boolean;
      dependency: boolean;
      requiredBy: string | null;
    }[] {
      return activeList.map((a) => ({
        scope: a.scope,
        versionId: a.version.id,
        name: a.version.name,
        author: { id: a.version.author.id, handle: a.version.author.handle },
        on: a.on,
        dependency: a.dependency,
        requiredBy: a.requiredBy,
      }));
    }

    function notifyApplied(): void {
      const urlKey = data?.page.urlKey;
      const applied = appliedSet();
      if (urlKey) void browser.storage.session.set({ [`applied:${urlKey}`]: applied }).catch(() => {});
      void browser.runtime.sendMessage({ type: 'yandz:applied', urlKey: urlKey ?? null, applied }).catch(() => {});
    }

    /** Merge all ENABLED active versions bottom→top (globals, then sites, then pages) plus
     *  the editor preview on top, rewriting each patch's `order` so higher layers override
     *  lower ones on a shared element (see mergeScopedPatches). */
    function effectivePatches(): AnyPatch[] {
      const layers: { patches: AnyPatch[] }[] = [];
      for (const s of SCOPE_ORDER) {
        for (const a of activeList) if (a.scope === s && a.on) layers.push({ patches: a.version.patches });
      }
      if (preview) layers.push({ patches: preview });
      return mergeScopedPatches(layers);
    }

    /** Rebuild the page from the active set — the single source of truth for what is on
     *  the page. Resolve assets BEFORE reverting so a MutationObserver re-apply during the
     *  async gap can't flash an unresolved (loopback) image, then revert everything and
     *  apply the merged set. Every change goes through here. */
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

    /** Editor preview: show a draft patch set layered on top, then rebuild. */
    function previewPatches(patches: AnyPatch[]): Promise<void> {
      preview = patches;
      return reapplyAll();
    }

    /** Re-fetch the viewer's activations relevant to this URL, rebuild the active list,
     *  and re-apply. Called after any activate / toggle / remove from the panel. Clears
     *  any editor preview (a real refresh reflects the committed state). */
    async function refreshActivations(): Promise<void> {
      const items = await getActivations(location.href);
      activeList = items.map((it) => ({
        version: it,
        scope: it.scope as Scope,
        on: it.on,
        dependency: !!it.dependency,
        requiredBy: it.requiredBy ?? null,
      }));
      preview = null;
      await reapplyAll();
    }

    /** "Revert to original": strip the DOM back to the published page. Reverts directly
     *  (NOT via reapplyAll) so it also works when consent has just been revoked. Marks the
     *  active list off transiently; the next load (or re-grant) re-fetches the real state.
     *  Removal of opt-ins is done from the panel. */
    function revertToOriginal(): void {
      preview = null;
      for (const a of activeList) a.on = false;
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
        case 'yandz:revert':
          revertToOriginal();
          break;
        case 'yandz:refresh-activations':
          // An activation changed (activate / pause / remove in the feed, the bar, or
          // settings) — re-fetch the active set and re-apply so the page reflects it
          // immediately, without a reload.
          void refreshActivations();
          break;
        case 'yandz:stop-tools':
          // Editor closed (or switched away) — tear down any active drawing layer and drop
          // any uncommitted preview so the page shows the committed active set.
          activeStop?.();
          activeStop = null;
          if (preview) {
            preview = null;
            void reapplyAll();
          }
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
          // Starting a new pick clears the panel's previously selected element.
          void browser.runtime.sendMessage({ type: 'yandz:deselect' }).catch(() => {});
          // Open the inspector. If the picked element has its own text, edit it
          // IN PLACE on the page and send the resulting textReplace patch. For
          // textless elements, fall back to the sidebar editor (CSS/attr/image).
          startPicker((el) => {
            if (hasOwnText(el)) {
              // Fingerprint BEFORE the inline edit mutates the element, so ownText and
              // textFingerprint capture the ORIGINAL (unedited) text. The template
              // "same text" content gate and the text-fingerprint fallback both compare
              // against the original content; capturing after the edit stores the NEW text
              // and makes "apply to all" reject its own target on a fresh page.
              const target = fingerprintElement(el);
              startInlineEdit(el, {
                onCommit: ({ from, to }) => {
                  void browser.runtime.sendMessage({
                    type: 'yandz:text-edited',
                    target,
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
        case 'yandz:start-style-picker':
          // Style/attribute editing works on ANY element — unlike the text picker, it
          // never inline-edits; it always opens the panel's element editor.
          activeStop?.();
          activeStop = null;
          void browser.runtime.sendMessage({ type: 'yandz:deselect' }).catch(() => {});
          startPicker((el) => {
            void browser.runtime.sendMessage({
              type: 'yandz:element-picked',
              target: fingerprintElement(el),
              snapshot: elementSnapshot(el),
            });
          });
          break;
        case 'yandz:start-draw':
          // Freehand draw over the page. Strokes auto-emit after a pause (debounced)
          // and on stop, anchored to <body>, so the drawing is saved without an
          // explicit "finish" step.
          activeStop?.(); // replace any prior drawing session
          void browser.runtime.sendMessage({ type: 'yandz:deselect' }).catch(() => {});
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

    /** Apply the viewer's active set for this page. The active list is fetched on load
     *  (and re-fetched on refresh-activations); this just rebuilds the DOM. No-op without
     *  consent (reapplyAll also hard-gates). */
    async function applyForPage(): Promise<void> {
      if (!consented) return;
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

    // Fetch this frame's page versions (for the floating-icon count) and the viewer's
    // active set REGARDLESS of consent (these are reads, not modifications). Done BEFORE
    // any modal await so a consent grant (modal or another tab) has data ready to apply.
    // Each frame fetches for ITS OWN URL, so cross-origin iframes get their own page's
    // versions independently of the outer page.
    try {
      data = await getVersions(location.href);
    } catch {
      return; // backend unreachable
    }
    activeList = (await getActivations(location.href)).map((it) => ({
      version: it,
      scope: it.scope as Scope,
      on: it.on,
      dependency: !!it.dependency,
      requiredBy: it.requiredBy ?? null,
    }));
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
