/**
 * Data-scope cleanup — delete every row belonging to an exact data scope.
 *
 * This is the spec's single cleanup API. It is registry-driven: each scoped
 * repository registers a `ScopedCleanup` (table label + deleter + order)
 * rather than this module hardcoding a table list. That keeps cleanup coverage
 * co-located with the repositories that own each table, so a new scoped table
 * can't be silently forgotten by cleanup.
 *
 * Guarantees (design doc § "Cleanup"):
 *   - Deletes by EXACT scope, never by timestamp.
 *   - Refuses to delete the `user` scope.
 *   - Idempotent and crash-safe (deleters are DELETE-by-scope; re-running just
 *     deletes zero rows).
 *   - Per-table error isolation: one failing table reports an error and the
 *     rest still run.
 *   - Runs child tables before parent tables (deterministic `order`).
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md
 */

import { USER_SCOPE, isValidDataScope, type DataScope } from './data_scope';

export interface DeleteDataScopeResult {
  scope: DataScope;
  /** table label → rows deleted. */
  deleted: Record<string, number>;
  errors: Array<{ table: string; error: string }>;
}

export interface ScopedCleanup {
  /** Stable label used in the result + dedupe key. */
  table: string;
  /**
   * Lower runs first. Child/link tables use a low order; parent tables a
   * higher one, so referential order is respected even without FK cascades.
   * Default 100.
   */
  order?: number;
  /** Delete all rows for `scope`; return the count deleted. May be async. */
  deleteScope(scope: DataScope): number | Promise<number>;
}

const DEFAULT_ORDER = 100;

/** Registered cleanups, keyed by table for idempotent re-registration. */
const registry = new Map<string, ScopedCleanup>();

/**
 * Register (or replace, by table) a scoped cleanup. Replacing on re-register
 * makes this safe across hot-reload / re-init without double-deleting.
 */
export function registerScopedCleanup(cleanup: ScopedCleanup): void {
  registry.set(cleanup.table, cleanup);
}

/** Remove all registered cleanups (tests). */
export function clearScopedCleanups(): void {
  registry.clear();
}

/** Snapshot of registered table labels, in execution order (tests/diagnostics). */
export function registeredCleanupTables(): string[] {
  return orderedCleanups().map((c) => c.table);
}

function orderedCleanups(): ScopedCleanup[] {
  return [...registry.values()].sort(
    (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER),
  );
}

/**
 * Delete every row in `scope` across all registered scoped tables.
 *
 * Throws (does NOT return an error result) for the two cases that must never
 * be tolerated: deleting `user`, or an invalid scope. Per-table failures are
 * reported in `result.errors` and do not abort the run.
 */
export async function deleteDataScope(scope: DataScope): Promise<DeleteDataScopeResult> {
  if (scope === USER_SCOPE) {
    throw new Error('deleteDataScope: refusing to delete the user scope');
  }
  if (!isValidDataScope(scope)) {
    throw new Error(`deleteDataScope: invalid scope "${String(scope)}"`);
  }

  const result: DeleteDataScopeResult = { scope, deleted: {}, errors: [] };
  for (const cleanup of orderedCleanups()) {
    try {
      const count = await cleanup.deleteScope(scope);
      result.deleted[cleanup.table] = count;
    } catch (err) {
      result.errors.push({
        table: cleanup.table,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
