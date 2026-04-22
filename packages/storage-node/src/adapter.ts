/**
 * `NodeSQLiteAdapter` — `DatabaseAdapter` implementation backed by
 * `better-sqlite3-multiple-ciphers`.
 *
 * Opens an encrypted SQLite file with SQLCipher-compat ciphering so
 * databases written here round-trip with the mobile `go-sqlcipher`
 * stack (task 3.7 scope; full cross-runtime byte-compat verification
 * lives in task 3.18).
 *
 * **Pragma sequence** — order matters; wxSQLite3 cipher settings must
 * land before the key so the first page decrypts correctly:
 *
 *   1. `PRAGMA cipher = 'sqlcipher'`
 *   2. `PRAGMA cipher_compatibility = 4`      — SQLCipher v4 format
 *   3. `PRAGMA cipher_page_size = <n>`        — default 4096
 *   4. `PRAGMA key = "x'<64 hex chars>'"`      — raw 32-byte key, no KDF
 *   5. `PRAGMA journal_mode = <WAL|FULL>`     — default WAL
 *   6. A probe `SELECT count(*) FROM sqlite_master` — surfaces a
 *      wrong-key as a `SqliteError` at open-time, not on first real
 *      query.
 *
 * Key derivation lives upstream in `@dina/core/crypto`; this adapter
 * is key-material-agnostic — it accepts a hex-encoded DEK and passes
 * it as a raw key via the `x'...'` literal.
 *
 * Task roadmap (docs/HOME_NODE_LITE_TASKS.md Phase 3a):
 *   - 3.7 ✅ open(path, passphrase) — PRAGMA key, cipher_page_size,
 *          journal_mode=WAL
 *   - 3.8 ✅ close(), execute(), query(), run(), transaction(), isOpen
 *   - 3.9  Transactions — callback + explicit forms (this impl covers
 *          the callback form; explicit BEGIN/COMMIT forms come next)
 *   - 3.10 FTS5 virtual table + tokenizer `unicode61 remove_diacritics 1`
 *   - 3.11 Blob handling — Uint8Array ↔ Buffer
 *   - 3.14 Crash-safety config — `synchronous=NORMAL` tuning
 */

import type { DBRow, DatabaseAdapter } from '@dina/core';
import Database, { type Database as BSMCDatabase } from 'better-sqlite3-multiple-ciphers';

const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

export class NodeSQLiteAdapterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_path'
      | 'invalid_key'
      | 'invalid_page_size'
      | 'invalid_journal_mode'
      | 'invalid_synchronous'
      | 'cipher_setup_failed'
      | 'wrong_key'
      | 'closed'
      | 'nested_transaction'
      | 'no_active_transaction',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'NodeSQLiteAdapterError';
  }
}

export type JournalMode = 'WAL' | 'DELETE';
export type Synchronous = 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';

export interface NodeSQLiteAdapterOptions {
  /**
   * Absolute path to the SQLite file. Use `:memory:` for an ephemeral
   * DB — but note WAL silently falls back to `memory` journal on
   * :memory: DBs, and the file-round-trip compat the SQLCipher mode
   * guarantees only applies to file-backed paths.
   */
  path: string;
  /**
   * Hex-encoded 32-byte DEK (64 hex chars). Derivation happens
   * upstream in `@dina/core/crypto`; this adapter is key-material-
   * agnostic and only passes the bytes as a raw SQLCipher key.
   */
  passphraseHex: string;
  /** cipher_page_size for SQLCipher v4 compat. Default 4096. */
  cipherPageSize?: number;
  /**
   * SQLite `PRAGMA journal_mode` setting. Default `'WAL'` for the
   * vault/persona use case; identity DBs should use `'DELETE'` so
   * every commit is durably fsync'd before the return from write.
   */
  journalMode?: JournalMode;
  /**
   * SQLite `PRAGMA synchronous` setting. Unset = use SQLite default
   * (normally `FULL` under DELETE journal, `NORMAL` under WAL). The
   * provider explicitly pins these per-DB type:
   *   - vault personas: `'NORMAL'` (WAL-appropriate, task 3.14)
   *   - identity DB:    `'FULL'`   (durable every commit, task 3.14)
   */
  synchronous?: Synchronous;
}

export class NodeSQLiteAdapter implements DatabaseAdapter {
  private readonly db: BSMCDatabase;
  private _isOpen = false;
  /**
   * Tracks explicit BEGIN/COMMIT state so nested BEGIN and orphan
   * COMMIT/ROLLBACK are caught with typed errors rather than SQLite's
   * "cannot start a transaction within a transaction" / "no transaction
   * is active". Callback-form `transaction(fn)` uses SQLite savepoints
   * via BSMC's wrapper and is independent of this flag.
   */
  private _inExplicitTransaction = false;

  constructor(opts: NodeSQLiteAdapterOptions) {
    if (typeof opts.path !== 'string' || opts.path.length === 0) {
      throw new NodeSQLiteAdapterError('invalid_path', 'path must be a non-empty string');
    }
    if (!HEX_KEY_REGEX.test(opts.passphraseHex)) {
      throw new NodeSQLiteAdapterError('invalid_key', 'passphraseHex must be 64 hex chars (32 bytes)');
    }
    const pageSize = opts.cipherPageSize ?? 4096;
    if (!Number.isInteger(pageSize) || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new NodeSQLiteAdapterError('invalid_page_size', 'cipherPageSize must be a power-of-two between 512 and 65536');
    }
    const journalMode = opts.journalMode ?? 'WAL';
    if (journalMode !== 'WAL' && journalMode !== 'DELETE') {
      throw new NodeSQLiteAdapterError('invalid_journal_mode', 'journalMode must be WAL or DELETE');
    }
    const synchronous = opts.synchronous;
    if (
      synchronous !== undefined &&
      synchronous !== 'OFF' &&
      synchronous !== 'NORMAL' &&
      synchronous !== 'FULL' &&
      synchronous !== 'EXTRA'
    ) {
      throw new NodeSQLiteAdapterError(
        'invalid_synchronous',
        'synchronous must be OFF, NORMAL, FULL, or EXTRA',
      );
    }

    this.db = new Database(opts.path);
    try {
      // Order matters — see file header.
      this.db.pragma("cipher = 'sqlcipher'");
      this.db.pragma('cipher_compatibility = 4');
      this.db.pragma(`cipher_page_size = ${pageSize}`);
      this.db.pragma(`key = "x'${opts.passphraseHex.toLowerCase()}'"`);
      // On :memory: WAL silently becomes memory; that's SQLite behaviour,
      // not an error. For file-backed DBs WAL is the configured mode.
      this.db.pragma(`journal_mode = ${journalMode}`);
      if (synchronous !== undefined) {
        this.db.pragma(`synchronous = ${synchronous}`);
      }
      // Probe — surfaces a wrong-key immediately instead of on first query.
      this.db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      this._isOpen = true;
    } catch (err) {
      // Clean up the handle so we don't leak the fd on a failed open.
      try { this.db.close(); } catch { /* swallow — primary error below */ }
      const message = err instanceof Error ? err.message : String(err);
      // SQLCipher/wxSQLite3 surface a wrong key as SqliteError with
      // `code === 'SQLITE_NOTADB'`. Prefer the typed code (stable
      // contract) over the message string (prose, may drift with
      // library updates) but keep a regex fallback for defensive depth.
      const code = (err as { code?: unknown })?.code;
      const isWrongKey =
        code === 'SQLITE_NOTADB' ||
        /not a database|unsupported file format/i.test(message);
      if (isWrongKey) {
        throw new NodeSQLiteAdapterError('wrong_key', `SQLCipher decryption failed: ${message}`);
      }
      throw new NodeSQLiteAdapterError('cipher_setup_failed', `pragma setup failed: ${message}`);
    }
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  execute(sql: string, params?: unknown[]): void {
    this.assertOpen();
    if (params && params.length > 0) {
      this.db.prepare(sql).run(...(params as unknown[]));
    } else {
      this.db.exec(sql);
    }
  }

  query<T extends DBRow = DBRow>(sql: string, params?: unknown[]): T[] {
    this.assertOpen();
    const stmt = this.db.prepare(sql);
    const rows = params && params.length > 0
      ? stmt.all(...(params as unknown[]))
      : stmt.all();
    return rows as T[];
  }

  run(sql: string, params?: unknown[]): number {
    this.assertOpen();
    const info = params && params.length > 0
      ? this.db.prepare(sql).run(...(params as unknown[]))
      : this.db.prepare(sql).run();
    return info.changes;
  }

  transaction(fn: () => void): void {
    this.assertOpen();
    // BSMC's `db.transaction` returns a wrapper function; calling it
    // runs `fn` inside `BEGIN…COMMIT`, rolling back on throw.
    const tx = this.db.transaction(fn);
    tx();
  }

  /**
   * Explicit transaction form (task 3.9). Use when a transaction must
   * span multiple unrelated code paths — e.g. a streaming import that
   * consumes N batches and can't be wrapped in a single callback. The
   * callback form (`transaction(fn)`) remains preferred for self-
   * contained units of work because it's exception-safe by construction.
   *
   * Constraints:
   *   - `beginTransaction` errors if one is already active.
   *   - `commitTransaction` / `rollbackTransaction` error when no
   *     transaction is active.
   *   - The callback form and the explicit form do NOT nest — starting
   *     a callback transaction while an explicit one is open is
   *     rejected by SQLite with a clear error; we don't paper over it.
   */
  beginTransaction(): void {
    this.assertOpen();
    if (this._inExplicitTransaction) {
      throw new NodeSQLiteAdapterError(
        'nested_transaction',
        'a transaction is already active — commit or rollback first',
      );
    }
    this.db.exec('BEGIN');
    this._inExplicitTransaction = true;
  }

  commitTransaction(): void {
    this.assertOpen();
    if (!this._inExplicitTransaction) {
      throw new NodeSQLiteAdapterError(
        'no_active_transaction',
        'commitTransaction called without an active BEGIN',
      );
    }
    this.db.exec('COMMIT');
    this._inExplicitTransaction = false;
  }

  rollbackTransaction(): void {
    this.assertOpen();
    if (!this._inExplicitTransaction) {
      throw new NodeSQLiteAdapterError(
        'no_active_transaction',
        'rollbackTransaction called without an active BEGIN',
      );
    }
    this.db.exec('ROLLBACK');
    this._inExplicitTransaction = false;
  }

  /** True iff an explicit BEGIN is outstanding. */
  get inExplicitTransaction(): boolean {
    return this._inExplicitTransaction;
  }

  close(): void {
    if (!this._isOpen) return; // Idempotent — `close()` after `close()` is a no-op.
    // If an explicit transaction is outstanding, roll it back so the
    // on-disk file isn't left in a partial state. BSMC's close would
    // otherwise let SQLite auto-rollback but the in-memory flag would
    // stay stale.
    if (this._inExplicitTransaction) {
      try { this.db.exec('ROLLBACK'); } catch { /* swallow — closing regardless */ }
      this._inExplicitTransaction = false;
    }
    this.db.close();
    this._isOpen = false;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (!this._isOpen) {
      throw new NodeSQLiteAdapterError('closed', 'database is closed');
    }
  }
}
