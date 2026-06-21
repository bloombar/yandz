/**
 * Typed API client used by the side panel and content script. The JWT is kept in
 * chrome.storage.session (cleared when the browser restarts) and attached to every
 * request. The base URL comes from the build-time env (dev server vs prod).
 */
import { browser } from 'wxt/browser';
import type { AnyPatch } from '@yandz/shared';

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
}

export interface FeedResult {
  /** Normalized key of the active tab's page (for "this page" comparisons), or null. */
  currentPageKey: string | null;
  versions: FeedItem[];
}

export type FeedSort = 'foryou' | 'latest';
export type FeedScope = 'all' | 'page';

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

export async function setToken(token: string | null): Promise<void> {
  if (token) await browser.storage.session.set({ token });
  else await browser.storage.session.remove('token');
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

  getVersionsForUrl: (url: string, sort: 'foryou' | 'latest' = 'foryou') =>
    api<PageVersions>(`/pages?url=${encodeURIComponent(url)}&sort=${sort}`),

  // Global (or this-page) feed. `url` is the active tab's URL for scope/comparison.
  getFeed: (sort: FeedSort, scope: FeedScope, url?: string) =>
    api<FeedResult>(`/feed?sort=${sort}&scope=${scope}&url=${encodeURIComponent(url ?? '')}`),

  getBookmarksFeed: (scope: FeedScope, url?: string) =>
    api<FeedResult>(`/feed/bookmarks?scope=${scope}&url=${encodeURIComponent(url ?? '')}`),

  toggleBookmark: (id: string, on: boolean) =>
    api<{ bookmarked: boolean }>(`/versions/${id}/bookmark`, { method: on ? 'POST' : 'DELETE' }),

  // A single version (used to preload a base when starting an attributed derivative).
  getVersion: (id: string) =>
    api<{ id: string; name: string; authorId: string; patches: AnyPatch[]; parentVersionId: string | null }>(
      `/versions/${id}`,
    ),

  createVersion: (input: { url: string; title?: string; name?: string; patches: AnyPatch[] }) =>
    api<{ id: string }>('/versions', { method: 'POST', body: JSON.stringify(input) }),

  forkVersion: (id: string, input: { url: string; name?: string; patches: AnyPatch[] }) =>
    api<{ id: string; parentVersionId: string }>(`/versions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Replace an existing version's patch set (used by debounced auto-save).
  updateVersion: (id: string, input: { name?: string; patches: AnyPatch[] }) =>
    api<{ id: string }>(`/versions/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

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
};
