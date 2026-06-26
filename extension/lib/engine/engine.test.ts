/**
 * Engine tests: the matcher cascade and the applier's apply/revert behavior,
 * exercised against jsdom DOMs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { matchTarget, matchTemplate, generalizeSelector, normalizeText, ACCEPT_THRESHOLD } from './matcher.js';
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

  it('swaps an image and clears srcset so the new src takes effect', () => {
    setBody('<img id="i" src="old.jpg" srcset="old-2x.jpg 2x" alt="">');
    const patch: AnyPatch = {
      op: 'imageSwap',
      target: { cssSelector: '#i' },
      order: 0,
      payload: { originalSrcHash: 'h', newAssetUrl: 'https://cdn.example.com/new.png' },
    };
    engine.apply([patch]);
    const img = document.querySelector('#i') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/new.png');
    expect(img.hasAttribute('srcset')).toBe(false);
    engine.revertAll();
    expect(img.getAttribute('src')).toBe('old.jpg');
    expect(img.getAttribute('srcset')).toBe('old-2x.jpg 2x');
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

// Repeated template content: 4 cards (two "Apple" titles with src a.jpg, a "Banana",
// and an "Apple" whose title text is wrapped in a <span>), plus a decoy <h2> outside any
// card. Exercises structural family + content gate.
const CARDS = `
  <div class="card"><h2>Apple</h2><img src="a.jpg" alt=""></div>
  <div class="card"><h2>Apple</h2><img src="b.jpg" alt=""></div>
  <div class="card"><h2>Banana</h2><img src="a.jpg" alt=""></div>
  <div class="card"><h2><span>Apple</span></h2><img src="a.jpg" alt=""></div>
  <h2>Apple</h2>
`;

describe('template matching (apply to all instances)', () => {
  let engine: PatchEngine;
  beforeEach(() => {
    engine = new PatchEngine();
  });

  it('generalizeSelector strips positional pseudo-classes', () => {
    expect(generalizeSelector('.card:nth-child(2) > h2')).toBe('.card > h2');
    expect(generalizeSelector('ul > li:nth-of-type(3)')).toBe('ul > li');
    expect(generalizeSelector('#x')).toBe('#x');
  });

  it('text gate (auto textReplace) matches same OWN-text instances within the family', () => {
    setBody(CARDS);
    const patch: AnyPatch = {
      op: 'textReplace',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.card:nth-child(1) > h2', ownText: 'Apple', classSig: 'h2|' },
      payload: { from: 'Apple', to: 'Cherry' },
    };
    // The two plain-text "Apple" titles only: not "Banana", not the <span>-wrapped one
    // (own-text is empty), not the decoy <h2> (outside .card → not in the family).
    expect(matchTemplate(patch, document).map((e) => e.textContent)).toEqual(['Apple', 'Apple']);
  });

  it('styles gate (auto cssOverride on .card) matches all same-class instances', () => {
    setBody(CARDS);
    const patch: AnyPatch = {
      op: 'cssOverride',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.card:nth-child(1)', classSig: 'div|card' },
      payload: { declarations: { color: 'red' } },
    };
    expect(matchTemplate(patch, document)).toHaveLength(4); // all four .card divs
  });

  it('image gate (auto imageSwap) matches only instances with the same original src', () => {
    setBody(CARDS);
    const patch: AnyPatch = {
      op: 'imageSwap',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.card:nth-child(1) > img', classSig: 'img|' },
      payload: { originalSrcHash: 'a.jpg', newAssetUrl: 'https://cdn/x.png' },
    };
    expect(matchTemplate(patch, document)).toHaveLength(3); // a.jpg in cards 1,3,4 (not b.jpg)
  });

  it('falls back to the single element for a too-generic selector', () => {
    setBody('<h2>Apple</h2><h2>Apple</h2>');
    const patch: AnyPatch = {
      op: 'textReplace',
      order: 0,
      template: 'auto',
      target: { cssSelector: 'h2:nth-child(1)', ownText: 'Apple', classSig: 'h2|' },
      payload: { from: 'Apple', to: 'Cherry' },
    };
    // generalized 'h2' is a bare tag → not treated as a family.
    expect(matchTemplate(patch, document)).toHaveLength(1);
  });

  it('applies textReplace to every gated instance and reverts each', () => {
    setBody(CARDS);
    const patch: AnyPatch = {
      op: 'textReplace',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.card:nth-child(1) > h2', ownText: 'Apple', classSig: 'h2|' },
      payload: { from: 'Apple', to: 'Cherry' },
    };
    engine.apply([patch]);
    const titles = () => Array.from(document.querySelectorAll('.card > h2')).map((h) => h.textContent);
    expect(titles()).toEqual(['Cherry', 'Cherry', 'Banana', 'Apple']); // span-wrapped untouched
    engine.revertAll();
    expect(titles()).toEqual(['Apple', 'Apple', 'Banana', 'Apple']);
  });

  it('applies cssOverride INLINE to every gated instance and reverts the inline styles', () => {
    setBody(CARDS);
    const patch: AnyPatch = {
      op: 'cssOverride',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.card:nth-child(1)', classSig: 'div|card' },
      payload: { declarations: { color: 'red' } },
    };
    engine.apply([patch]);
    const cards = Array.from(document.querySelectorAll('.card')) as HTMLElement[];
    expect(cards.every((c) => c.style.color === 'red')).toBe(true);
    expect(document.querySelector('style[data-yandz="overrides"]')).toBeNull(); // inline, not a rule
    engine.revertAll();
    expect(cards.every((c) => c.style.color === '')).toBe(true);
  });

  it('attrChange gate (auto) only sets the attr where the original value matches', () => {
    setBody('<a class="lnk" title="on">1</a><a class="lnk" title="off">2</a><a class="lnk" title="on">3</a>');
    const patch: AnyPatch = {
      op: 'attrChange',
      order: 0,
      template: 'auto',
      target: { cssSelector: '.lnk:nth-child(1)', classSig: 'a|lnk' },
      payload: { attr: 'title', value: 'new', from: 'on' },
    };
    engine.apply([patch]);
    const vals = () => Array.from(document.querySelectorAll('.lnk')).map((a) => a.getAttribute('title'));
    expect(vals()).toEqual(['new', 'off', 'new']); // the 'off' one is left alone
    engine.revertAll();
    expect(vals()).toEqual(['on', 'off', 'on']);
  });
});
