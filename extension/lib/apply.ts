/**
 * Helpers for applying a version to the live page from the side panel.
 *
 * - applyOnCurrentTab: in-place apply when the version targets the page already open.
 * - openWithVersion: when the version targets a DIFFERENT page, navigate the current
 *   tab there with the version queued (the content script reads the pendingApply flag
 *   on load and applies it — same mechanism as share deep-links).
 */
import { browser } from 'wxt/browser';

/** Tell the content script in the active tab to apply a version in place. */
export async function applyOnCurrentTab(versionId: string): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await browser.tabs.sendMessage(tab.id, { type: 'yandz:apply-version', versionId }).catch(() => {});
  }
}

/** Navigate the current tab to a page and queue a version to auto-apply on load. */
export async function openWithVersion(urlKey: string, versionId: string): Promise<void> {
  await browser.storage.local.set({ [`pendingApply:${urlKey}`]: versionId });
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: urlKey });
}

/**
 * Apply a feed/profile version: in place if it targets the current page, otherwise
 * navigate to its page and apply on load.
 */
export async function applyVersionAnywhere(
  versionId: string,
  pageUrlKey: string,
  currentPageKey: string | null,
): Promise<void> {
  if (currentPageKey && pageUrlKey === currentPageKey) await applyOnCurrentTab(versionId);
  else await openWithVersion(pageUrlKey, versionId);
}
