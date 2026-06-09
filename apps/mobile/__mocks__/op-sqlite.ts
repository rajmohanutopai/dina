/**
 * Jest mock for `@op-engineering/op-sqlite`.
 *
 * op-sqlite is a native module that can't load under Jest — so without this
 * mock, `initializePersistence()` throws, `useUnlock` swallows it with a
 * warning, and the app silently runs on the in-memory fallback. Tests then
 * "pass" while never actually exercising persistence (a real on-device
 * persistence bug would hide behind green tests).
 *
 * This mock backs op-sqlite with `better-sqlite3-multiple-ciphers` — a real,
 * in-process SQLite that works in Node — so the SAME `OpSQLiteAdapter` runs
 * actual SQL (open, CRUD, transactions) in tests.
 *
 * Surface mirrors only what `OpSQLiteAdapter` uses:
 *   open({ name, location }) -> {
 *     executeSync(sql, params?) -> { rows, rowsAffected }, close()
 *   }
 *
 * `rowsAffected` mirrors op-sqlite's real result (mapped from better-sqlite3's
 * `RunResult.changes`). The adapter's `run()` returns it so the durable-job CAS
 * (`UPDATE … WHERE … status=?`) can tell a matched transition from a no-op —
 * if this mock dropped it, the test SQLite would hide the exact production bug.
 *
 * Scope notes:
 *   - The SQLCipher `PRAGMA key` is a no-op here — these tests cover
 *     persistence LOGIC, not the cipher; the DB is plain SQLite.
 *   - Booleans -> 0/1 and undefined -> null (better-sqlite3 rejects those
 *     bind types) so adapter queries bind cleanly.
 */

import { join } from 'node:path';

interface BetterSqliteStatement {
  reader: boolean;
  all: (...params: unknown[]) => Record<string, unknown>[];
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}
interface BetterSqliteDb {
  prepare: (sql: string) => BetterSqliteStatement;
  exec: (sql: string) => void;
  close: () => void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3-multiple-ciphers') as new (path: string) => BetterSqliteDb;

interface OpenOptions {
  name: string;
  location?: string;
}

function dbPath(opts: OpenOptions): string {
  if (opts.location === undefined || opts.location === '') return ':memory:';
  return join(opts.location.replace(/^file:\/\//, ''), opts.name);
}

function coerce(params: unknown[]): unknown[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
}

interface ExecResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}

export function open(opts: OpenOptions): {
  executeSync: (sql: string, params?: unknown[]) => ExecResult;
  close: () => void;
} {
  const db = new Database(dbPath(opts));
  return {
    executeSync(sql: string, params: unknown[] = []): ExecResult {
      const trimmed = sql.trim();
      // Encryption is out of scope for persistence-logic tests.
      if (/^pragma\s+key\b/i.test(trimmed)) return { rows: [], rowsAffected: 0 };
      const bound = coerce(params);
      if (bound.length === 0) {
        // No params: PRAGMA / DDL (possibly multi-statement) / SELECT.
        try {
          const stmt = db.prepare(trimmed);
          if (stmt.reader) return { rows: stmt.all(), rowsAffected: 0 };
          const info = stmt.run();
          return { rows: [], rowsAffected: Number(info.changes) };
        } catch {
          // Multi-statement DDL etc. — better-sqlite3 prepare() rejects it.
          db.exec(trimmed);
          return { rows: [], rowsAffected: 0 };
        }
      }
      const stmt = db.prepare(trimmed);
      if (stmt.reader) return { rows: stmt.all(...bound), rowsAffected: 0 };
      const info = stmt.run(...bound);
      return { rows: [], rowsAffected: Number(info.changes) };
    },
    close(): void {
      db.close();
    },
  };
}

export default { open };
