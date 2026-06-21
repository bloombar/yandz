/**
 * Renders visual patch ops (drawingOverlay, annotation) as a transparent overlay
 * layer on top of the page, WITHOUT mutating host DOM. Drawings are perfect-freehand
 * strokes; annotations are highlight boxes or note pins. Everything is anchored to a
 * matched element's bounding box (in percentages) and re-positioned on resize/scroll
 * so it tracks responsive layouts.
 */
import { getStroke } from 'perfect-freehand';
import { matchTarget } from '../engine/matcher.js';
import type { AnyPatch, DrawingStroke, ElementTarget } from '@yandz/shared';

const LAYER_ID = 'yandz-overlay-layer';

/** Convert a perfect-freehand outline (points) into an SVG path string. */
function strokeToPath(points: number[][]): string {
  if (points.length === 0) return '';
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(x0!, y0!, (x0! + x1!) / 2, (y0! + y1!) / 2);
      return acc;
    },
    ['M', points[0]![0], points[0]![1], 'Q'] as (string | number)[],
  );
  return [...d, 'Z'].join(' ');
}

/** Resolve the anchor rect for a target, falling back to the viewport. */
function anchorRect(target: ElementTarget): DOMRect {
  const { element } = matchTarget(target);
  if (element) return element.getBoundingClientRect();
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/**
 * Overlay renderer for one page. Call render(patches) after applying a version;
 * it (re)builds the overlay and keeps it positioned until clear() is called.
 */
export class OverlayRenderer {
  private layer: HTMLDivElement | null = null;
  private patches: AnyPatch[] = [];
  private reflow = () => this.draw();

  /** Render the visual patches in a list (ignores non-visual ops). */
  render(patches: AnyPatch[]): void {
    this.patches = patches.filter((p) => p.op === 'drawingOverlay' || p.op === 'annotation');
    this.ensureLayer();
    this.draw();
    window.addEventListener('resize', this.reflow, { passive: true });
    window.addEventListener('scroll', this.reflow, { passive: true });
  }

  /** Remove the overlay and stop tracking layout. */
  clear(): void {
    window.removeEventListener('resize', this.reflow);
    window.removeEventListener('scroll', this.reflow);
    this.layer?.remove();
    this.layer = null;
    this.patches = [];
  }

  private ensureLayer(): void {
    if (this.layer) return;
    const layer = document.createElement('div');
    layer.id = LAYER_ID;
    // Fixed, full-viewport, click-through overlay above page content.
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;pointer-events:none;overflow:visible;';
    (document.body ?? document.documentElement).appendChild(layer);
    this.layer = layer;
  }

  /** Redraw all visual patches at current layout positions. */
  private draw(): void {
    if (!this.layer) return;
    this.layer.replaceChildren();
    for (const patch of this.patches) {
      if (patch.op === 'drawingOverlay') this.drawStrokes(patch.target, patch.payload.strokes);
      else if (patch.op === 'annotation') this.drawAnnotation(patch);
    }
  }

  /** Render freehand strokes positioned relative to the anchor box. */
  private drawStrokes(target: ElementTarget, strokes: DrawingStroke[]): void {
    const rect = anchorRect(target);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', `position:absolute;left:${rect.left}px;top:${rect.top}px;overflow:visible;`);
    svg.setAttribute('width', `${rect.width}`);
    svg.setAttribute('height', `${rect.height}`);
    for (const stroke of strokes) {
      // Points are stored as percentages of the anchor box → back to pixels.
      const pts = stroke.points.map(([xp, yp, pr]) => [
        (xp / 100) * rect.width,
        (yp / 100) * rect.height,
        pr ?? 0.5,
      ]);
      const outline = getStroke(pts, { size: Math.max(2, stroke.sizePct * rect.width) });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', strokeToPath(outline));
      path.setAttribute('fill', stroke.color);
      svg.appendChild(path);
    }
    this.layer!.appendChild(svg);
  }

  /** Render a highlight box or an expandable note pin over the anchor. */
  private drawAnnotation(patch: Extract<AnyPatch, { op: 'annotation' }>): void {
    const rect = anchorRect(patch.target);
    const el = document.createElement('div');
    if (patch.payload.kind === 'highlight') {
      el.style.cssText =
        `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;` +
        `height:${rect.height}px;background:${patch.payload.color};opacity:.35;border-radius:2px;`;
    } else {
      // Note: a small pin at the top-right of the anchor; pointer-events re-enabled
      // so it can be hovered to reveal the body text.
      el.title = patch.payload.body ?? '';
      el.textContent = '📌';
      el.style.cssText =
        `position:absolute;left:${rect.right - 8}px;top:${rect.top - 8}px;` +
        `font-size:16px;pointer-events:auto;cursor:help;`;
    }
    this.layer!.appendChild(el);
  }
}
