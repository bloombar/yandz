/**
 * Pure helper for the per-patch → per-version scope migration. Kept separate from the
 * migration script (which runs on import) so it can be unit-tested in isolation.
 */
import type { VersionScope } from '@yandz/shared';

/**
 * The broadest scope present across a version's (legacy) per-patch scopes: any 'global'
 * wins, else any 'site', else 'page'. This collapses the old per-patch reach into one
 * version-level scope, preserving each version's broadest intended reach.
 */
export function broadestScope(patches: Array<{ scope?: string }>): VersionScope {
  if (patches.some((p) => p.scope === 'global')) return 'global';
  if (patches.some((p) => p.scope === 'site')) return 'site';
  return 'page';
}
