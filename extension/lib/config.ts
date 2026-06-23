/**
 * Client-side configuration, adjustable at build time via Vite env vars
 * (e.g. an `extension/.env` file). See README for the full list.
 */

/**
 * Auto-save debounce threshold (ms). Edits made within this window of each other
 * coalesce into the same version: the timer resets on every edit and the version
 * is persisted only after this much inactivity. Override with VITE_AUTOSAVE_DEBOUNCE_MS.
 */
export const AUTOSAVE_DEBOUNCE_MS = Number(import.meta.env.VITE_AUTOSAVE_DEBOUNCE_MS ?? 1500);

/**
 * Feed pagination / infinite scroll.
 *  - ITEMS_PER_PAGE_DEFAULT: page size when the user hasn't set one (configurable in
 *    Settings → Preferences, persisted to storage.local key `itemsPerPage`).
 *  - FEED_WINDOW_PAGES: how many pages are kept in browser memory at once; the in-memory
 *    cap is pageSize × this. Scrolling past it trims the far end.
 *  - FEED_SCROLL_THRESHOLD_PX: how close to an edge (in px) triggers a prefetch.
 *  - ITEMS_PER_PAGE_MIN/MAX: clamp for the user setting.
 */
export const ITEMS_PER_PAGE_DEFAULT = Number(import.meta.env.VITE_ITEMS_PER_PAGE ?? 25);
export const FEED_WINDOW_PAGES = Number(import.meta.env.VITE_FEED_WINDOW_PAGES ?? 4);
export const FEED_SCROLL_THRESHOLD_PX = Number(import.meta.env.VITE_FEED_SCROLL_THRESHOLD_PX ?? 400);
export const ITEMS_PER_PAGE_MIN = 5;
export const ITEMS_PER_PAGE_MAX = 100;
