/**
 * Freehand drawing capture, anchored to a page ELEMENT (like text patches).
 *
 * Flow: while in draw mode the element under the cursor is highlighted (a transparent
 * canvas captures pointer events, so we read the element beneath it with
 * elementsFromPoint). On the first press, the drawing is locked to that target
 * element; strokes are then recorded as PERCENTAGES of the target's bounding box, so
 * the overlay renderer can re-draw them relative to that element later (tracking it
 * as the page shifts). Strokes auto-emit after a debounce (and on stop).
 */
import type { DrawingStroke } from '@yandz/shared';
import { strokeToClient } from './stroke-geometry.js';

export interface DrawOptions {
  color?: string;
  /** Stroke size as a fraction of the target's width. */
  sizePct?: number;
  /** Idle time before the current strokes are auto-emitted. */
  debounceMs?: number;
  /** Called with all strokes + the element they're anchored to, on idle and stop. */
  onStrokes: (strokes: DrawingStroke[], target: Element) => void;
}

const LAYER_ID = 'yandz-draw-capture';
const HILITE_ID = 'yandz-draw-highlight';

/** Our own injected nodes — never valid draw targets. */
function isOwnUi(el: Element | null): boolean {
  return !!el && (/^yandz-/.test(el.id) || !!el.closest?.('[id^="yandz-"]'));
}

/** Begin freehand capture. Returns a stop() that finishes and cleans up. */
export function startDrawing(opts: DrawOptions): () => void {
  const color = opts.color ?? '#e11';
  const sizePct = opts.sizePct ?? 0.01;
  const debounceMs = opts.debounceMs ?? 1500;

  // Transparent canvas that captures pointer input across the viewport.
  const layer = document.createElement('canvas');
  layer.id = LAYER_ID;
  layer.width = window.innerWidth;
  layer.height = window.innerHeight;
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;touch-action:none;';
  document.documentElement.appendChild(layer);
  const cx = layer.getContext('2d')!;
  cx.strokeStyle = color;
  cx.lineCap = 'round';
  cx.lineJoin = 'round';

  // Hover highlight (shown until the drawing is locked to an element).
  const hilite = document.createElement('div');
  hilite.id = HILITE_ID;
  hilite.style.cssText =
    'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4c9ffe;' +
    'background:rgba(76,159,254,.12);border-radius:2px;display:none;';
  document.documentElement.appendChild(hilite);

  const strokes: DrawingStroke[] = [];
  let target: Element | null = null; // locked on first press
  let targetRect: DOMRect | null = null;
  let drawing = false;
  let pts: Array<[number, number, number?]> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The topmost page element under a point (ignoring our own overlay/canvas). */
  function elementUnder(x: number, y: number): Element | null {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el !== layer && el !== hilite && !isOwnUi(el)) return el;
    }
    return null;
  }

  function showHighlight(el: Element): void {
    const r = el.getBoundingClientRect();
    hilite.style.display = 'block';
    hilite.style.left = `${r.left}px`;
    hilite.style.top = `${r.top}px`;
    hilite.style.width = `${r.width}px`;
    hilite.style.height = `${r.height}px`;
  }

  /** A point as a percentage of the (locked) target's bounding box. */
  function toPct(e: PointerEvent): [number, number, number] {
    const r = targetRect!;
    return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100, e.pressure || 0.5];
  }

  function scheduleEmit(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (strokes.length && target) opts.onStrokes([...strokes], target);
    }, debounceMs);
  }

  const move = (e: PointerEvent) => {
    if (drawing) {
      pts.push(toPct(e));
      cx.lineTo(e.clientX, e.clientY);
      cx.stroke();
    } else {
      const el = elementUnder(e.clientX, e.clientY);
      if (el) showHighlight(el);
      else hilite.style.display = 'none';
    }
  };

  const down = (e: PointerEvent) => {
    if (timer) clearTimeout(timer);
    // Lock the drawing to the element under the first press; reuse it thereafter.
    if (!target) target = elementUnder(e.clientX, e.clientY);
    if (!target) return;
    targetRect = target.getBoundingClientRect(); // refresh each stroke (handles scroll)
    hilite.style.display = 'none';
    cx.lineWidth = Math.max(2, sizePct * targetRect.width);
    drawing = true;
    pts = [toPct(e)];
    cx.beginPath();
    cx.moveTo(e.clientX, e.clientY);
  };

  const up = () => {
    if (!drawing) return;
    drawing = false;
    if (pts.length > 1) strokes.push({ points: pts, color, sizePct });
    scheduleEmit();
  };

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };

  /** Repaint committed strokes from their stored percentages relative to the target's
   *  CURRENT position, so the live drawing tracks the element as the page scrolls or
   *  reflows — matching how the saved overlay behaves (the bug was that this fixed
   *  canvas kept its strokes at their original viewport coordinates). */
  function redraw(): void {
    cx.clearRect(0, 0, layer.width, layer.height);
    if (!target || strokes.length === 0) return;
    const r = target.getBoundingClientRect();
    cx.lineWidth = Math.max(2, sizePct * r.width);
    for (const s of strokes) {
      const clientPts = strokeToClient(s.points, r);
      cx.beginPath();
      clientPts.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
      cx.stroke();
    }
  }

  // Track scroll/resize so committed strokes stay anchored to the target. Skipped while
  // a stroke is in progress (you're drawing, not scrolling). Mirrors the overlay renderer.
  const reflow = () => {
    if (drawing) return;
    if (layer.width !== window.innerWidth || layer.height !== window.innerHeight) {
      layer.width = window.innerWidth;
      layer.height = window.innerHeight;
      // Resizing a canvas resets its 2D context state — restore stroke styling.
      cx.strokeStyle = color;
      cx.lineCap = 'round';
      cx.lineJoin = 'round';
    }
    redraw();
  };

  layer.addEventListener('pointerdown', down);
  layer.addEventListener('pointermove', move);
  layer.addEventListener('pointerup', up);
  document.addEventListener('keydown', key, true);
  window.addEventListener('scroll', reflow, { passive: true });
  window.addEventListener('resize', reflow, { passive: true });

  function stop(): void {
    if (timer) clearTimeout(timer);
    layer.removeEventListener('pointerdown', down);
    layer.removeEventListener('pointermove', move);
    layer.removeEventListener('pointerup', up);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', reflow);
    window.removeEventListener('resize', reflow);
    layer.remove();
    hilite.remove();
    if (strokes.length && target) opts.onStrokes([...strokes], target); // final save
  }

  return stop;
}
