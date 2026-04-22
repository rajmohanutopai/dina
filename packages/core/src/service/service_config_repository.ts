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

export interface ServiceConfigRepository {
  /** Read the JSON-encoded config blob by key, or `null` if absent. */
  get(key: string): Promise<string | null>;

  /** Upsert the JSON-encoded config blob. */
  put(key: string, valueJSON: string, updatedAtMs: number): Promise<void>;

  /** Delete the blob. No-op if the key does not exist. */
  remove(key: string): Promise<void>;
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

  async get(key: string): Promise<string | null> {
    const rows = this.db.query<{ value: string }>(
      'SELECT value FROM service_config WHERE key = ?',
      [key],
    );
    return rows.length > 0 ? String(rows[0].value) : null;
  }

  async put(key: string, valueJSON: string, updatedAtMs: number): Promise<void> {
    this.db.execute(
      `INSERT INTO service_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, valueJSON, updatedAtMs],
    );
  }

  async remove(key: string): Promise<void> {
    this.db.execute('DELETE FROM service_config WHERE key = ?', [key]);
  }
}

/**
 * Pure in-memory implementation for tests that want repository-style
 * persistence without a real SQLite connection.
 */
export class InMemoryServiceConfigRepository implements ServiceConfigRepository {
  private readonly rows = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async put(key: string, valueJSON: string, _updatedAtMs: number): Promise<void> {
    this.rows.set(key, valueJSON);
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
