/**
 * KV store SQL repository — backs kvGet/kvSet/kvDelete with SQLite.
 *
 * Uses the identity DB's `kv_store` table.
 * When the repository is wired, all KV operations go through SQL.
 * When null, the in-memory Map is used (backward compatible for tests).
 *
 * **Phase 2.3 pilot (task 2.3 — async port rule).** Methods return
 * `Promise<T>` even though SQLite-backed reads are synchronous under
 * go-sqlcipher — the port signature is the async contract that
 * alternate storage backends (SQLite WASM on web, IndexedDB, remote
 * stores) can satisfy without the interface needing a parallel
 * async variant. The current SQLite implementation resolves
 * immediately; no perf regression, just future-compat.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { KVEntry } from './store';

export interface KVRepository {
  get(key: string): Promise<KVEntry | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  list(prefix?: string): Promise<KVEntry[]>;
  count(prefix?: string): Promise<number>;
}

/**
 * SQLite-backed KV repository. SQLite is synchronous under
 * go-sqlcipher; the `async` keyword wraps each result in
 * `Promise.resolve(…)` without introducing microtask overhead beyond
 * one promise creation per call.
 */
export class SQLiteKVRepository implements KVRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async get(key: string): Promise<KVEntry | null> {
    const rows = this.db.query<{ key: string; value: string; updated_at: number }>(
      'SELECT key, value, updated_at FROM kv_store WHERE key = ?',
      [key],
    );
    if (rows.length === 0) return null;
    return { key: rows[0].key, value: rows[0].value, updatedAt: Number(rows[0].updated_at) };
  }

  async set(key: string, value: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.db.execute('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', [
      key,
      value,
      now,
    ]);
  }

  async delete(key: string): Promise<boolean> {
    const existing = await this.get(key);
    if (!existing) return false;
    this.db.execute('DELETE FROM kv_store WHERE key = ?', [key]);
    return true;
  }

  async has(key: string): Promise<boolean> {
    const rows = this.db.query('SELECT 1 FROM kv_store WHERE key = ?', [key]);
    return rows.length > 0;
  }

  async list(prefix?: string): Promise<KVEntry[]> {
    const rows = prefix
      ? this.db.query<{ key: string; value: string; updated_at: number }>(
          'SELECT key, value, updated_at FROM kv_store WHERE key LIKE ? ORDER BY key',
          [`${prefix}%`],
        )
      : this.db.query<{ key: string; value: string; updated_at: number }>(
          'SELECT key, value, updated_at FROM kv_store ORDER BY key',
        );

    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: Number(r.updated_at) }));
  }

  async count(prefix?: string): Promise<number> {
    const rows = prefix
      ? this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM kv_store WHERE key LIKE ?', [
          `${prefix}%`,
        ])
      : this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM kv_store');
    return Number(rows[0]?.c ?? 0);
  }
}
