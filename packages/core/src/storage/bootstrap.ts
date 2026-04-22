/**
 * Persistence bootstrap — initializes databases at app startup.
 *
 * Called after identity unlock (passphrase → master seed available).
 * Opens the identity database, applies migrations, and wires
 * repository instances into each service module.
 *
 * Persona databases are opened on-demand when a persona is unlocked.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter } from './db_adapter';
import type { DBProvider } from './db_provider';
import { setDBProvider, resetDBProvider } from './db_provider';
import { applyMigrations } from './migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from './schemas';

/**
 * Bootstrap persistence with the given database provider.
 *
 * 1. Sets the provider
 * 2. Opens the identity database
 * 3. Applies identity schema migrations
 * 4. Returns the identity DB adapter for repository wiring
 *
 * Persona DBs are opened separately via `openPersonaVault()`.
 */
export async function bootstrapPersistence(provider: DBProvider): Promise<DatabaseAdapter> {
  setDBProvider(provider);

  // Open and migrate identity database
  const identityDB = await provider.openIdentityDB();
  applyMigrations(identityDB, IDENTITY_MIGRATIONS);

  return identityDB;
}

/**
 * Open a persona vault database and apply migrations.
 *
 * Called when a persona is unlocked (DEK becomes available).
 * Returns the persona DB adapter for vault repository wiring.
 */
export async function openPersonaVault(
  provider: DBProvider,
  persona: string,
): Promise<DatabaseAdapter> {
  const personaDB = await provider.openPersonaDB(persona);
  applyMigrations(personaDB, PERSONA_MIGRATIONS);
  return personaDB;
}

/**
 * Shutdown persistence — close all databases.
 */
export async function shutdownPersistence(): Promise<void> {
  await resetDBProvider();
}
