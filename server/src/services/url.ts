/**
 * URL normalization → urlKey, the join key for patches. Lowercases host, drops
 * the fragment and tracking params, and (for 'path' scope) drops the query.
 */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$)/i;

export function normalizeUrl(raw: string, mode: 'exact' | 'path' = 'exact'): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  // Drop default ports.
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  if (mode === 'path') {
    u.search = '';
  } else {
    const kept = new URLSearchParams();
    const entries = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
    entries.sort(([a], [b]) => a.localeCompare(b)); // stable ordering
    for (const [k, v] of entries) kept.append(k, v);
    u.search = kept.toString();
  }
  // Normalize trailing slash on path (but keep root '/').
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.toString();
}

/**
 * The identity key for a Page. Pages are keyed by PATH (query string dropped) so
 * that volatile/cache-buster query params (e.g. `?v=3`, A/B flags) don't split one
 * page into many. Used for both version creation and version lookup so reads and
 * writes always resolve to the same page.
 *
 * Trade-off: query-significant URLs (search results, ?id= app routes) collapse to
 * one page. Finer per-version scoping is handled by the version's urlMatch mode.
 */
export function pageKey(rawUrl: string): string {
  return normalizeUrl(rawUrl, 'path');
}

/** The lowercased hostname of a URL (the "site" for 'site'-scoped patches), or '' if unparseable. */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}
