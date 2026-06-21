/**
 * Freehand drawing capture. Activates a transparent full-viewport layer that
 * intercepts pointer events and records strokes. Points are stored as PERCENTAGES
 * of the viewport so they reposition responsively when re-rendered. Escape or the
 * returned stop() finishes capture and hands back the collected strokes.
 */
import type { DrawingStroke } from '@yandz/shared';

export interface DrawOptions {
  color?: string;
  /** Stroke size as a fraction of viewport width. */
  sizePct?: number;
  /** Called with all captured strokes when drawing finishes. */
  onFinish: (strokes: DrawingStroke[]) => void;
}

const LAYER_ID = 'yandz-draw-capture';

/** Begin freehand capture. Returns a stop() that finishes and cleans up. */
export function startDrawing(opts: DrawOptions): () => void {
  const color = opts.color ?? '#e11';
  const sizePct = opts.sizePct ?? 0.004;

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

  /** Percentage-of-viewport coords for responsive storage. */
  const toPct = (e: PointerEvent): [number, number, number] => [
    (e.clientX / window.innerWidth) * 100,
    (e.clientY / window.innerHeight) * 100,
    e.pressure || 0.5,
  ];

  const down = (e: PointerEvent) => {
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
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };

  layer.addEventListener('pointerdown', down);
  layer.addEventListener('pointermove', move);
  layer.addEventListener('pointerup', up);
  document.addEventListener('keydown', key, true);

  function stop(): void {
    layer.removeEventListener('pointerdown', down);
    layer.removeEventListener('pointermove', move);
    layer.removeEventListener('pointerup', up);
    document.removeEventListener('keydown', key, true);
    layer.remove();
    opts.onFinish(strokes);
  }

  return stop;
}
