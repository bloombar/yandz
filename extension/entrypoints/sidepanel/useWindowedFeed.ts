/**
 * Windowed infinite-scroll feed state.
 *
 * Keeps at most `pageSize × windowPages` items in memory. Scrolling near the bottom
 * fetches the next page and appends (trimming the top when over the cap); scrolling
 * back near the top — after the top was trimmed — fetches the previous page and
 * prepends (trimming the bottom). New items are deduped by version id. Because rows
 * are variable height, scroll position across top-side changes (prepend / top-trim) is
 * preserved by measuring scrollHeight before/after and adjusting scrollTop.
 *
 * The window (items + global start offset + hasMore) lives in a SINGLE ref that is
 * mutated synchronously inside the (serialized) load functions, so offset math never
 * sees a half-applied React state update. The `.list` element sets
 * `overflow-anchor: none` so the browser's own scroll anchoring doesn't fight ours and
 * spuriously re-trigger loads.
 *
 * All filtering / access control (blocked users etc.) is server-side, per page; this
 * hook only assembles the pages the server returns.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FeedItem, FeedResult } from '../../lib/api.js';

interface Args {
  fetchPage: (offset: number, limit: number) => Promise<FeedResult>;
  pageSize: number;
  windowPages: number;
  thresholdPx: number;
  resetKey: string;
  enabled: boolean;
  onFirstPage?: (res: FeedResult) => void;
}

export interface WindowedFeed {
  items: FeedItem[];
  /** In-place update of the windowed items (vote/delete/bookmark); keeps the ref in sync. */
  mutate: (fn: (items: FeedItem[]) => FeedItem[]) => void;
  listRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
  loadingAfter: boolean;
  loadingBefore: boolean;
  hasMoreAfter: boolean;
  hasMoreBefore: boolean;
  error: string | null;
}

interface WinState {
  items: FeedItem[];
  start: number; // global offset of items[0]
  hasMoreAfter: boolean;
}

export function useWindowedFeed({
  fetchPage,
  pageSize,
  windowPages,
  thresholdPx,
  resetKey,
  enabled,
  onFirstPage,
}: Args): WindowedFeed {
  const maxItems = pageSize * windowPages;

  const [items, setItemsState] = useState<FeedItem[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [hasMoreAfter, setHasMoreAfter] = useState(false);
  const [loadingAfter, setLoadingAfter] = useState(false);
  const [loadingBefore, setLoadingBefore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  // Single source of truth for the window, mutated synchronously by the loaders.
  const win = useRef<WinState>({ items: [], start: 0, hasMoreAfter: false });
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const onFirstPageRef = useRef(onFirstPage);
  onFirstPageRef.current = onFirstPage;
  const loadingRef = useRef(false);

  // Reflect the window ref into React state for rendering.
  const commit = useCallback(() => {
    setItemsState(win.current.items);
    setHasMoreAfter(win.current.hasMoreAfter);
    setHasMoreBefore(win.current.start > 0);
  }, []);

  // In-place mutation from the host (vote/delete/bookmark) — update the ref AND state
  // together so the next load's offset/dedupe math sees the same list the user does.
  const mutate = useCallback((fn: (items: FeedItem[]) => FeedItem[]) => {
    win.current = { ...win.current, items: fn(win.current.items) };
    setItemsState(win.current.items);
  }, []);

  // Scroll anchor: pin a reference row (one that SURVIVES the update) to its viewport
  // position. A scrollHeight delta is wrong when prepend+bottom-trim keep the height
  // constant — it would leave scrollTop at 0 and wedge further paging. We instead
  // record the reference row's viewport-relative top before the change and restore it
  // after layout (works with variable row heights).
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const rowTop = (el: HTMLDivElement, id: string): number | null => {
    const row = el.querySelector<HTMLElement>(`.version-row[data-vid="${CSS.escape(id)}"]`);
    return row ? row.getBoundingClientRect().top : null;
  };
  const captureAnchor = (id: string | undefined) => {
    const el = listRef.current;
    if (!el || !id) return;
    const top = rowTop(el, id);
    if (top !== null) anchorRef.current = { id, top };
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && anchorRef.current) {
      const now = rowTop(el, anchorRef.current.id);
      if (now !== null) el.scrollTop += now - anchorRef.current.top;
      anchorRef.current = null;
    }
  }, [items]);

  // Reset to page 0 on resetKey / enabled / pageSize change.
  useEffect(() => {
    if (!enabled) {
      win.current = { items: [], start: 0, hasMoreAfter: false };
      commit();
      return;
    }
    let cancelled = false;
    loadingRef.current = true;
    setLoadingAfter(true);
    setError(null);
    fetchRef
      .current(0, pageSize)
      .then((res) => {
        if (cancelled) return;
        anchorRef.current = null; // a reset jumps to top
        win.current = { items: res.versions, start: 0, hasMoreAfter: res.hasMore };
        commit();
        const el = listRef.current;
        if (el) el.scrollTop = 0;
        onFirstPageRef.current?.(res);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        win.current = { items: [], start: 0, hasMoreAfter: false };
        commit();
        setError((e as Error)?.message || 'Could not reach the server');
      })
      .finally(() => {
        if (!cancelled) {
          loadingRef.current = false;
          setLoadingAfter(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resetKey, enabled, pageSize, commit]);

  const loadAfter = useCallback(async () => {
    if (loadingRef.current || !win.current.hasMoreAfter) return;
    loadingRef.current = true;
    setLoadingAfter(true);
    try {
      const { items: cur, start } = win.current;
      const res = await fetchRef.current(start + cur.length, pageSize);
      const seen = new Set(cur.map((v) => v.id));
      const fresh = res.versions.filter((v) => !seen.has(v.id));
      let next = [...cur, ...fresh];
      let removed = 0;
      if (next.length > maxItems) {
        removed = next.length - maxItems;
        next = next.slice(removed); // trim from the top
      }
      if (removed > 0) captureAnchor(next[0]?.id); // pin the new first row (survives the trim)
      win.current = { items: next, start: start + removed, hasMoreAfter: res.hasMore };
      commit();
    } catch {
      /* transient — leave the window as-is */
    } finally {
      loadingRef.current = false;
      setLoadingAfter(false);
    }
  }, [pageSize, maxItems, commit]);

  const loadBefore = useCallback(async () => {
    if (loadingRef.current || win.current.start <= 0) return;
    loadingRef.current = true;
    setLoadingBefore(true);
    try {
      const { items: cur, start } = win.current;
      const offset = Math.max(0, start - pageSize);
      const res = await fetchRef.current(offset, start - offset);
      const seen = new Set(cur.map((v) => v.id));
      const fresh = res.versions.filter((v) => !seen.has(v.id));
      if (fresh.length > 0) {
        let next = [...fresh, ...cur];
        let trimmedBottom = false;
        if (next.length > maxItems) {
          next = next.slice(0, maxItems); // trim from the bottom
          trimmedBottom = true;
        }
        captureAnchor(cur[0]?.id); // pin the old first row (now pushed down by the prepend)
        // Fetching from the very start ⇒ new top IS offset 0; else move by the count
        // actually prepended so dedupe can't drift `start` below items[0]'s true offset.
        win.current = {
          items: next,
          start: offset === 0 ? 0 : start - fresh.length,
          hasMoreAfter: trimmedBottom ? true : win.current.hasMoreAfter,
        };
        commit();
      } else if (offset === 0) {
        win.current = { ...win.current, start: 0 }; // at the top; stop trying
        commit();
      }
    } catch {
      /* transient */
    } finally {
      loadingRef.current = false;
      setLoadingBefore(false);
    }
  }, [pageSize, maxItems, commit]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // No rAF throttle (it can wedge if rAF is starved); loadingRef already serializes
    // the actual fetches and the guards below are cheap. Mutually exclusive,
    // bottom-priority (a short viewport can be "near" both edges at once).
    if (el.scrollHeight - (el.scrollTop + el.clientHeight) < thresholdPx) void loadAfter();
    else if (el.scrollTop < thresholdPx) void loadBefore();
  }, [loadAfter, loadBefore, thresholdPx]);

  // Auto-fill: if a page doesn't fill the viewport but more exists, keep loading so the
  // user can actually scroll (otherwise there's no scroll event to trigger loadAfter).
  useEffect(() => {
    const el = listRef.current;
    if (!el || loadingRef.current || !hasMoreAfter) return;
    if (el.scrollHeight <= el.clientHeight + thresholdPx) void loadAfter();
  }, [items, hasMoreAfter, loadAfter, thresholdPx]);

  return { items, mutate, listRef, onScroll, loadingAfter, loadingBefore, hasMoreAfter, hasMoreBefore, error };
}
