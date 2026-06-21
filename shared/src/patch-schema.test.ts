import { describe, it, expect } from 'vitest';
import {
  validatePatch,
  validatePatchList,
  isForbiddenAttr,
  isSafeUrl,
  isSafeCssValue,
  type AnyPatch,
} from './patch-schema.js';

const target = { cssSelector: '#x' };

describe('attribute guards', () => {
  it('flags event-handler attributes', () => {
    expect(isForbiddenAttr('onclick')).toBe(true);
    expect(isForbiddenAttr('ONLOAD')).toBe(true);
    expect(isForbiddenAttr('srcdoc')).toBe(true);
    expect(isForbiddenAttr('style')).toBe(true);
    expect(isForbiddenAttr('alt')).toBe(false);
  });
});

describe('url guards', () => {
  it('rejects dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('  DATA:text/html,x')).toBe(false);
    expect(isSafeUrl('https://example.com/a.png')).toBe(true);
  });
});

describe('css guards', () => {
  it('rejects expression/binding/import', () => {
    expect(isSafeCssValue('expression(alert(1))')).toBe(false);
    expect(isSafeCssValue('url(javascript:x)')).toBe(false);
    expect(isSafeCssValue('#fff')).toBe(true);
  });
});

describe('validatePatch', () => {
  it('accepts a safe attrChange', () => {
    const p: AnyPatch = { op: 'attrChange', target, order: 0, payload: { attr: 'alt', value: 'hi' } };
    expect(validatePatch(p).ok).toBe(true);
  });

  it('rejects a forbidden attr', () => {
    const p: AnyPatch = { op: 'attrChange', target, order: 0, payload: { attr: 'onclick', value: 'x' } };
    expect(validatePatch(p)).toMatchObject({ ok: false });
  });

  it('rejects a non-whitelisted attr', () => {
    const p: AnyPatch = { op: 'attrChange', target, order: 0, payload: { attr: 'ping', value: 'x' } };
    expect(validatePatch(p).ok).toBe(false);
  });

  it('rejects an unsafe href value', () => {
    const p: AnyPatch = { op: 'attrChange', target, order: 0, payload: { attr: 'href', value: 'javascript:x' } };
    expect(validatePatch(p).ok).toBe(false);
  });

  it('rejects unsafe css declarations (value)', () => {
    const p: AnyPatch = {
      op: 'cssOverride',
      target,
      order: 0,
      payload: { declarations: { color: 'expression(x)' } },
    };
    expect(validatePatch(p).ok).toBe(false);
  });

  it('rejects unsafe css declarations (property name)', () => {
    const p: AnyPatch = {
      op: 'cssOverride',
      target,
      order: 0,
      payload: { declarations: { '-moz-binding': 'red' } },
    };
    expect(validatePatch(p).ok).toBe(false);
  });

  it('accepts safe css declarations', () => {
    const p: AnyPatch = {
      op: 'cssOverride',
      target,
      order: 0,
      payload: { declarations: { color: '#fff', 'font-size': '14px' } },
    };
    expect(validatePatch(p).ok).toBe(true);
  });

  it('accepts a safe imageSwap', () => {
    const p: AnyPatch = {
      op: 'imageSwap',
      target,
      order: 0,
      payload: { originalSrcHash: 'h', newAssetUrl: 'https://cdn.example.com/a.png' },
    };
    expect(validatePatch(p).ok).toBe(true);
  });

  it('rejects a null/non-object patch', () => {
    expect(validatePatch(null as unknown as AnyPatch).ok).toBe(false);
  });

  it('rejects an unsafe image url', () => {
    const p: AnyPatch = {
      op: 'imageSwap',
      target,
      order: 0,
      payload: { originalSrcHash: 'h', newAssetUrl: 'data:x' },
    };
    expect(validatePatch(p).ok).toBe(false);
  });

  it('accepts textReplace, drawingOverlay, annotation', () => {
    const ps: AnyPatch[] = [
      { op: 'textReplace', target, order: 0, payload: { from: 'a', to: 'b' } },
      { op: 'drawingOverlay', target, order: 1, payload: { strokes: [] } },
      { op: 'annotation', target, order: 2, payload: { kind: 'note', color: '#ff0', body: 'hi' } },
    ];
    expect(validatePatchList(ps).ok).toBe(true);
  });

  it('rejects missing target / unknown op', () => {
    expect(validatePatch({ op: 'textReplace', order: 0, payload: { from: '', to: '' } } as unknown as AnyPatch).ok).toBe(
      false,
    );
    expect(validatePatch({ op: 'nope', target, order: 0, payload: {} } as unknown as AnyPatch).ok).toBe(false);
  });

  it('validatePatchList returns the first failure', () => {
    const ps: AnyPatch[] = [
      { op: 'textReplace', target, order: 0, payload: { from: 'a', to: 'b' } },
      { op: 'attrChange', target, order: 1, payload: { attr: 'onclick', value: 'x' } },
    ];
    expect(validatePatchList(ps).ok).toBe(false);
  });
});
