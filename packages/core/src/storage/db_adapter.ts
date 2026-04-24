/**
 * Database adapter — unified interface over op-sqlite (production)
 * and better-sqlite3 (tests).
 *
 * Used by all repository classes for SQL execution. The adapter
 * abstracts away the differences between native op-sqlite (JSI)
 * and Node.js better-sqlite3.
 *
 * **Sync on purpose** (task 3.4 decision). SQLite is CPU-bound and
 * every backend we target (better-sqlite3-multiple-ciphers on Node,
 * op-sqlite via JSI on RN) exposes a synchronous native call. Returning
 * `Promise<T>` would just push the same work into a microtask, break
 * error-throw semantics, and force every repository call site to
 * `await` for no concurrency gain. This port is the pinned counter-
 * example to the `dina/port-async-only` rule (Phase 2) — async-only
 * applies to genuine I/O-boundary ports (HTTP, WS, non-mmap files),
 * not CPU-bound native bindings.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer;
 * `packages/storage-node/README.md` — library-choice rationale.
 */

/** A single row returned from a query. */
export type DBRow = Record<string, string | number | null | Uint8Array>;

/**
 * Database adapter interface.
 *
 * Both production (op-sqlite) and test (better-sqlite3 / in-memory)
 * implementations must satisfy this contract.
 */
export interface DatabaseAdapter {
  /** Execute a DDL or DML statement without returning rows. */
  execute(sql: string, params?: unknown[]): void;

  /** Execute a query and return result rows. */
  query<T extends DBRow = DBRow>(sql: string, params?: unknown[]): T[];

  /** Execute a statement and return the number of affected rows. */
  run(sql: string, params?: unknown[]): number;

  /**
   * Execute multiple statements in a transaction.
   * Rolls back on any error thrown inside `fn`.
   */
  transaction(fn: () => void): void;

  /** Close the database connection. */
  close(): void;

  /** Whether the database is currently open. */
  readonly isOpen: boolean;
}

/**
 * In-memory database adapter for testing.
 *
 * Wraps a simple Map-based store that satisfies the interface
 * without requiring any native module. Individual repositories
 * can test SQL logic via better-sqlite3 integration tests.
 *
 * For unit tests, the repositories are not wired — services
 * use their in-memory Maps directly.
 */
export class InMemoryDatabaseAdapter implements DatabaseAdapter {
  private _isOpen = true;
  private _tables = new Map<string, DBRow[]>();

  get isOpen(): boolean {
    return this._isOpen;
  }

  execute(sql: string, params?: unknown[]): void {
    if (!this._isOpen) throw new Error('db: not open');

    // Track table creation
    const createMatch = sql.match(
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
    );
    if (createMatch && !this._tables.has(createMatch[1])) {
      this._tables.set(createMatch[1], []);
    }

    // Track INSERT with params (needed for migration runner's schema_version)
    const insertMatch = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (insertMatch && params && params.length > 0) {
      const tableName = insertMatch[1];
      let table = this._tables.get(tableName);
      if (!table) {
        table = [];
        this._tables.set(tableName, table);
      }
      const cols = insertMatch[2].split(',').map((c) => c.trim());
      const row: DBRow = {};
      cols.forEach((col, i) => {
        row[col] = (params[i] as string | number | null) ?? null;
      });
      table.push(row);
    }
  }

  query<T extends DBRow = DBRow>(sql: string, _params?: unknown[]): T[] {
    if (!this._isOpen) throw new Error('db: not open');

    // MAX(col) aggregate
    const maxMatch = sql.match(/SELECT\s+MAX\((\w+)\)\s+as\s+(\w+)\s+FROM\s+(\w+)/i);
    if (maxMatch) {
      const [, col, alias, tableName] = maxMatch;
      const table = this._tables.get(tableName);
      if (!table || table.length === 0) return [{ [alias]: null } as unknown as T];
      let max: number | null = null;
      for (const row of table) {
        const val = row[col] as number | null;
        if (val !== null && (max === null || val > max)) max = val;
      }
      return [{ [alias]: max } as unknown as T];
    }

    // SELECT ... FROM <table> ORDER BY <col> (ASC|DESC) LIMIT <n>
    // — used by the migration runner to read the highest schema version
    // in an op-sqlite-compatible way (aggregates return un-aliased
    // column names on op-sqlite). Keep the in-memory adapter's parsing
    // in sync so tests + runtime see the same behaviour.
    const orderLimitMatch = sql.match(
      /SELECT\s+.+\s+FROM\s+(\w+)\s+ORDER\s+BY\s+(\w+)\s+(ASC|DESC)\s+LIMIT\s+(\d+)/i,
    );
    if (orderLimitMatch) {
      const [, tableName, col, direction, limitStr] = orderLimitMatch;
      const limit = parseInt(limitStr, 10);
      const rows = this._tables.get(tableName) ?? [];
      const sorted = [...rows].sort((a, b) => {
        const aVal = a[col] as number | string | null;
        const bVal = b[col] as number | string | null;
        if (aVal === bVal) return 0;
        if (aVal === null) return 1;
        if (bVal === null) return -1;
        const cmp = aVal < bVal ? -1 : 1;
        return direction.toUpperCase() === 'DESC' ? -cmp : cmp;
      });
      return sorted.slice(0, limit) as T[];
    }

    // SELECT from table
    const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+(\w+)/i);
    if (selectMatch) {
      return (this._tables.get(selectMatch[1]) ?? []) as T[];
    }

    return [];
  }

  run(sql: string, params?: unknown[]): number {
    if (!this._isOpen) throw new Error('db: not open');
    this.execute(sql, params);
    return 1;
  }

  transaction(fn: () => void): void {
    if (!this._isOpen) throw new Error('db: not open');
    fn();
  }

  close(): void {
    this._isOpen = false;
    this._tables.clear();
  }

  /** Check if a table was created (for testing). */
  hasTable(name: string): boolean {
    return this._tables.has(name);
  }
}
