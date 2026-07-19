/**
 * Scoped-repository helpers — the ONE sanctioned way repositories apply
 * data-scope filtering, so scope handling isn't re-derived (and mis-derived)
 * per repo. Every scoped repository builds its scope predicate, params, and
 * insert field from these.
 *
 * Usage (read):
 *   db.query(`SELECT … FROM reminders WHERE completed = 0 AND ${scopedWhere()}`,
 *            [...other, ...scopedParams()]);
 * Usage (insert):
 *   const { data_scope } = scopedInsertFields();
 *   db.execute('INSERT INTO reminders (…, data_scope) VALUES (…, ?)', [..., data_scope]);
 * Usage (exact-id delete — still scope-bound, see design doc "Exact-ID Safety"):
 *   db.execute(`DELETE FROM reminders WHERE id = ? AND ${scopedWhere()}`,
 *              [id, ...scopedParams()]);
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Repository Enforcement"
 */

import { currentDataScope, type DataScope } from './data_scope';

import type { DatabaseAdapter } from '../storage/db_adapter';


/** Column name carrying the scope. Single source of truth for the SQL string. */
export const DATA_SCOPE_COLUMN = 'data_scope';

/** Insert field: `{ data_scope: <scope> }`, defaulting to the current scope. */
export function scopedInsertFields(scope: DataScope = currentDataScope()): { data_scope: DataScope } {
  return { data_scope: scope };
}

/**
 * Scope predicate for a WHERE clause: `data_scope = ?` (optionally aliased,
 * e.g. `r.data_scope = ?` for a join). Pair with `scopedParams()`.
 */
export function scopedWhere(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}${DATA_SCOPE_COLUMN} = ?`;
}

/** Bind params for `scopedWhere()`, defaulting to the current scope. */
export function scopedParams(scope: DataScope = currentDataScope()): [DataScope] {
  return [scope];
}

/**
 * Build a registry-ready deleter for a single scoped table. Repositories use
 * this to register their cleanup without re-writing the same DELETE.
 */
export function scopedTableDeleter(
  getDb: () => DatabaseAdapter | null,
  table: string,
): (scope: DataScope) => number {
  return (scope: DataScope): number => {
    const db = getDb();
    if (db === null) return 0;
    // Count first so the result reports an accurate deleted-count regardless of
    // whether the adapter's execute() surfaces a changes count.
    const before = db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE ${DATA_SCOPE_COLUMN} = ?`,
      [scope],
    );
    const count = Number(before[0]?.c ?? 0);
    if (count > 0) {
      db.execute(`DELETE FROM ${table} WHERE ${DATA_SCOPE_COLUMN} = ?`, [scope]);
    }
    return count;
  };
}
