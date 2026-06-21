import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizePatchList } from './sanitize.js';
import type { AnyPatch } from '@yandz/shared';

const target = { cssSelector: '#x' };

describe('sanitizeText', () => {
  it('strips all markup, keeping text', () => {
    expect(sanitizeText('<b onclick="x()">hi</b><script>evil()</script>')).toBe('hi');
  });
});

describe('sanitizePatchList', () => {
  it('sanitizes textReplace target text', () => {
    const patches: AnyPatch[] = [
      { op: 'textReplace', target, order: 0, payload: { from: 'a', to: '<img src=x onerror=alert(1)>b' } },
    ];
    const result = sanitizePatchList(patches);
    expect(result.ok).toBe(true);
    expect((result.patches![0].payload as { to: string }).to).not.toContain('onerror');
  });

  it('sanitizes annotation bodies', () => {
    const patches: AnyPatch[] = [
      { op: 'annotation', target, order: 0, payload: { kind: 'note', color: '#ff0', body: '<script>x</script>note' } },
    ];
    const result = sanitizePatchList(patches);
    expect((result.patches![0].payload as { body: string }).body).toBe('note');
  });

  it('passes through ops without text fields unchanged', () => {
    const patches: AnyPatch[] = [
      { op: 'cssOverride', target, order: 0, payload: { declarations: { color: '#fff' } } },
      { op: 'annotation', target, order: 1, payload: { kind: 'highlight', color: '#ff0' } },
    ];
    expect(sanitizePatchList(patches).ok).toBe(true);
  });

  it('rejects a list containing an invalid patch', () => {
    const patches: AnyPatch[] = [
      { op: 'attrChange', target, order: 0, payload: { attr: 'onclick', value: 'x' } },
    ];
    const result = sanitizePatchList(patches);
    expect(result.ok).toBe(false);
    expect(result.patches).toBeUndefined();
  });
});
