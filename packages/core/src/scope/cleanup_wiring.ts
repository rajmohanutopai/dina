/**
 * Scope-cleanup wiring — registers a `ScopedCleanup` for every scoped table so
 * `deleteDataScope` covers them, and provides the teardown orchestration the
 * guided-demo finish/skip/recover flows call.
 *
 * Tables split across two DBs:
 *   - identity DB: chat_messages, reminders, people, person_surfaces
 *   - per-persona DBs: vault_items, vault_item_subjects (one pair per persona)
 *
 * Order encodes child→parent so referential order holds without FK cascades
 * (e.g. vault_item_subjects before vault_items; person_surfaces before people).
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Cleanup"
 */


import { clearActiveDemo } from './active_demo';
import { deleteDataScope, registerScopedCleanup, type DeleteDataScopeResult } from './cleanup';
import {
  USER_SCOPE,
  setCurrentDataScope,
  type DataScope,
} from './data_scope';
import { scopedTableDeleter } from './repository';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** Identity-DB scoped tables with cleanup order (child → parent). */
const IDENTITY_SCOPED_TABLES: readonly { table: string; order: number }[] = [
  { table: 'chat_messages', order: 20 },
  { table: 'person_surfaces', order: 30 }, // child of people
  { table: 'reminders', order: 40 },
  // staging_inbox: no FK relation; delete any leftover demo rows (e.g. a
  // pending_unlock / failed row that never drained inline) so the interval
  // drain can't resolve them into the user vault after the demo ends.
  { table: 'staging_inbox', order: 60 },
  { table: 'people', order: 80 }, // parent — after person_surfaces
];

/** Per-persona-DB scoped tables with cleanup order (child → parent). */
const PERSONA_SCOPED_TABLES: readonly { table: string; order: number }[] = [
  { table: 'vault_item_subjects', order: 10 }, // child link
  { table: 'vault_items', order: 50 }, // parent
];

/**
 * Register cleanups for the identity-DB scoped tables. `getDb` is a thunk so
 * the registration survives a DB re-open (it reads the live handle each run).
 */
export function wireIdentityScopeCleanups(getDb: () => DatabaseAdapter | null): void {
  for (const { table, order } of IDENTITY_SCOPED_TABLES) {
    registerScopedCleanup({ table, order, deleteScope: scopedTableDeleter(getDb, table) });
  }
}

/**
 * Result of resolving the persona DBs to clean: the adapters that opened, plus
 * the names of registered personas that FAILED to open. A bare array is also
 * accepted (treated as "all opened, none failed") for callers/tests that can't
 * fail to open.
 */
export interface PersonaCleanupDbs {
  adapters: DatabaseAdapter[];
  /** Registered personas whose vault couldn't be opened for cleanup. */
  failed: string[];
}

/**
 * Register cleanups for the per-persona vault tables. `getPersonaDbs` returns
 * the persona DBs to delete from; the deleter sums deletes across them (the
 * demo writes to whatever persona the memory routed to — general/health/…).
 *
 * It MUST return EVERY registered persona's DB, not just the currently-open
 * ones: a demo can route content into a sensitive/locked persona (health,
 * financial) that is closed at teardown — especially after a crash-recovery
 * boot, where only the default auto-open personas are open. If cleanup saw
 * only the open set, those rows would survive teardown. The provider is async
 * because opening a closed persona derives its DEK (mirrors the export path,
 * which also opens all personas on demand); `ScopedCleanup.deleteScope`
 * already permits a `Promise<number>` return.
 *
 * If the provider reports `failed` personas (a registered vault that couldn't be
 * opened — a real error, NOT a benign absent file, since op-sqlite creates the
 * DB on open), the deleter cleans the personas that DID open and THEN throws, so
 * the failure is recorded in `deleteDataScope`'s per-table errors → recovery is
 * preserved + retried on the next boot, instead of being silently lost.
 */
export function wirePersonaScopeCleanups(
  getPersonaDbs: () => DatabaseAdapter[] | PersonaCleanupDbs | Promise<DatabaseAdapter[] | PersonaCleanupDbs>,
): void {
  for (const { table, order } of PERSONA_SCOPED_TABLES) {
    registerScopedCleanup({
      table,
      order,
      deleteScope: async (scope: DataScope): Promise<number> => {
        const resolved = await getPersonaDbs();
        const adapters = Array.isArray(resolved) ? resolved : resolved.adapters;
        const failed = Array.isArray(resolved) ? [] : resolved.failed;
        let total = 0;
        for (const db of adapters) {
          total += scopedTableDeleter(() => db, table)(scope);
        }
        if (failed.length > 0) {
          // Clean what we could, then surface the failure so teardown keeps the
          // recovery record (rows in the unopened personas may still survive).
          throw new Error(`persona open failed during cleanup: ${failed.join(', ')}`);
        }
        return total;
      },
    });
  }
}

/**
 * Tear down a guided-demo scope end-to-end: delete its rows, clear the
 * active-demo record, and switch the runtime back to `user`. The order matters
 * — delete while the demo scope is still recorded, THEN clear state, THEN
 * switch scope, so a crash between steps still leaves a recoverable record.
 * In-memory cache rehydration (vault HNSW, reminders Map, …) is the caller's
 * job after this returns, since those caches live in the app layer.
 */
export async function tearDownDataScope(scope: DataScope): Promise<DeleteDataScopeResult> {
  const result = await deleteDataScope(scope); // throws on USER_SCOPE / invalid

  if (result.errors.length > 0) {
    // Partial cleanup failure (one or more table deleters threw, reported in
    // result.errors). Do NOT clear the active-demo recovery record — keeping it
    // lets the next boot (or a manual retry) re-run the delete instead of
    // silently abandoning demo rows that survived. We still return the runtime
    // to `user`: the un-deleted demo rows stay hidden (every repo filters by
    // scope), so the user isn't stranded in a half-torn-down demo. Recovery is
    // cleared ONLY on a fully clean delete.
     
    console.warn(
      `[scope/teardown] partial cleanup for "${scope}": ${result.errors.length} table(s) failed — ` +
        `keeping recovery record for retry (${result.errors.map((e) => e.table).join(', ')})`,
    );
    setCurrentDataScope(USER_SCOPE);
    return result;
  }

  await clearActiveDemo();
  setCurrentDataScope(USER_SCOPE);
  return result;
}
