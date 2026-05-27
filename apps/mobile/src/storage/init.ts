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

import { Paths } from 'expo-file-system';

import { hydrateNotifications } from '@dina/brain/notifications';
import {
  hydrateContactDirectory,
  SQLiteD2DOutboxRepository,
  setD2DOutboxRepository,
  recoverOutboxOnBoot,
  SQLiteAgentGrantRepository,
  setAgentGrantRepository,
  setAgentPersonaUnlockHook,
  setArchiveDataSource,
  listPersonas,
  getPersonaTier,
  createPersona,
  personaExists,
  type ArchivePersonaSource,
  type PersonaTier,
} from '@dina/core';
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

// Expo 55 exposes the document-directory constant through `Paths.document` (a
// `Directory` object exposing `.uri`). op-sqlite's `location` parameter takes a
// raw string directory URI, so we read the path from that object directly.

import { ProductionDBProvider } from './provider';

/** Tiers a restored persona may legitimately carry. */
const RESTORE_VALID_TIERS: ReadonlySet<string> = new Set([
  'default',
  'standard',
  'sensitive',
  'locked',
]);

/**
 * Map an archived persona's tier string to a valid `PersonaTier`. An
 * unrecognised value (corrupt/hostile archive) must NOT become the open
 * `default` tier — fall back to the most restrictive `locked` so a restore can
 * never silently downgrade a persona's access controls.
 */
function restoreTier(tier: string): PersonaTier {
  return (RESTORE_VALID_TIERS.has(tier) ? tier : 'locked') as PersonaTier;
}

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

  // issues.txt §1 — durable D2D outbox. Without this the outbox falls
  // back to an in-memory Map that loses every queued outbound message on
  // app kill/background, breaking service-query / approval / task-handoff
  // reliability. Installing the SQL repo makes `enqueueD2D` write-through
  // to identity.sqlite; `recoverOutboxOnBoot()` then reclaims any rows a
  // prior crash left mid-send (state='sending', lease expired) back to
  // 'pending'. The periodic drainer + the re-delivery function are wired
  // in boot_capabilities once the signing identity is available.
  setD2DOutboxRepository(new SQLiteD2DOutboxRepository(identityDB));
  recoverOutboxOnBoot();

  // issues.txt §2 — durable agent persona grants. Without this the
  // locked-vault approval gate has nowhere to record an approved grant,
  // so a paired agent could never resume after approval (and, worse, the
  // in-memory fallback would lose the grant on restart). Installing the
  // SQL repo makes `requireAgentPersonaAccess` durable end-to-end.
  setAgentGrantRepository(new SQLiteAgentGrantRepository(identityDB));

  // issues.txt §2 — approving an agent's locked-persona request also opens
  // that persona (derives its DEK into RAM) so the agent's retry can decrypt.
  // openPersonaDB derives the DEK from the unlocked master seed.
  setAgentPersonaUnlockHook((persona) => openPersonaDB(persona));

  // issues.txt §3 — real export/import. Wire the archive data source so a
  // UI "export" reads actual identity + per-persona rows (not the old
  // empty manifest) and a clean-install import restores them. Secrets are
  // excluded inside the archive layer (table allowlist + kv key denylist).
  setArchiveDataSource({
    identityAdapter: () => identityAdapter,
    personaSources: async (): Promise<ArchivePersonaSource[]> => {
      if (!provider) throw new Error('export: persistence not initialized');
      const out: ArchivePersonaSource[] = [];
      for (const p of listPersonas()) {
        // Open the vault on demand rather than skipping a not-yet-open
        // persona — backup is a sovereignty feature, so a partial archive
        // must not be produced silently. If a persona can't be opened the
        // open throws and the whole export fails loudly (issues.txt §3).
        const adapter = await openPersonaVault(provider, p.name);
        out.push({ name: p.name, tier: getPersonaTier(p.name), adapter });
      }
      return out;
    },
    openPersonaForRestore: async (name, tier) => {
      if (!provider) throw new Error('archive restore: persistence not initialized');
      // Register the persona in the registry with the ARCHIVED tier (P2.8) so
      // (a) the restored vault is visible this session and (b) a
      // sensitive/locked persona is never silently treated as the open default
      // tier — an access downgrade. Default personas are re-seeded with their
      // canonical tiers on next boot; an unknown tier from a (corrupt/hostile)
      // archive falls back to the most restrictive tier — fail safe.
      if (!personaExists(name)) {
        createPersona(name, restoreTier(tier));
      }
      const adapter = await openPersonaVault(provider, name);
      setVaultRepository(name, new SQLiteVaultRepository(adapter));
      setTopicRepository(name, new SQLiteTopicRepository(adapter));
      return adapter;
    },
    hasExistingUserData: async (): Promise<boolean> => {
      if (identityAdapter === null) return false;
      // Any of these identity tables holding a row means real user content
      // exists (clean-install import would merge/overwrite it). kv_store is
      // deliberately EXCLUDED — it carries system rows (notification perms/
      // mirrors) even on a fresh onboard, so it isn't a "user data" signal.
      const idTables = [
        'reminders',
        'contacts',
        'people',
        'person_identities',
        'chat_messages',
        'service_config',
      ];
      for (const t of idTables) {
        try {
          if (identityAdapter.query(`SELECT 1 FROM ${t} LIMIT 1`).length > 0) return true;
        } catch {
          /* table absent in this DB — ignore */
        }
      }
      // Persona vault content — check EVERY registered persona, opening it on
      // demand (the DEK derives from the master seed). Skipping not-yet-open
      // personas (P2.7) was a clean-install blind spot: a restore could merge
      // into a device whose only data lived in a closed/sensitive persona.
      const prov = provider;
      if (prov === null) return false;
      for (const p of listPersonas()) {
        try {
          const adapter = await openPersonaVault(prov, p.name);
          if (adapter.query('SELECT 1 FROM vault_items LIMIT 1').length > 0) return true;
        } catch {
          /* persona file absent / unreadable — treat as empty */
        }
      }
      return false;
    },
  });

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

  // Same gap, applied to the unified notifications inbox. Without
  // boot hydration, `hydrateNotifications` only ran lazily when the
  // user opened the Notifications tab — until then the in-memory
  // store was empty and the Approvals tab badge read 0 even when SQL
  // held N pending rows (MT-43-I1, live 2026-05-07: 5 pending
  // approvals visible inside the screen, badge stayed empty). The
  // hydrate fires a `'hydrated'` event so live badge subscribers
  // recompute against the freshly restocked store.
  await hydrateNotifications();
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
