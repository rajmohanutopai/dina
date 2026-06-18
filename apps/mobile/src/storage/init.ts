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
  wireIdentityScopeCleanups,
  wirePersonaScopeCleanups,
  type ArchivePersonaSource,
  type PersonaTier,
} from '@dina/core';
// Chat thread cache lives in the Brain module (in-memory Map, authoritative
// for rendering). `resetThreads()` clears it on teardown so a previous
// identity's conversation can't survive into the next one (privacy: erase +
// re-login leaked old chats because this cache was never reset).
import { resetThreads } from '@dina/brain/chat';
import {
  SQLiteAuditRepository,
  SQLiteChatMessageRepository,
  SQLiteContactRepository,
  SQLiteServiceOfferRepository,
  SQLiteServiceGrantRepository,
  SQLiteDeviceRepository,
  SQLiteKVRepository,
  SQLitePeopleRepository,
  SQLitePersonaRepository,
  SQLiteQuarantineRepository,
  SQLiteReminderRepository,
  SQLiteStagingRepository,
  SQLiteTopicRepository,
  SQLiteVaultRepository,
  bootstrapPersistence,
  hydratePersonas,
  hydrateQuarantineFromRepository,
  hydrateRemindersFromRepo,
  hydrateStagingFromRepository,
  openPersonaVault,
  resetQuarantineState,
  resetStagingState,
  resetTopicRepositories,
  resetVaultRepositories,
  setAuditRepository,
  setChatMessageRepository,
  setContactRepository,
  setServiceOfferRepository,
  setServiceGrantRepository,
  setDeviceRepository,
  setKVRepository,
  setMemoryService,
  setPeopleRepository,
  setPersonaRepository,
  setQuarantineRepository,
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
 * Persona DBs opened this session, by name. Backs the guided-demo per-persona
 * cleanup: the demo's memory routes to whatever persona (general/health/…), and
 * those personas are open for the duration of the demo, so cleanup deletes the
 * demo scope across all of them.
 */
const openPersonaAdapters = new Map<string, DatabaseAdapter>();

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
  // Defense-in-depth privacy reset: clear in-memory content caches before
  // wiring this identity's stores. Tier-2 "erase" tears down through
  // shutdownAllPersistence (which resets these), but Tier-1 "sign out" does
  // NOT — so a sign-out followed by logging in as a DIFFERENT identity (same
  // JS process, no restart) would otherwise inherit the previous user's
  // chat / staging / quarantine caches. Resetting here makes every identity
  // bring-up start clean; on a normal cold boot the caches are already empty,
  // so these are no-ops. All three are in-memory-only resets (staging uses
  // preserveRepositoryRows so it never touches a DB).
  resetThreads();
  resetStagingState({ preserveRepositoryRows: true });
  resetQuarantineState();

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
  setServiceOfferRepository(new SQLiteServiceOfferRepository(identityDB));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(identityDB));
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  setAuditRepository(new SQLiteAuditRepository(identityDB));
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  hydrateStagingFromRepository();
  // D2D quarantine: persist + re-hydrate so the "Unknown sender" card's
  // Accept/Block survive a restart (the in-memory store empties on boot).
  setQuarantineRepository(new SQLiteQuarantineRepository(identityDB));
  hydrateQuarantineFromRepository();
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

  // Durable persona registry — user-created vaults persist here so a
  // restart restores them (hydratePersonas below). Without it, boot only
  // re-seeds the 4 code-defined defaults and a custom vault vanishes.
  setPersonaRepository(new SQLitePersonaRepository(identityDB));

  // Guided-demo cleanup wiring — register every scoped table's deleter so
  // `deleteDataScope`/`tearDownDataScope` can remove a demo run end-to-end.
  // Identity-DB tables read the live identity adapter; per-persona vault tables
  // sum across the personas opened this session.
  wireIdentityScopeCleanups(() => identityAdapter);
  // Open EVERY registered persona for cleanup, not just the currently-open set:
  // a demo can route content into a sensitive/locked persona (health/financial)
  // that's closed at teardown — notably after a crash-recovery boot where only
  // the default personas are open. openAllPersonaAdapters mirrors the export
  // path (opens each on demand) so no demo row is left behind in a closed vault.
  wirePersonaScopeCleanups(() => openAllPersonaAdapters());

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
        'service_configs',
        'contact_service_offers',
        'service_grants',
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

  // Restore user-created personas into the registry BEFORE the unlock's
  // open-loop (openAllPersonasForInAppUser) runs, so a custom vault gets
  // opened + its DEK/vault repo wired exactly like the builtins. Builtins
  // are re-seeded from code (seedDefaultPersonas), so this only re-adds the
  // user-created ones the durable registry holds.
  hydratePersonas();

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
/** Names of persona vaults opened this session (for guided-demo rehydration). */
export function getOpenPersonaNames(): string[] {
  return [...openPersonaAdapters.keys()];
}

/**
 * Open EVERY registered persona vault and return their adapters, opening any
 * that aren't open yet (deriving their DEK on demand, like the export path).
 * Backs guided-demo persona cleanup: a demo row in a persona that's closed at
 * teardown (health/financial after a crash-recovery boot) must still be
 * deleted. Opened adapters are cached in `openPersonaAdapters` so the
 * subsequent HNSW rebuild sees them.
 *
 * A registered persona that FAILS to open is NOT silently skipped: op-sqlite
 * creates the DB on open, so a throw means a real error (corruption, I/O), not a
 * benign absent file. We collect those names in `failed` and hand them to the
 * cleanup wiring, which records a cleanup error so the recovery record is kept
 * (rows in that persona may still hold demo data) instead of being lost.
 */
async function openAllPersonaAdapters(): Promise<{ adapters: DatabaseAdapter[]; failed: string[] }> {
  if (!provider) return { adapters: [], failed: [] };
  const adapters: DatabaseAdapter[] = [];
  const failed: string[] = [];
  for (const p of listPersonas()) {
    try {
      const adapter = await openPersonaVault(provider, p.name);
      openPersonaAdapters.set(p.name, adapter);
      adapters.push(adapter);
    } catch (err) {
      // Real open failure → surface it so teardown preserves recovery.
      failed.push(p.name);
       
      console.warn(
        `[storage/init] persona "${p.name}" failed to open for cleanup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { adapters, failed };
}

export async function openPersonaDB(persona: string): Promise<void> {
  if (!provider) throw new Error('persistence: not initialized — call initializePersistence first');
  const personaDB = await openPersonaVault(provider, persona);
  openPersonaAdapters.set(persona, personaDB); // for guided-demo per-persona cleanup
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
  try {
    await shutdownPersistence();
  } finally {
    // The module-global resets MUST run even if the DB shutdown throws —
    // otherwise a previous user's in-memory state (notably the D2D quarantine
    // map + repo handle) survives a failed teardown. eraseEverythingLocal()
    // catches a shutdown failure and continues, so this path is real. These
    // setters/resets are all non-throwing, so the `finally` stays clean and
    // any DB-shutdown error still propagates afterwards.
    resetVaultRepositories();
    resetTopicRepositories();
    setQuarantineRepository(null);
    resetQuarantineState();
    // Chat threads — same class of leak as the quarantine map above. The
    // chat UI renders from Brain's in-memory `threads` Map; without this
    // reset it survives erase/sign-out (the JS process isn't restarted), so
    // a NEW identity's chat shows the PREVIOUS user's messages (hydrateThread
    // MERGEs by default, so an empty new-identity disk doesn't displace the
    // stale cache). Drop the repo handle too so a post-teardown write can't
    // land in a closed DB. Privacy bug: erase + re-login leaked old chats.
    resetThreads();
    setChatMessageRepository(null);
    // Staging inbox — same cross-identity in-memory leak as chat/quarantine.
    // It caches in-flight /remember content (raw, pre-classification). Null
    // the repo first so the reset's repo.clear() is a no-op, and pass
    // preserveRepositoryRows so we never write to the just-closed DB.
    setStagingRepository(null);
    resetStagingState({ preserveRepositoryRows: true });
    // Drop the persona repository too — otherwise a previous session's handle
    // survives teardown and a post-shutdown createPersona(persist:true) would
    // write to a closed DB instead of failing closed.
    setPersonaRepository(null);
    openPersonaAdapters.clear();
    setMemoryService(null);
    provider = null;
    identityAdapter = null;
  }
}
