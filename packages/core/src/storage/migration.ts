/**
 * Schema migration runner — applies SQL migrations in order.
 *
 * Tracks applied migrations via a `schema_version` table.
 * Each migration has a version number and SQL string.
 * Migrations are applied in a transaction — all or nothing.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter } from './db_adapter';

export interface Migration {
  /** Monotonically increasing version number. */
  version: number;
  /** Human-readable name (e.g., "add_contacts_relationship"). */
  name: string;
  /** SQL to execute. May contain multiple statements separated by semicolons. */
  sql: string;
}

/**
 * Ensure the schema_version table exists.
 */
function ensureVersionTable(db: DatabaseAdapter): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
}

/**
 * Get the current schema version.
 * Returns 0 if no migrations have been applied.
 */
export function getCurrentVersion(db: DatabaseAdapter): number {
  ensureVersionTable(db);
  const rows = db.query<{ version: number }>('SELECT MAX(version) as version FROM schema_version');
  return rows[0]?.version ?? 0;
}

/**
 * Apply pending migrations to a database.
 *
 * Migrations with version <= current are skipped.
 * Each migration runs in a transaction.
 * Returns the number of migrations applied.
 */
export function applyMigrations(db: DatabaseAdapter, migrations: Migration[]): number {
  ensureVersionTable(db);
  const currentVersion = getCurrentVersion(db);

  // Sort by version ascending
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let applied = 0;

  for (const migration of sorted) {
    if (migration.version <= currentVersion) continue;

    db.transaction(() => {
      // Execute migration SQL (may contain multiple statements).
      // Triggers use BEGIN…END blocks whose body contains nested `;` —
      // a naive `split(';')` breaks them. `splitSQL` preserves trigger
      // bodies as one statement. Task 3.17 surfaced this: the real
      // SQLite backend rejects half-statements as "incomplete input"
      // where InMemoryDatabaseAdapter silently accepted the garbage.
      const statements = splitSQL(migration.sql);
      for (const stmt of statements) {
        db.execute(stmt);
      }

      // Record the migration
      db.execute('INSERT INTO schema_version (version, name) VALUES (?, ?)', [
        migration.version,
        migration.name,
      ]);
    });

    applied++;
  }

  return applied;
}

/**
 * Split a multi-statement SQL string into individual statements,
 * preserving CREATE TRIGGER ... BEGIN ... END blocks as atomic units.
 *
 * Simple state machine: a line that starts a TRIGGER sets `inTrigger`;
 * subsequent lines accumulate into the current buffer until a line
 * that starts with `END` (optionally followed by `;`) closes it.
 * Outside a trigger, statements end at lines whose last non-whitespace
 * char is `;`.
 *
 * Good enough for Dina's own schemas. Not a full SQL parser.
 */
function splitSQL(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inTrigger = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (!inTrigger && /^CREATE\s+TRIGGER\b/i.test(trimmed)) {
      inTrigger = true;
    }
    buf += line + '\n';
    if (inTrigger) {
      if (/^END\s*;?\s*$/i.test(trimmed)) {
        const stmt = buf.trim().replace(/;$/, '');
        if (stmt.length > 0) out.push(stmt);
        buf = '';
        inTrigger = false;
      }
    } else if (trimmed.endsWith(';')) {
      const stmt = buf.trim().replace(/;$/, '');
      if (stmt.length > 0) out.push(stmt);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * List all applied migrations.
 */
export function listAppliedMigrations(db: DatabaseAdapter): Array<{
  version: number;
  name: string;
  applied_at: number;
}> {
  ensureVersionTable(db);
  return db.query('SELECT version, name, applied_at FROM schema_version ORDER BY version ASC');
}
