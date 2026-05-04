/**
 * App persistence initialization — called after identity unlock.
 *
 * Wires all SQL repositories into the service modules.
 * After this call, all data operations persist to SQLCipher databases.
 *
 * Usage in app startup:
 *   const masterSeed = await unwrapSeed(passphrase, wrappedSeed);
 *   await initializePersistence(masterSeed, userSalt);
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import {
  SQLiteAuditRepository,
  SQLiteChatMessageRepository,
  SQLiteContactRepository,
  SQLiteDeviceRepository,
  SQLiteKVRepository,
  SQLitePeopleRepository,
  SQLiteReminderRepository,
  SQLiteStagingRepository,
  SQLiteTopicRepository,
  SQLiteVaultRepository,
  bootstrapPersistence,
  hydrateRemindersFromRepo,
  hydrateStagingFromRepository,
  openPersonaVault,
  resetTopicRepositories,
  resetVaultRepositories,
  setAuditRepository,
  setChatMessageRepository,
  setContactRepository,
  setDeviceRepository,
  setKVRepository,
  setMemoryService,
  setPeopleRepository,
  setReminderRepository,
  setStagingRepository,
  setTopicRepository,
  setVaultRepository,
  shutdownPersistence,
  type DatabaseAdapter,
} from '@dina/core/storage';
import { hydrateContactDirectory } from '@dina/core';
// Expo 55 exposes the document-directory constant through `Paths.document` (a
// `Directory` object exposing `.uri`). op-sqlite's `location` parameter takes a
// raw string directory URI, so we read the path from that object directly.
import { Paths } from 'expo-file-system';

import { ProductionDBProvider } from './provider';

/** The active provider. */
let provider: ProductionDBProvider | null = null;
/**
 * The open identity database adapter, cached for consumers like
 * `boot_capabilities` that need to feed it to `bootAppNode` as the
 * workflow + service-config durable store. Reset to `null` on shutdown.
 */
let identityAdapter: DatabaseAdapter | null = null;

/**
 * Initialize all persistence after identity unlock.
 *
 * 1. Opens the identity database (encrypted with identity DEK)
 * 2. Applies schema setup
 * 3. Wires all SQL repositories into service modules
 * 4. Returns the provider for persona DB management
 */
export async function initializePersistence(
  masterSeed: Uint8Array,
  userSalt: Uint8Array,
): Promise<void> {
  // Use Expo's document directory for database storage. `Paths.document`
  // returns a `Directory` whose `.uri` is a `file://…/` string — op-sqlite
  // wants a raw filesystem path without the scheme prefix.
  const docUri = Paths.document.uri;
  const dbDir = docUri.startsWith('file://') ? docUri.slice('file://'.length) : docUri;

  // Lazy import op-sqlite (native module, not available in tests)
  const { open } = require('@op-engineering/op-sqlite');

  provider = new ProductionDBProvider({
    dbDir,
    masterSeed,
    userSalt,
    openFn: open,
  });

  // Open identity DB + apply schema setup
  const identityDB = await bootstrapPersistence(provider);
  identityAdapter = identityDB;

  // Wire all identity-scoped repositories
  setKVRepository(new SQLiteKVRepository(identityDB));
  setContactRepository(new SQLiteContactRepository(identityDB));
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  setAuditRepository(new SQLiteAuditRepository(identityDB));
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  hydrateStagingFromRepository();
  setChatMessageRepository(new SQLiteChatMessageRepository(identityDB));
  // People graph backs the reminder planner's sender resolver +
  // the post-publish people-graph extractor. Without it,
  // `getPeopleRepository()` returns null → `resolveSenderHint`
  // bails → inbound D2D from a known contact never expands the
  // FTS query with the contact's confirmed surfaces, so vault
  // facts stored under that person's name don't surface in the
  // reminder's LLM context. Symptom in production: a "Sancho is
  // arriving in 15 min" D2D produced a generic reminder with no
  // Sancho-specific context, even though the user had stored
  // notes about him.
  setPeopleRepository(new SQLitePeopleRepository(identityDB));

  // GAP-PERSIST-02: hydrate the in-memory contact directory from
  // SQLite so persisted contacts (and their alias index) are visible
  // to `resolveByName`, `findByPreferredFor`, and the contacts
  // routes before any request comes in. Without this, a restart
  // silently drops every contact the user has stored.
  hydrateContactDirectory();

  // Same gap, applied to reminders. `createReminder` write-throughs to
  // SQL but reads (`listPending`, `listByPersona`) only check the
  // in-memory Map — without this hydrate, the Reminders tab is empty
  // after every cold start and a /remember from yesterday vanishes
  // even though the row is still in identity.sqlite. Caught on the
  // simulator: a /remember reminder showed up in the chat reply
  // immediately, but switching to the Reminders tab after the JS
  // engine reloaded showed "No reminders yet".
  await hydrateRemindersFromRepo();
}

/**
 * Get the open identity DatabaseAdapter — `null` when persistence hasn't
 * been initialized yet (pre-unlock, or running in a test harness that
 * doesn't boot op-sqlite). `boot_capabilities` reads this to decide
 * between SQLite and in-memory workflow repositories.
 */
export function getIdentityAdapter(): DatabaseAdapter | null {
  return identityAdapter;
}

/** True when initializePersistence has run successfully. */
export function isPersistenceReady(): boolean {
  return identityAdapter !== null;
}

/**
 * Open a persona vault database after persona unlock.
 *
 * Called when the user unlocks a persona (provides DEK).
 * Wires the persona's vault repository + topic (working-memory) repository.
 * Persona DBs share a single adapter — the topic repo reads from the same
 * handle as vault, which matches the Go `TopicStoreFor(persona)` layout
 * (one persona DB = one vault + topic store pair).
 */
export async function openPersonaDB(persona: string): Promise<void> {
  if (!provider) throw new Error('persistence: not initialized — call initializePersistence first');
  const personaDB = await openPersonaVault(provider, persona);
  setVaultRepository(persona, new SQLiteVaultRepository(personaDB));
  setTopicRepository(persona, new SQLiteTopicRepository(personaDB));
}

/**
 * Shutdown all persistence — close databases, clear repositories.
 *
 * Called on app background or explicit logout. Per-persona repo maps
 * (vault + topic) are cleared so a stale reader can't keep querying
 * a closed DB; the module-global `MemoryService` is dropped so the
 * /v1/memory routes 503 until the next boot re-installs it.
 */
export async function shutdownAllPersistence(): Promise<void> {
  await shutdownPersistence();
  resetVaultRepositories();
  resetTopicRepositories();
  setMemoryService(null);
  provider = null;
  identityAdapter = null;
}
