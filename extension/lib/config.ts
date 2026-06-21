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
