/**
 * Migration runner — applies ordered schema scripts against a
 * `DatabaseAdapter`, tracking the applied version in `schema_version`.
 *
 * **Semantics**:
 *
 *   - `schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER
 *     NOT NULL)` is created on first run.
 *   - Current version = `MAX(version)` from that table (null → 0).
 *   - Migrations are sorted by `id`; those with `id > current` are
 *     applied in order.
 *   - Each migration runs inside its own transaction — all `up`
 *     statements commit together or the migration rolls back and
 *     propagates the error (aborts the run).
 *   - After applying, `(id, now_ms)` is inserted into `schema_version`.
 *
 * **Idempotent**: calling `runMigrations` twice with the same list
 * leaves the DB unchanged on the second call — versions already
 * recorded in `schema_version` are skipped.
 *
 * **Input validation**:
 *
 *   - `migrations` must be a non-null array
 *   - every `id` must be a positive integer
 *   - ids must be strictly increasing in the sorted order (no dupes)
 *   - `up` must be a non-empty array of non-empty strings
 *
 * **Returns**: the version number at end of run (= highest `id`
 * applied, or the pre-existing max if nothing new).
 */

import type { DatabaseAdapter } from '@dina/core';

export class MigrationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_migration'
      | 'duplicate_id'
      | 'migration_failed',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'MigrationError';
  }
}

/** A single migration step. `id` is a monotonically increasing integer. */
export interface Migration {
  id: number;
  description: string;
  /** SQL statements executed as a single transaction. */
  up: string[];
}

/**
 * Apply every migration whose `id` is greater than the current
 * `schema_version`. Creates the `schema_version` table if absent.
 * Returns the final version after the run.
 */
export function runMigrations(
  adapter: DatabaseAdapter,
  migrations: ReadonlyArray<Migration>,
  nowMsFn: () => number = () => Date.now(),
): number {
  if (!adapter) {
    throw new MigrationError('invalid_input', 'adapter is required');
  }
  if (!Array.isArray(migrations)) {
    throw new MigrationError('invalid_input', 'migrations must be an array');
  }
  const sorted = validateMigrations(migrations);

  ensureSchemaVersionTable(adapter);
  const current = currentVersion(adapter);
  let applied = current;

  for (const m of sorted) {
    if (m.id <= current) continue; // already applied
    try {
      adapter.transaction(() => {
        for (const stmt of m.up) {
          adapter.execute(stmt);
        }
        adapter.execute(
          'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
          [m.id, nowMsFn()],
        );
      });
      applied = m.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MigrationError(
        'migration_failed',
        `migration ${m.id} (${m.description}) failed: ${msg}`,
      );
    }
  }
  return applied;
}

/**
 * Read the current schema version (= max applied `id`, or 0 if none).
 * Exposed so callers can gate startup flows on version state without
 * running the full `runMigrations` path.
 */
export function getSchemaVersion(adapter: DatabaseAdapter): number {
  ensureSchemaVersionTable(adapter);
  return currentVersion(adapter);
}

// ── Internals ──────────────────────────────────────────────────────────

function validateMigrations(
  migrations: ReadonlyArray<Migration>,
): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  let lastId = -Infinity;
  for (const m of sorted) {
    if (!m || typeof m !== 'object') {
      throw new MigrationError('invalid_migration', 'migration must be an object');
    }
    if (!Number.isInteger(m.id) || m.id < 1) {
      throw new MigrationError('invalid_migration', `migration id ${String(m.id)} must be a positive integer`);
    }
    if (m.id === lastId) {
      throw new MigrationError('duplicate_id', `duplicate migration id ${m.id}`);
    }
    if (typeof m.description !== 'string') {
      throw new MigrationError('invalid_migration', `migration ${m.id} description must be a string`);
    }
    if (!Array.isArray(m.up) || m.up.length === 0) {
      throw new MigrationError('invalid_migration', `migration ${m.id} up must be a non-empty array`);
    }
    for (const stmt of m.up) {
      if (typeof stmt !== 'string' || stmt.trim().length === 0) {
        throw new MigrationError(
          'invalid_migration',
          `migration ${m.id} up contains a non-string or empty statement`,
        );
      }
    }
    lastId = m.id;
  }
  return sorted;
}

function ensureSchemaVersionTable(adapter: DatabaseAdapter): void {
  adapter.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function currentVersion(adapter: DatabaseAdapter): number {
  const rows = adapter.query<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_version',
  );
  const v = rows[0]?.v;
  return typeof v === 'number' ? v : 0;
}
