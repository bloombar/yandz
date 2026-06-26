/**
 * Unit tests for the style-editor helpers.
 */
import { describe, it, expect } from 'vitest';
import { stepFontSize, cssColorToHex, isBoldWeight, mergeStyle, upsertAttr, removeAttr, setTextPatch } from './style-edit.js';
import type { AnyPatch } from '@yandz/shared';

const target = { cssSelector: 'h1' };
const css = (declarations: Record<string, string>): AnyPatch =>
  ({ op: 'cssOverride', target, payload: { declarations }, order: 0 }) as AnyPatch;

describe('stepFontSize', () => {
  it('steps a px size up and down', () => {
    expect(stepFontSize('16px', 2)).toBe('18px');
    expect(stepFontSize('16px', -2)).toBe('14px');
  });
  it('clamps to the minimum and tolerates junk', () => {
    expect(stepFontSize('9px', -4)).toBe('8px');
    expect(stepFontSize('', 2)).toBe('18px'); // defaults base 16
  });
});

describe('cssColorToHex', () => {
  it('passes through and normalizes hex', () => {
    expect(cssColorToHex('#AABBCC', '#000')).toBe('#aabbcc');
    expect(cssColorToHex('#abc', '#000')).toBe('#aabbcc');
  });
  it('converts rgb/rgba', () => {
    expect(cssColorToHex('rgb(255, 0, 16)', '#000')).toBe('#ff0010');
    expect(cssColorToHex('rgba(0, 128, 255, 0.5)', '#000')).toBe('#0080ff');
  });
  it('falls back for transparent or unparseable', () => {
    expect(cssColorToHex('rgba(0,0,0,0)', '#ffffff')).toBe('#ffffff');
    expect(cssColorToHex('papayawhip', '#123456')).toBe('#123456');
    expect(cssColorToHex(undefined, '#123456')).toBe('#123456');
  });
});

describe('isBoldWeight', () => {
  it('recognizes keyword and numeric bold', () => {
    expect(isBoldWeight('bold')).toBe(true);
    expect(isBoldWeight('700')).toBe(true);
    expect(isBoldWeight('800')).toBe(true);
  });
  it('rejects normal weights', () => {
    expect(isBoldWeight('400')).toBe(false);
    expect(isBoldWeight('normal')).toBe(false);
    expect(isBoldWeight(undefined)).toBe(false);
  });
});

describe('mergeStyle', () => {
  it('creates a cssOverride patch when none exists', () => {
    const next = mergeStyle([], target, { color: 'red' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ op: 'cssOverride', payload: { declarations: { color: 'red' } } });
  });
  it('merges into the existing patch (one per element)', () => {
    const next = mergeStyle([css({ color: 'red' })], target, { 'font-size': '20px' });
    expect(next).toHaveLength(1);
    expect((next[0] as any).payload.declarations).toEqual({ color: 'red', 'font-size': '20px' });
  });
  it("removes a declaration set to '' and drops the patch when empty", () => {
    const oneLeft = mergeStyle([css({ color: 'red', display: 'none' })], target, { display: '' });
    expect((oneLeft[0] as any).payload.declarations).toEqual({ color: 'red' });
    const emptied = mergeStyle([css({ display: 'none' })], target, { display: '' });
    expect(emptied).toHaveLength(0);
  });
  it('does not touch other elements’ patches', () => {
    const other = { op: 'cssOverride', target: { cssSelector: 'p' }, payload: { declarations: { color: 'blue' } }, order: 0 } as AnyPatch;
    const next = mergeStyle([other], target, { color: 'red' });
    expect(next).toHaveLength(2);
  });
});

describe('setTextPatch', () => {
  it('adds then updates a single textReplace for the element', () => {
    let next = setTextPatch([], target, 'Hi', 'Hello');
    expect(next[0]).toMatchObject({ op: 'textReplace', payload: { from: 'Hi', to: 'Hello' } });
    next = setTextPatch(next, target, 'Hi', 'Howdy');
    expect(next).toHaveLength(1);
    expect((next[0] as any).payload).toEqual({ from: 'Hi', to: 'Howdy' });
  });
  it('drops the patch when text reverts to the original', () => {
    const start = setTextPatch([], target, 'Hi', 'Hello');
    expect(setTextPatch(start, target, 'Hi', 'Hi')).toHaveLength(0);
    expect(setTextPatch([], target, 'Hi', 'Hi')).toHaveLength(0); // no-op when unchanged
  });
});

describe('upsertAttr / removeAttr', () => {
  it('adds an attrChange capturing the original value, then replaces it', () => {
    let next = upsertAttr([], target, 'title', 'Hi', 'old');
    expect(next[0]).toMatchObject({ op: 'attrChange', payload: { attr: 'title', value: 'Hi', from: 'old' } });
    next = upsertAttr(next, target, 'title', 'Bye', 'old');
    expect(next).toHaveLength(1);
    expect((next[0] as any).payload.value).toBe('Bye');
  });
  it('removes only the matching attribute', () => {
    const start = upsertAttr(upsertAttr([], target, 'title', 'a'), target, 'alt', 'b');
    const next = removeAttr(start, target, 'title');
    expect(next).toHaveLength(1);
    expect((next[0] as any).payload.attr).toBe('alt');
  });
});
