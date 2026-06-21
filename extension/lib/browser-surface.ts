/**
 * The ONLY browser-divergence shim. All other code is engine-agnostic and uses
 * the `browser.*` namespace (webextension-polyfill, provided by WXT). When a
 * surface differs between Chromium and Firefox, branch here and nowhere else.
 *
 * Divergences handled:
 *  - Panel surface: Chromium `sidePanel` (opened from the action click) vs
 *    Firefox `sidebar_action`.
 *  - Web Push availability (Firefox extension push differs; we degrade silently).
 */
import { browser } from 'wxt/browser';

/** True when the Chromium Side Panel API is present. */
export function hasSidePanel(): boolean {
  return typeof (browser as any).sidePanel?.open === 'function';
}

/** True when the Firefox sidebar API is present. */
export function hasSidebar(): boolean {
  return typeof (browser as any).sidebarAction?.toggle === 'function';
}

/**
 * Open the panel surface for the current window using whichever API exists.
 * Called from the background script in response to the action click / in-page
 * floating-icon message.
 */
export async function openPanel(windowId?: number): Promise<void> {
  if (hasSidePanel()) {
    await (browser as any).sidePanel.open(windowId !== undefined ? { windowId } : {});
  } else if (hasSidebar()) {
    await (browser as any).sidebarAction.toggle();
  }
}

/**
 * Wire the toolbar action so clicking it opens the side panel (Chromium only;
 * Firefox toggles its sidebar natively from the manifest). Safe no-op elsewhere.
 */
export async function configurePanelBehavior(): Promise<void> {
  const sp = (browser as any).sidePanel;
  if (sp?.setPanelBehavior) {
    await sp.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

/** Whether this browser supports the Web Push path used for follow notifications. */
export function supportsWebPush(): boolean {
  // Chromium extensions support PushManager in the SW; Firefox extension push is
  // inconsistent, so callers degrade to in-app notification badges there.
  return typeof self !== 'undefined' && 'PushManager' in (self as unknown as Record<string, unknown>);
}
