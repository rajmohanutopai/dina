/**
 * Service-config SQLite repository — durable backing for
 * `service/service_config.ts`.
 *
 * Two-tier pattern (matches `reminders/repository.ts`):
 *   - In-memory state in `service_config.ts` is the source of truth within
 *     the process.
 *   - The repository mirrors writes to SQLite so config survives restart.
 *   - When no repository is wired (tests), the in-memory layer still works.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite
 * under go-sqlcipher is sync internally; each `async` method wraps
 * the sync result in a resolved Promise. `service_config.ts` keeps
 * its sync `getServiceConfig()` / `isCapabilityConfigured()` public
 * API — reads come from the in-memory `current` state, which is
 * populated via an explicit boot-time `hydrateServiceConfig()` call
 * (replaces the previous lazy-hydrate-in-getter) and updated on every
 * `setServiceConfig`. Writes fire-and-forget to the repo. This keeps
 * `isCapabilityConfigured` sync for the D2D ingress hot path.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

/** One persisted listing row. `rkey` is the join key to the published record. */
export interface ServiceConfigRow {
  rkey: string;
  /** The JSON-encoded `ServiceConfig` for this listing. */
  configJSON: string;
  updatedAtMs: number;
}

export interface ServiceConfigRepository {
  /** Read the JSON-encoded config blob by rkey, or `null` if absent. */
  get(rkey: string): Promise<string | null>;

  /**
   * List every persisted listing row (multi-listing: one row per rkey).
   * Used by boot-time hydrate-all and `GET /v1/service/configs`.
   */
  list(): Promise<ServiceConfigRow[]>;

  /** Upsert the JSON-encoded config blob under `rkey`. */
  put(rkey: string, valueJSON: string, updatedAtMs: number): Promise<void>;

  /** Delete the row for `rkey`. No-op if it does not exist. */
  remove(rkey: string): Promise<void>;
}

let repo: ServiceConfigRepository | null = null;

export function setServiceConfigRepository(r: ServiceConfigRepository | null): void {
  repo = r;
}

export function getServiceConfigRepository(): ServiceConfigRepository | null {
  return repo;
}

/** SQLite-backed implementation. Uses the identity DB. */
export class SQLiteServiceConfigRepository implements ServiceConfigRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async get(rkey: string): Promise<string | null> {
    const rows = this.db.query<{ config_json: string }>(
      'SELECT config_json FROM service_configs WHERE rkey = ?',
      [rkey],
    );
    return rows.length > 0 ? String(rows[0].config_json) : null;
  }

  async list(): Promise<ServiceConfigRow[]> {
    const rows = this.db.query<{ rkey: string; config_json: string; updated_at: number }>(
      'SELECT rkey, config_json, updated_at FROM service_configs ORDER BY rkey ASC',
    );
    return rows.map((r) => ({
      rkey: String(r.rkey),
      configJSON: String(r.config_json),
      updatedAtMs: Number(r.updated_at),
    }));
  }

  async put(rkey: string, valueJSON: string, updatedAtMs: number): Promise<void> {
    // `created_at` is preserved on conflict (only set on first insert);
    // `updated_at` always advances. Mirrors the AppView createdAt/updatedAt split.
    this.db.execute(
      `INSERT INTO service_configs (rkey, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(rkey) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
      [rkey, valueJSON, updatedAtMs, updatedAtMs],
    );
  }

  async remove(rkey: string): Promise<void> {
    this.db.execute('DELETE FROM service_configs WHERE rkey = ?', [rkey]);
  }
}

/**
 * Pure in-memory implementation for tests that want repository-style
 * persistence without a real SQLite connection.
 */
export class InMemoryServiceConfigRepository implements ServiceConfigRepository {
  private readonly rows = new Map<string, { configJSON: string; updatedAtMs: number }>();

  async get(rkey: string): Promise<string | null> {
    return this.rows.get(rkey)?.configJSON ?? null;
  }

  async list(): Promise<ServiceConfigRow[]> {
    return [...this.rows.entries()]
      .map(([rkey, v]) => ({ rkey, configJSON: v.configJSON, updatedAtMs: v.updatedAtMs }))
      .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
  }

  async put(rkey: string, valueJSON: string, updatedAtMs: number): Promise<void> {
    this.rows.set(rkey, { configJSON: valueJSON, updatedAtMs });
  }

  async remove(rkey: string): Promise<void> {
    this.rows.delete(rkey);
  }
}
