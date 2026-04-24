/**
 * OpSQLite database adapter — production SQLCipher-encrypted SQLite for
 * React Native / Expo targets.
 *
 * Wraps @op-engineering/op-sqlite with:
 *   - PRAGMA key for SQLCipher encryption
 *   - WAL journal mode for concurrent reads
 *   - busy_timeout for lock contention
 *   - foreign_keys enabled
 *
 * Implements the `DatabaseAdapter` port from `@dina/core`. Used by the
 * mobile build target; tests use `InMemoryDatabaseAdapter` (also from
 * `@dina/core`). Node build target uses `@dina/storage-node` instead.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 1.14.3a (extracted from
 * apps/mobile/src/storage/op_sqlite_adapter.ts).
 */

import type { DatabaseAdapter, DBRow } from '@dina/core';

// op-sqlite types — imported dynamically in production. Typed as a
// union because op-sqlite ≥ 15 returns `rows` as a flat array while
// older versions used `{ _array: […] }`. The adapter's `query` method
// handles both shapes at runtime.
interface OpSQLiteDB {
  execute: (
    sql: string,
    params?: unknown[],
  ) => {
    rows?: Record<string, unknown>[] | { _array: Record<string, unknown>[] };
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

    this.db = openFn({ name, location });

    // SQLCipher encryption
    if (dekHex) {
      this.db.execute(`PRAGMA key = "x'${dekHex}'"`);
    }

    // Performance pragmas
    this.db.execute('PRAGMA journal_mode = WAL');
    this.db.execute('PRAGMA synchronous = NORMAL');
    this.db.execute('PRAGMA foreign_keys = ON');
    this.db.execute('PRAGMA busy_timeout = 5000');

    this._isOpen = true;
  }

  execute(sql: string, params?: unknown[]): void {
    this.assertOpen();
    this.db!.execute(sql, params);
  }

  query<T extends DBRow = DBRow>(sql: string, params?: unknown[]): T[] {
    this.assertOpen();
    const result = this.db!.execute(sql, params);
    // op-sqlite 15+ returns `rows` as a flat `Array<Record<…>>`.
    // Older versions exposed `{ _array: […] }`. Reading the old shape
    // against the new return silently yielded `[]` for every SELECT,
    // corrupting the migration runner's version check (see the same
    // note in apps/mobile/src/storage/op_sqlite_adapter.ts).
    const rows = result.rows as unknown;
    if (Array.isArray(rows)) return rows as T[];
    if (rows && typeof rows === 'object' && '_array' in rows) {
      return ((rows as { _array?: T[] })._array ?? []) as T[];
    }
    return [] as T[];
  }

  run(sql: string, params?: unknown[]): number {
    this.assertOpen();
    this.db!.execute(sql, params);
    return 1; // op-sqlite doesn't return affected rows easily
  }

  transaction(fn: () => void): void {
    this.assertOpen();
    this.db!.execute('BEGIN');
    try {
      fn();
      this.db!.execute('COMMIT');
    } catch (err) {
      this.db!.execute('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (!this._isOpen || !this.db) return;
    // WAL checkpoint before close
    try {
      this.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
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
