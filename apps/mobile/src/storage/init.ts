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

import { ProductionDBProvider } from './provider';
import {
  bootstrapPersistence,
  openPersonaVault,
  shutdownPersistence,
} from '@dina/core/src/storage/bootstrap';
import { setKVRepository } from '@dina/core/src/kv/store';
import { SQLiteKVRepository } from '@dina/core/src/kv/repository';
import {
  setContactRepository,
  SQLiteContactRepository,
} from '@dina/core/src/contacts/repository';
import { hydrateContactDirectory } from '@dina/core/src/contacts/directory';
import {
  setReminderRepository,
  SQLiteReminderRepository,
} from '@dina/core/src/reminders/repository';
import { setAuditRepository, SQLiteAuditRepository } from '@dina/core/src/audit/repository';
import { setDeviceRepository, SQLiteDeviceRepository } from '@dina/core/src/devices/repository';
import {
  setStagingRepository,
  SQLiteStagingRepository,
} from '@dina/core/src/staging/repository';
import {
  setVaultRepository,
  SQLiteVaultRepository,
  resetVaultRepositories,
} from '@dina/core/src/vault/repository';
import {
  setTopicRepository,
  SQLiteTopicRepository,
  resetTopicRepositories,
} from '@dina/core/src/memory/repository';
import { setMemoryService } from '@dina/core/src/memory/service';
import {
  setChatMessageRepository,
  SQLiteChatMessageRepository,
} from '@dina/core/src/chat/repository';
import type { DatabaseAdapter } from '@dina/core/src/storage/db_adapter';
// Expo 55 moved the document-directory constant behind `Paths.document` (a
// `Directory` object exposing `.uri`). The legacy flat `documentDirectory`
// export now lives under `expo-file-system/legacy` — we use it here because
// op-sqlite's `location` parameter takes a raw string directory URI.
import { Paths } from 'expo-file-system';

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
 * 2. Applies schema migrations
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

  // Open identity DB + apply migrations
  const identityDB = await bootstrapPersistence(provider);
  identityAdapter = identityDB;

  // Wire all identity-scoped repositories
  setKVRepository(new SQLiteKVRepository(identityDB));
  setContactRepository(new SQLiteContactRepository(identityDB));
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  setAuditRepository(new SQLiteAuditRepository(identityDB));
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  setChatMessageRepository(new SQLiteChatMessageRepository(identityDB));

  // GAP-PERSIST-02: hydrate the in-memory contact directory from
  // SQLite so persisted contacts (and their alias index) are visible
  // to `resolveByName`, `findByPreferredFor`, and the contacts
  // routes before any request comes in. Without this, a restart
  // silently drops every contact the user has stored.
  hydrateContactDirectory();
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
