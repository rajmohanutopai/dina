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

import { fireHeldReplay } from '../run/replay_registry';

import { setDBProvider, resetDBProvider } from './db_provider';
import { applyMigrations } from './migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from './schemas';

import type { DatabaseAdapter } from './db_adapter';
import type { DBProvider } from './db_provider';

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
  // R5-01 (§7 unlock-commit) — this is the SHARED persona-unlock choke point
  // for both boots (mobile `openPersonaDB`, lite `openVaultDB`, the agent
  // locked-persona unlock hook). The provider registered the DEK during
  // `openPersonaDB`, so a `held_by_lock` run response for this persona can be
  // admitted NOW. Best-effort no-op until the run plane registers its hook
  // (boot-time opens are covered by `recoverOnBoot`'s replayAll instead).
  fireHeldReplay(persona);
  return personaDB;
}

/**
 * Shutdown persistence — close all databases.
 */
export async function shutdownPersistence(): Promise<void> {
  await resetDBProvider();
}
