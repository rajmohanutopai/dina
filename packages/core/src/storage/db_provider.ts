/**
 * Database provider — manages identity and persona database lifecycle.
 *
 * Two-database architecture (matching Go):
 *   Identity DB: global, encrypted with identity DEK. Contains contacts,
 *     audit_log, paired_devices, reminders, staging_inbox, kv_store.
 *   Persona DBs: one per persona, each encrypted with its own DEK.
 *     Contains vault_items + FTS5.
 *
 * The provider is injectable — tests use InMemoryDatabaseAdapter,
 * production uses OpSQLiteAdapter.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. The
 * async contract future-proofs for storage backends where opening a
 * DB involves I/O (filesystem permissions, DEK derivation, migration
 * application). Current SQLite-under-go-sqlcipher implementations
 * stay sync internally and wrap results in `Promise.resolve`.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter } from './db_adapter';

/**
 * Database provider interface.
 */
export interface DBProvider {
  /** Open the global identity database. */
  openIdentityDB(): Promise<DatabaseAdapter>;

  /** Open a persona-specific vault database. */
  openPersonaDB(persona: string): Promise<DatabaseAdapter>;

  /** Close a persona database. */
  closePersonaDB(persona: string): Promise<void>;

  /** Get the identity database (null if not opened). */
  getIdentityDB(): Promise<DatabaseAdapter | null>;

  /** Get a persona database (null if not opened). */
  getPersonaDB(persona: string): Promise<DatabaseAdapter | null>;

  /** Close all databases. */
  closeAll(): Promise<void>;
}

/** The active provider. Null = no persistence (in-memory mode). */
let provider: DBProvider | null = null;

/** Set the database provider (called at app startup). */
export function setDBProvider(p: DBProvider | null): void {
  provider = p;
}

/** Get the active database provider. */
export function getDBProvider(): DBProvider | null {
  return provider;
}

/** Get the identity database adapter (null if no persistence). */
export async function getIdentityDB(): Promise<DatabaseAdapter | null> {
  return provider ? provider.getIdentityDB() : null;
}

/** Get a persona database adapter (null if no persistence). */
export async function getPersonaDB(persona: string): Promise<DatabaseAdapter | null> {
  return provider ? provider.getPersonaDB(persona) : null;
}

/** Reset provider (for testing). */
export async function resetDBProvider(): Promise<void> {
  if (provider) {
    await provider.closeAll();
  }
  provider = null;
}
