/**
 * Unit tests for the migration's scope-collapse heuristic.
 */
import { describe, it, expect } from 'vitest';
import { broadestScope } from './scope-migration.js';

describe('broadestScope', () => {
  it('returns global when any patch was global', () => {
    expect(broadestScope([{ scope: 'page' }, { scope: 'global' }, { scope: 'site' }])).toBe('global');
  });

  it('returns site when there is a site patch but no global', () => {
    expect(broadestScope([{ scope: 'page' }, { scope: 'site' }])).toBe('site');
  });

  it('returns page when all patches were page (or unscoped)', () => {
    expect(broadestScope([{ scope: 'page' }, {}])).toBe('page');
    expect(broadestScope([])).toBe('page');
  });
});
