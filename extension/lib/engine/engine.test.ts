/**
 * Engine tests: the matcher cascade and the applier's apply/revert behavior,
 * exercised against jsdom DOMs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { matchTarget, normalizeText, ACCEPT_THRESHOLD } from './matcher.js';
import { PatchEngine } from './applier.js';
import type { AnyPatch } from '@yandz/shared';

function setBody(html: string) {
  document.body.innerHTML = html;
}

describe('matcher', () => {
  it('resolves a unique css selector with full confidence', () => {
    setBody('<h1 id="t">Hello</h1>');
    const r = matchTarget({ cssSelector: '#t' });
    expect(r.strategy).toBe('cssSelector');
    expect(r.element?.textContent).toBe('Hello');
    expect(r.confidence).toBe(1);
  });

  it('rejects an ambiguous css selector and falls back', () => {
    setBody('<p class="x">a</p><p class="x">b</p><div role="main">a</div>');
    // .x matches two → not unique → falls through to attr fingerprint.
    const r = matchTarget({ cssSelector: '.x', attrFingerprint: { role: 'main' } });
    expect(r.strategy).toBe('attrFingerprint');
  });

  it('matches by text fingerprint when selectors miss', () => {
    setBody('<div><span>Click me</span></div>');
    const r = matchTarget({ cssSelector: '#missing', textFingerprint: '  CLICK ME ' });
    expect(r.strategy).toBe('textFingerprint');
    expect(r.element?.tagName).toBe('SPAN');
  });

  it('falls back to domPath last', () => {
    setBody('<main><section><b>x</b></section></main>');
    const r = matchTarget({ domPath: 'main > section:nth-child(1) > b:nth-child(1)' });
    expect(r.strategy).toBe('domPath');
  });

  it('returns none when nothing resolves', () => {
    setBody('<div></div>');
    const r = matchTarget({ cssSelector: '#nope', textFingerprint: 'absent' });
    expect(r.strategy).toBe('none');
    expect(r.element).toBeNull();
  });

  it('attr matching requires a unique winner above threshold', () => {
    setBody('<a data-testid="buy">1</a><a data-testid="buy">2</a>');
    const r = matchTarget({ attrFingerprint: { 'data-testid': 'buy' } });
    // Two equal matches → ambiguous → rejected.
    expect(r.element).toBeNull();
    expect(ACCEPT_THRESHOLD).toBeGreaterThan(0);
  });

  it('normalizeText collapses whitespace and lowercases', () => {
    expect(normalizeText('  Foo   BAR\n')).toBe('foo bar');
  });
});

describe('PatchEngine apply/revert', () => {
  let engine: PatchEngine;
  beforeEach(() => {
    engine = new PatchEngine();
  });

  it('applies textReplace and reverts exactly', () => {
    setBody('<h1 id="t">Hello world</h1>');
    const patch: AnyPatch = {
      op: 'textReplace',
      target: { cssSelector: '#t' },
      order: 0,
      payload: { from: 'Hello', to: 'Goodbye' },
    };
    const out = engine.apply([patch]);
    expect(out.applied).toBe(1);
    expect(document.querySelector('#t')?.textContent).toBe('Goodbye');
    engine.revertAll();
    expect(document.querySelector('#t')?.textContent).toBe('Hello world');
  });

  it('does not apply textReplace when the original no longer matches', () => {
    setBody('<h1 id="t">Changed</h1>');
    const patch: AnyPatch = {
      op: 'textReplace',
      target: { cssSelector: '#t' },
      order: 0,
      payload: { from: 'Hello', to: 'Goodbye' },
    };
    const out = engine.apply([patch]);
    expect(out.applied).toBe(0);
    expect(out.unresolved).toHaveLength(1);
  });

  it('strips markup from textReplace payloads', () => {
    setBody('<p id="p">x</p>');
    const patch: AnyPatch = {
      op: 'textReplace',
      target: { cssSelector: '#p' },
      order: 0,
      payload: { from: '', to: '<img src=x onerror=alert(1)>hi' },
    };
    engine.apply([patch]);
    expect(document.querySelector('#p')?.textContent).toBe('hi');
  });

  it('injects cssOverride as a scoped stylesheet and removes it on revert', () => {
    setBody('<div id="d">x</div>');
    const patch: AnyPatch = {
      op: 'cssOverride',
      target: { cssSelector: '#d' },
      order: 0,
      payload: { declarations: { color: 'red' } },
    };
    engine.apply([patch]);
    const style = document.querySelector('style[data-yandz="overrides"]');
    expect(style?.textContent).toContain('#d { color: red; }');
    engine.revertAll();
    expect(document.querySelector('style[data-yandz="overrides"]')).toBeNull();
  });

  it('reverts attrChange to the prior value (and removes when absent)', () => {
    setBody('<img id="i" alt="old">');
    const patch: AnyPatch = {
      op: 'attrChange',
      target: { cssSelector: '#i' },
      order: 0,
      payload: { attr: 'alt', value: 'new' },
    };
    engine.apply([patch]);
    expect(document.querySelector('#i')?.getAttribute('alt')).toBe('new');
    engine.revertAll();
    expect(document.querySelector('#i')?.getAttribute('alt')).toBe('old');
  });

  it('marks a rejected (unsafe) patch as unresolved', () => {
    setBody('<a id="a">x</a>');
    const patch: AnyPatch = {
      op: 'attrChange',
      target: { cssSelector: '#a' },
      order: 0,
      payload: { attr: 'onclick', value: 'evil()' },
    };
    const out = engine.apply([patch]);
    expect(out.applied).toBe(0);
    expect(out.unresolved).toHaveLength(1);
  });
});
