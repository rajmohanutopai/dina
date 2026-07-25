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
  publication: ServicePublicationStatus;
}

export type ServicePublicationState = 'pending' | 'published' | 'failed' | 'not_published';

export interface ServicePublicationStatus {
  state: ServicePublicationState;
  uri: string | null;
  cid: string | null;
  error: string | null;
  attemptedAtMs: number | null;
  nextRetryAtMs: number | null;
}

export interface SetServicePublicationStatusInput {
  state: ServicePublicationState;
  uri?: string | null;
  cid?: string | null;
  error?: string | null;
  attemptedAtMs?: number | null;
  nextRetryAtMs?: number | null;
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

  /** Read durable publication state for one listing. */
  getPublicationStatus(rkey: string): Promise<ServicePublicationStatus | null>;

  /** Update publication state without mutating the listing config. */
  setPublicationStatus(rkey: string, status: SetServicePublicationStatusInput): Promise<void>;
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
    const rows = this.db.query<{
      rkey: string;
      config_json: string;
      updated_at: number;
      publication_state: ServicePublicationState;
      last_published_uri: string | null;
      last_published_cid: string | null;
      last_publish_error: string | null;
      last_publish_attempt_at: number | null;
      next_publish_retry_at: number | null;
    }>(
      `SELECT rkey, config_json, updated_at, publication_state,
              last_published_uri, last_published_cid, last_publish_error,
              last_publish_attempt_at, next_publish_retry_at
         FROM service_configs
        ORDER BY rkey ASC`,
    );
    return rows.map((r) => ({
      rkey: String(r.rkey),
      configJSON: String(r.config_json),
      updatedAtMs: Number(r.updated_at),
      publication: {
        state: r.publication_state,
        uri: r.last_published_uri,
        cid: r.last_published_cid,
        error: r.last_publish_error,
        attemptedAtMs:
          r.last_publish_attempt_at === null ? null : Number(r.last_publish_attempt_at),
        nextRetryAtMs:
          r.next_publish_retry_at === null ? null : Number(r.next_publish_retry_at),
      },
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
         updated_at = excluded.updated_at,
         publication_state = 'pending',
         last_published_uri = NULL,
         last_published_cid = NULL,
         last_publish_error = NULL,
         last_publish_attempt_at = NULL,
         next_publish_retry_at = NULL`,
      [rkey, valueJSON, updatedAtMs, updatedAtMs],
    );
  }

  async remove(rkey: string): Promise<void> {
    this.db.execute('DELETE FROM service_configs WHERE rkey = ?', [rkey]);
  }

  async getPublicationStatus(rkey: string): Promise<ServicePublicationStatus | null> {
    const rows = this.db.query<{
      publication_state: ServicePublicationState;
      last_published_uri: string | null;
      last_published_cid: string | null;
      last_publish_error: string | null;
      last_publish_attempt_at: number | null;
      next_publish_retry_at: number | null;
    }>(
      `SELECT publication_state, last_published_uri, last_published_cid,
              last_publish_error, last_publish_attempt_at, next_publish_retry_at
         FROM service_configs
        WHERE rkey = ?`,
      [rkey],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      state: row.publication_state,
      uri: row.last_published_uri,
      cid: row.last_published_cid,
      error: row.last_publish_error,
      attemptedAtMs:
        row.last_publish_attempt_at === null ? null : Number(row.last_publish_attempt_at),
      nextRetryAtMs:
        row.next_publish_retry_at === null ? null : Number(row.next_publish_retry_at),
    };
  }

  async setPublicationStatus(
    rkey: string,
    status: SetServicePublicationStatusInput,
  ): Promise<void> {
    this.db.execute(
      `UPDATE service_configs
          SET publication_state = ?,
              last_published_uri = ?,
              last_published_cid = ?,
              last_publish_error = ?,
              last_publish_attempt_at = ?,
              next_publish_retry_at = ?
        WHERE rkey = ?`,
      [
        status.state,
        status.uri ?? null,
        status.cid ?? null,
        status.error ?? null,
        status.attemptedAtMs ?? null,
        status.nextRetryAtMs ?? null,
        rkey,
      ],
    );
  }
}

/**
 * Pure in-memory implementation for tests that want repository-style
 * persistence without a real SQLite connection.
 */
export class InMemoryServiceConfigRepository implements ServiceConfigRepository {
  private readonly rows = new Map<
    string,
    {
      configJSON: string;
      updatedAtMs: number;
      publication: ServicePublicationStatus;
    }
  >();

  async get(rkey: string): Promise<string | null> {
    return this.rows.get(rkey)?.configJSON ?? null;
  }

  async list(): Promise<ServiceConfigRow[]> {
    return [...this.rows.entries()]
      .map(([rkey, v]) => ({
        rkey,
        configJSON: v.configJSON,
        updatedAtMs: v.updatedAtMs,
        publication: { ...v.publication },
      }))
      .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
  }

  async put(rkey: string, valueJSON: string, updatedAtMs: number): Promise<void> {
    this.rows.set(rkey, {
      configJSON: valueJSON,
      updatedAtMs,
      publication: {
        state: 'pending',
        uri: null,
        cid: null,
        error: null,
        attemptedAtMs: null,
        nextRetryAtMs: null,
      },
    });
  }

  async remove(rkey: string): Promise<void> {
    this.rows.delete(rkey);
  }

  async getPublicationStatus(rkey: string): Promise<ServicePublicationStatus | null> {
    const status = this.rows.get(rkey)?.publication;
    return status === undefined ? null : { ...status };
  }

  async setPublicationStatus(
    rkey: string,
    status: SetServicePublicationStatusInput,
  ): Promise<void> {
    const row = this.rows.get(rkey);
    if (row === undefined) return;
    row.publication = {
      state: status.state,
      uri: status.uri ?? null,
      cid: status.cid ?? null,
      error: status.error ?? null,
      attemptedAtMs: status.attemptedAtMs ?? null,
      nextRetryAtMs: status.nextRetryAtMs ?? null,
    };
  }
}
