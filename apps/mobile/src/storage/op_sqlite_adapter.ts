/**
 * OpSQLite database adapter — production SQLCipher-encrypted SQLite.
 *
 * Wraps @op-engineering/op-sqlite with:
 *   - PRAGMA key for SQLCipher encryption
 *   - WAL journal mode for concurrent reads
 *   - busy_timeout for lock contention
 *   - foreign_keys enabled
 *
 * Used in production only — tests use InMemoryDatabaseAdapter.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '@dina/core/storage';

// op-sqlite types — production DB object. **Uses `executeSync`**, not
// `execute`: in op-sqlite ≥ 15 the async `execute(...)` returns a
// `Promise<QueryResult>`, so reading `result.rows` on the un-awaited
// return gives `undefined` — silently collapsing every SELECT to `[]`.
// That made `getCurrentVersion()` always return 0, so the migration
// runner re-applied v1 on every boot and hit
// `UNIQUE constraint failed: schema_version.version`. The `Sync`
// variant returns a plain `QueryResult` synchronously, which is what
// our sync `DatabaseAdapter` contract expects.
//
// `rows` shape: flat `Array<Record<…>>` in op-sqlite ≥ 15. Older
// versions exposed `{_array}`; we support both for forward/backward
// compat in case `executeSync` ever normalises to a different shape.
interface OpSQLiteDB {
  executeSync: (
    sql: string,
    params?: unknown[],
  ) => {
    rows?: Record<string, unknown>[] | { _array: Record<string, unknown>[] };
    /** `sqlite3_changes()` for the statement — the rows an UPDATE/DELETE/INSERT
     *  actually touched. Load-bearing: every durable-job CAS (claim/complete/…)
     *  guards on `WHERE … status=?` and trusts this count to know the transition
     *  applied. op-sqlite ≥ 15 always populates it. */
    rowsAffected?: number;
  };
  close: () => void;
}

type OpenFn = (options: { name: string; location?: string }) => OpSQLiteDB;

/**
 * Production database adapter backed by op-sqlite + SQLCipher.
 */
export class OpSQLiteAdapter implements DatabaseAdapter {
  private db: OpSQLiteDB | null = null;
  private _isOpen = false;

  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Open a SQLCipher-encrypted database.
   *
   * @param name — database filename (e.g., 'identity.sqlite')
   * @param location — directory path
   * @param dekHex — hex-encoded 32-byte DEK for SQLCipher PRAGMA key
   * @param openFn — the op-sqlite open function (injected for testability)
   */
  open(name: string, location: string, dekHex: string, openFn: OpenFn): void {
    if (this._isOpen) throw new Error('op-sqlite: already open');

    this.db = openFn({ name, location }) as unknown as OpSQLiteDB;

    // SQLCipher encryption
    if (dekHex) {
      this.db.executeSync(`PRAGMA key = "x'${dekHex}'"`);
    }

    // Performance pragmas
    this.db.executeSync('PRAGMA journal_mode = WAL');
    this.db.executeSync('PRAGMA synchronous = NORMAL');
    this.db.executeSync('PRAGMA foreign_keys = ON');
    this.db.executeSync('PRAGMA busy_timeout = 5000');

    this._isOpen = true;
  }

  execute(sql: string, params?: unknown[]): void {
    this.assertOpen();
    this.db!.executeSync(sql, params);
  }

  query<T extends DBRow = DBRow>(sql: string, params?: unknown[]): T[] {
    this.assertOpen();
    const result = this.db!.executeSync(sql, params);
    // Unwrap both `rows` shapes. In op-sqlite ≥ 15 the sync result's
    // `rows` is a flat `Array<Record<…>>`; older versions exposed
    // `{_array}`. Defence-in-depth in case a future release normalises
    // to something new — never silently collapse to `[]`.
    const rows = result.rows as unknown;
    if (Array.isArray(rows)) return rows as T[];
    if (rows && typeof rows === 'object' && '_array' in rows) {
      return ((rows as { _array?: T[] })._array ?? []) as T[];
    }
    return [] as T[];
  }

  run(sql: string, params?: unknown[]): number {
    this.assertOpen();
    // Return the REAL changed-row count (`sqlite3_changes()`), not a constant.
    // The durable-job state machine's CAS transitions (`UPDATE … WHERE …
    // status=?`) read this to know whether the guarded row actually matched;
    // a hardcoded `1` made every CAS report success, so two overlapping drains
    // could both "claim"/"complete" the same job and lost leases counted as
    // publishes. `?? 0` fails CLOSED (treat as "did not apply") if a future
    // op-sqlite ever omits the field — safer than a false success.
    const result = this.db!.executeSync(sql, params) as { rowsAffected?: number };
    return result.rowsAffected ?? 0;
  }

  transaction(fn: () => void): void {
    this.assertOpen();
    this.db!.executeSync('BEGIN');
    try {
      fn();
      this.db!.executeSync('COMMIT');
    } catch (err) {
      this.db!.executeSync('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (!this._isOpen || !this.db) return;
    // WAL checkpoint before close
    try {
      this.db.executeSync('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ok */
    }
    this.db.close();
    this.db = null;
    this._isOpen = false;
  }

  private assertOpen(): void {
    if (!this._isOpen || !this.db) throw new Error('op-sqlite: database not open');
  }
}
