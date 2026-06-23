/**
 * Typed API client used by the side panel and content script. The JWT is kept in
 * chrome.storage.session (cleared when the browser restarts) and attached to every
 * request. The base URL comes from the build-time env (dev server vs prod).
 */
import { browser } from 'wxt/browser';
import type { AnyPatch, PatchScope } from '@yandz/shared';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000';

export interface PublicUser {
  id: string;
  handle: string;
}

export interface PageVersions {
  page: { urlKey: string; versionCount: number };
  versions: VersionSummary[];
}

export interface VersionSummary {
  id: string;
  name: string;
  author: PublicUser;
  patches: AnyPatch[];
  parentVersionId: string | null;
  up: number;
  down: number;
  hotScore: number;
  commentCount: number;
  createdAt: string;
}

/** A feed/profile row: a version plus the page it modifies + the viewer's bookmark/vote state. */
export interface FeedItem extends VersionSummary {
  page: { urlKey: string; title: string };
  bookmarked: boolean;
  /** The viewer's vote: 1 (up), -1 (down), or 0 (none). */
  myVote: 1 | -1 | 0;
  /** Author of the version this was based on (for "based on u/x" links), or null. */
  parentAuthor: { id: string; handle: string } | null;
  /** Title of the version this was based on, or null. */
  parentName: string | null;
}

export interface FeedResult {
  /** Normalized key of the active tab's page (for "this page" comparisons), or null. */
  currentPageKey: string | null;
  versions: FeedItem[];
  /** True if more results exist after this page (for infinite scroll). */
  hasMore: boolean;
}

export type FeedSort = 'foryou' | 'latest';
export type FeedScope = 'all' | 'page';

/** One managed personal scoped patch (the settings tabs): a change broadened beyond its page. */
export interface ScopedPatchEntry {
  versionId: string;
  order: number;
  versionName: string;
  /** Host of the page the version was originally made on. */
  site: string;
  patch: AnyPatch;
}

/** Read the stored auth token (session-scoped). */
export async function getToken(): Promise<string | null> {
  // storage.session isn't exposed to content scripts unless the access level is
  // widened (see background). If it's unavailable, fall back to no token — reads
  // like GET /pages use optional auth and still work unauthenticated.
  try {
    const { token } = await browser.storage.session.get('token');
    return (token as string) ?? null;
  } catch {
    return null;
  }
}

/** Decode the current user from the stored JWT (no network call), or null. */
export async function getCurrentUser(): Promise<{ id: string; handle: string } | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part)) as { sub: string; handle: string };
    return { id: payload.sub, handle: payload.handle };
  } catch {
    return null;
  }
}

export async function setToken(token: string | null): Promise<void> {
  if (token) await browser.storage.session.set({ token });
  else await browser.storage.session.remove('token');
}

/** Build the optional `&q=&offset=&limit=` suffix shared by the feed endpoints. */
function pageQuery(q?: string, offset?: number, limit?: number): string {
  let s = '';
  if (q) s += `&q=${encodeURIComponent(q)}`;
  if (offset !== undefined) s += `&offset=${offset}`;
  if (limit !== undefined) s += `&limit=${limit}`;
  return s;
}

/** Low-level fetch wrapper that injects auth + JSON handling and throws on !ok. */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}

// --- Endpoints (thin, typed wrappers) ------------------------------------
export const Api = {
  base: API_BASE,

  signup: (email: string, password: string, handle: string) =>
    api<{ token: string; user: PublicUser }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, handle }),
    }),

  login: (email: string, password: string) =>
    api<{ token: string; user: PublicUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  google: (idToken: string, handle?: string) =>
    api<{ token: string; user: PublicUser }>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken, handle }),
    }),

  getVersionsForUrl: (url: string, sort: 'foryou' | 'latest' = 'foryou', title?: string) =>
    api<PageVersions>(
      `/pages?url=${encodeURIComponent(url)}&sort=${sort}` +
        (title ? `&title=${encodeURIComponent(title)}` : ''),
    ),

  // Global (or this-page) feed. `url` is the active tab's URL for scope/comparison;
  // `q` is an optional free-text search; `offset`/`limit` paginate (infinite scroll).
  getFeed: (sort: FeedSort, scope: FeedScope, url?: string, q?: string, offset?: number, limit?: number) =>
    api<FeedResult>(`/feed?sort=${sort}&scope=${scope}&url=${encodeURIComponent(url ?? '')}${pageQuery(q, offset, limit)}`),

  getBookmarksFeed: (scope: FeedScope, url?: string, q?: string, offset?: number, limit?: number) =>
    api<FeedResult>(`/feed/bookmarks?scope=${scope}&url=${encodeURIComponent(url ?? '')}${pageQuery(q, offset, limit)}`),

  // The viewer's own versions (newest first) — the "By you" tab.
  getMyFeed: (scope: FeedScope, url?: string, q?: string, offset?: number, limit?: number) =>
    api<FeedResult>(`/feed?mine=1&scope=${scope}&url=${encodeURIComponent(url ?? '')}${pageQuery(q, offset, limit)}`),

  toggleBookmark: (id: string, on: boolean) =>
    api<{ bookmarked: boolean }>(`/versions/${id}/bookmark`, { method: on ? 'POST' : 'DELETE' }),

  // A single version (used to preload a base when starting an attributed derivative).
  getVersion: (id: string) =>
    api<{ id: string; name: string; authorId: string; patches: AnyPatch[]; parentVersionId: string | null }>(
      `/versions/${id}`,
    ),

  createVersion: (input: { url: string; title?: string; name?: string; patches: AnyPatch[] }) =>
    api<{ id: string; name: string }>('/versions', { method: 'POST', body: JSON.stringify(input) }),

  forkVersion: (id: string, input: { url: string; title?: string; name?: string; patches: AnyPatch[] }) =>
    api<{ id: string; name: string; parentVersionId: string }>(`/versions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Replace an existing version's patch set (used by debounced auto-save).
  updateVersion: (id: string, input: { name?: string; patches: AnyPatch[] }) =>
    api<{ id: string }>(`/versions/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

  // Delete a version the viewer authored.
  deleteVersion: (id: string) => api<{ deleted: boolean }>(`/versions/${id}`, { method: 'DELETE' }),

  vote: (id: string, value: 1 | -1) =>
    api<{ up: number; down: number; myVote: 1 | -1 | 0 }>(`/versions/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),

  getComments: (id: string) =>
    api<Array<{ id: string; author: PublicUser; parentCommentId: string | null; body: string; createdAt: string }>>(
      `/versions/${id}/comments`,
    ),

  postComment: (id: string, body: string, parentCommentId?: string) =>
    api(`/versions/${id}/comments`, { method: 'POST', body: JSON.stringify({ body, parentCommentId }) }),

  getProfile: (id: string) =>
    api<{
      user: PublicUser;
      modifications: Array<{ versionId: string; urlKey: string; name: string; createdAt: string }>;
      relationship: { following: boolean; muted: boolean; blocked: boolean };
    }>(`/users/${id}`),

  following: () => api<PublicUser[]>('/users/me/following'),
  muted: () => api<PublicUser[]>('/users/me/muted'),
  blocked: () => api<PublicUser[]>('/users/me/blocked'),

  follow: (id: string, on: boolean) => api(`/users/${id}/follow`, { method: on ? 'POST' : 'DELETE' }),
  mute: (id: string, on: boolean) => api(`/users/${id}/mute`, { method: on ? 'POST' : 'DELETE' }),
  block: (id: string, on: boolean) => api(`/users/${id}/block`, { method: on ? 'POST' : 'DELETE' }),

  presignUpload: (contentType: string, ext: string) =>
    api<{ uploadUrl: string; publicUrl: string }>('/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({ contentType, ext }),
    }),

  subscribePush: (subscription: PushSubscriptionJSON) =>
    api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) }),

  // --- Personal scoped patches (/me) ---
  // The current user's patches to auto-apply on this URL (site/global scope).
  getMyPatches: (url: string) => api<{ patches: AnyPatch[] }>(`/me/patches?url=${encodeURIComponent(url)}`),
  // Management lists for the settings tabs.
  getMyGlobalPatches: () => api<{ patches: ScopedPatchEntry[] }>('/me/patches/global'),
  getMySitePatches: () => api<{ patches: ScopedPatchEntry[] }>('/me/patches/site'),
  // Change one patch's scope (single demotions: global→site, site→page).
  setPatchScope: (versionId: string, order: number, scope: PatchScope) =>
    api<{ ok: boolean }>('/me/patches/scope', { method: 'PATCH', body: JSON.stringify({ versionId, order, scope }) }),
  // Bulk demote every 'site' patch on a host to 'page'.
  demoteSitePatches: (host: string) =>
    api<{ ok: boolean; demoted: number }>('/me/patches/demote-site', {
      method: 'POST',
      body: JSON.stringify({ host }),
    }),
};
