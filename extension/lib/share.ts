/**
 * Share a version via the OS share sheet. The shared link is the page URL with a
 * version tag fragment (`#yandz-v=<id>`); when a recipient who has the extension
 * opens it, the content script applies that version on load (see content.ts).
 * Falls back to copying the link when the Web Share API isn't available.
 */

export interface ShareResult {
  method: 'shared' | 'copied' | 'unavailable';
}

/** Build the deep link for a version on a given page. */
export function versionLink(pageUrlKey: string, versionId: string): string {
  // pageUrlKey is already a normalized, navigable URL.
  const sep = pageUrlKey.includes('#') ? '' : '#';
  return `${pageUrlKey}${sep}yandz-v=${versionId}`;
}

export async function shareVersion(
  pageUrlKey: string,
  versionId: string,
  title: string,
): Promise<ShareResult> {
  const url = versionLink(pageUrlKey, versionId);
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: `Y and Z: ${title}`, url });
      return { method: 'shared' };
    } catch {
      /* user cancelled or share failed → fall through to clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return { method: 'copied' };
  } catch {
    return { method: 'unavailable' };
  }
}
