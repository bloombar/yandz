/**
 * Human-friendly one-line summary of a patch, shown in the "Changes" list (both the
 * editable editor and the read-only version view).
 */
import type { AnyPatch } from '@yandz/shared';

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A text preview for text edits, or a short description of the operation. */
export function describePatch(p: AnyPatch): string {
  switch (p.op) {
    case 'textReplace':
      return `Text: “${clip(p.payload.to ?? '', 40)}”`;
    case 'imageSwap':
      return 'Image swap';
    case 'cssOverride':
      return 'Style change';
    case 'attrChange':
      return `Set ${p.payload.attr}`;
    case 'drawingOverlay':
      return 'Drawing overlay';
    case 'annotation':
      return p.payload.kind === 'highlight' ? 'Highlight' : `Note: “${clip(p.payload.body ?? '', 30)}”`;
    default:
      return (p as AnyPatch).op;
  }
}
