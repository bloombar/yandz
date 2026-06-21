import { describe, it, expect } from 'vitest';
import { diffVersions, patchKey } from './diff.js';
import type { AnyPatch } from '@yandz/shared';

const text = (sel: string, to: string): AnyPatch => ({
  op: 'textReplace',
  target: { cssSelector: sel },
  order: 0,
  payload: { from: '', to },
});

describe('patchKey', () => {
  it('combines op and locator', () => {
    expect(patchKey(text('#a', 'x'))).toBe('textReplace::#a');
  });
});

describe('diffVersions', () => {
  it('classifies added, removed, changed and unchanged', () => {
    const before = [text('#a', 'one'), text('#b', 'keep'), text('#c', 'gone')];
    const after = [text('#a', 'ONE'), text('#b', 'keep'), text('#d', 'fresh')];
    const entries = diffVersions(before, after);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.kind]));
    expect(byKey['textReplace::#a']).toBe('changed');
    expect(byKey['textReplace::#b']).toBe('unchanged');
    expect(byKey['textReplace::#c']).toBe('removed');
    expect(byKey['textReplace::#d']).toBe('added');
  });

  it('produces an inline word diff for changed text', () => {
    const entries = diffVersions([text('#a', 'hello world')], [text('#a', 'hello there')]);
    const changed = entries.find((e) => e.kind === 'changed');
    expect(changed?.inline?.some((s) => s.added)).toBe(true);
    expect(changed?.inline?.some((s) => s.removed)).toBe(true);
  });

  it('diffs cssOverride declarations', () => {
    const css = (decls: Record<string, string>): AnyPatch => ({
      op: 'cssOverride',
      target: { cssSelector: '#x' },
      order: 0,
      payload: { declarations: decls },
    });
    const entries = diffVersions([css({ color: 'red' })], [css({ color: 'blue' })]);
    expect(entries[0]!.kind).toBe('changed');
  });
});
