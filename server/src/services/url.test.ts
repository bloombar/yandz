import { describe, it, expect } from 'vitest';
import { normalizeUrl } from './url.js';

describe('normalizeUrl', () => {
  it('lowercases host and drops the fragment', () => {
    expect(normalizeUrl('https://Example.COM/Path#section')).toBe('https://example.com/Path');
  });

  it('strips tracking params but keeps real ones, sorted', () => {
    expect(normalizeUrl('https://x.com/a?utm_source=t&b=2&a=1&fbclid=z')).toBe('https://x.com/a?a=1&b=2');
  });

  it('drops the query entirely in path mode', () => {
    expect(normalizeUrl('https://x.com/a?b=2', 'path')).toBe('https://x.com/a');
  });

  it('drops default ports and trailing slash', () => {
    expect(normalizeUrl('https://x.com:443/a/')).toBe('https://x.com/a');
    expect(normalizeUrl('http://x.com:80/')).toBe('http://x.com/');
  });

  it('falls back to a trimmed lowercase string for non-URLs', () => {
    expect(normalizeUrl('  NotAUrl ')).toBe('notaurl');
  });
});
