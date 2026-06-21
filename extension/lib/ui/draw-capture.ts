/**
 * Freehand drawing capture. Activates a transparent full-viewport layer that
 * intercepts pointer events and records strokes (stored as PERCENTAGES of the
 * viewport so they reposition responsively).
 *
 * Auto-save: after `debounceMs` of no drawing, the accumulated strokes are emitted
 * via onStrokes (and again on stop), so the in-progress drawing is saved into the
 * version without the user having to explicitly finish. The layer stays active so
 * the user can keep drawing; stop() (or Escape) tears it down with a final emit.
 */
import type { DrawingStroke } from '@yandz/shared';

export interface DrawOptions {
  color?: string;
  /** Stroke size as a fraction of viewport width. */
  sizePct?: number;
  /** Idle time before the current strokes are auto-emitted. */
  debounceMs?: number;
  /** Called with ALL strokes so far on each idle tick and on stop. */
  onStrokes: (strokes: DrawingStroke[]) => void;
}

const LAYER_ID = 'yandz-draw-capture';

/** Begin freehand capture. Returns a stop() that finishes and cleans up. */
export function startDrawing(opts: DrawOptions): () => void {
  const color = opts.color ?? '#e11';
  const sizePct = opts.sizePct ?? 0.004;
  const debounceMs = opts.debounceMs ?? 1500;

  const layer = document.createElement('canvas');
  layer.id = LAYER_ID;
  layer.width = window.innerWidth;
  layer.height = window.innerHeight;
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;touch-action:none;';
  document.documentElement.appendChild(layer);
  const cx = layer.getContext('2d')!;
  cx.strokeStyle = color;
  cx.lineWidth = Math.max(2, sizePct * window.innerWidth);
  cx.lineCap = 'round';
  cx.lineJoin = 'round';

  const strokes: DrawingStroke[] = [];
  let drawing = false;
  let pts: Array<[number, number, number?]> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Percentage-of-viewport coords for responsive storage. */
  const toPct = (e: PointerEvent): [number, number, number] => [
    (e.clientX / window.innerWidth) * 100,
    (e.clientY / window.innerHeight) * 100,
    e.pressure || 0.5,
  ];

  /** Emit the accumulated strokes after a period of no drawing. */
  function scheduleEmit(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (strokes.length) opts.onStrokes([...strokes]);
    }, debounceMs);
  }

  const down = (e: PointerEvent) => {
    if (timer) clearTimeout(timer);
    drawing = true;
    pts = [toPct(e)];
    cx.beginPath();
    cx.moveTo(e.clientX, e.clientY);
  };
  const move = (e: PointerEvent) => {
    if (!drawing) return;
    pts.push(toPct(e));
    cx.lineTo(e.clientX, e.clientY);
    cx.stroke();
  };
  const up = () => {
    if (!drawing) return;
    drawing = false;
    if (pts.length > 1) strokes.push({ points: pts, color, sizePct });
    scheduleEmit(); // auto-save after this stroke if no further drawing
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };

  layer.addEventListener('pointerdown', down);
  layer.addEventListener('pointermove', move);
  layer.addEventListener('pointerup', up);
  document.addEventListener('keydown', key, true);

  function stop(): void {
    if (timer) clearTimeout(timer);
    layer.removeEventListener('pointerdown', down);
    layer.removeEventListener('pointermove', move);
    layer.removeEventListener('pointerup', up);
    document.removeEventListener('keydown', key, true);
    layer.remove();
    if (strokes.length) opts.onStrokes([...strokes]); // final save
  }

  return stop;
}
