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
