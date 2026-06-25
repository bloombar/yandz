/**
 * Helper for taking the active tab to a version's page.
 *
 * Versions apply via persisted activations: once a version is activated, the content
 * script applies it on load for any matching page. So to "apply" a version that targets
 * a different page or site, we simply navigate the tab there — the content script picks
 * up the (already persisted) activation and applies it.
 */
import { browser } from 'wxt/browser';

/** Navigate the active tab to a page (its normalized urlKey works as a URL). */
export async function navigateTab(urlKey: string): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: urlKey });
}
