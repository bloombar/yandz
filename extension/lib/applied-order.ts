/**
 * Ordering for the "Applied here" bar. The list reads top→bottom as highest→lowest
 * priority — the reverse of application order, so the row on top is the one that WINS where
 * versions overlap.
 *
 * Versions layer by scope (global < site < page), so page-scoped rows sit on top and
 * global at the bottom. Within a scope the LAST-applied wins, and the input arrives in
 * application order ([...dependencies, ...own]), so we reverse each scope group: a version
 * applied after its dependency (or after an earlier activation) sits ABOVE it.
 */
import type { FeedScope } from './api.js';

const SCOPE_TOP_ORDER: FeedScope[] = ['page', 'site', 'global']; // top → bottom

export function orderAppliedRows<T extends { scope: FeedScope }>(rows: T[]): T[] {
  return SCOPE_TOP_ORDER.flatMap((s) => rows.filter((r) => r.scope === s).reverse());
}
