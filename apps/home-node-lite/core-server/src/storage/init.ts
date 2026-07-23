/**
 * Storage initialization for core-server.
 *
 * Mirrors `apps/mobile/src/storage/init.ts` for the Node runtime:
 * derive identity + persona DEKs from the master seed, open the
 * SQLCipher identity database via `@dina/storage-node`, run identity
 * + persona migrations, then wire every identity-scoped repository
 * the Core HTTP surface reads/writes through.
 *
 * Called once at boot, after `loadOrGenerateSeed` returns the master
 * seed. Until this runs the in-memory inbox fallbacks accept writes
 * but lose them on restart — so a `/remember` chat round-trip
 * succeeds at the HTTP layer but its vault row never persists.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  RunService,
  SQLiteClassificationJobRepository,
  SQLiteCommandReceiptRepository,
  SQLiteCompletionReceiptRepository,
  SQLiteErasureKeyStore,
  SQLiteMessageRepository,
  SQLiteReservationRepository,
  SQLiteRunRepository,
  SQLiteServiceConfigRepository,
  SQLiteD2DOutboxRepository,
  SQLiteAgentGrantRepository,
  SessionRegistry,
  SQLiteSessionRepository,
  setSessionRegistry,
  hydrateContactDirectory,
  hydrateServiceConfig,
  recoverOutboxOnBoot,
  registerPersonaDEK,
  setAgentGrantRepository,
  setAgentPersonaUnlockHook,
  SQLitePushSubscriptionRepository,
  setClassificationJobRepository,
  setCommandReceiptRepository,
  setCommandTxRunner,
  setCompletionReceiptRepository,
  setD2DOutboxRepository,
  setPushSubscriptionRepository,
  setErasureKeyStore,
  setMessageRepository,
  setPluginDeviceVerifier,
  setReservationRepository,
  setRunRepository,
  setRunService,
  setServiceConfigRepository,
  setNotificationLogRepository,
  SqliteNotificationLogRepository,
} from '@dina/core';
import { getDeviceByDID } from '@dina/core/devices';
import { hydrateDeviceRegistry } from '@dina/core/runtime';
import {
  SQLiteAuditRepository,
  SQLiteChatMessageRepository,
  SQLiteContactRepository,
  SQLiteServiceOfferRepository,
  SQLiteServiceDecisionRepository,
  SQLiteServiceGrantRepository,
  SQLitePluginInstallRepository,
  SQLitePluginGrantRepository,
  SQLitePluginDecisionRepository,
  setPluginInstallRepository,
  setPluginGrantRepository,
  setPluginDecisionRepository,
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
  setAuditRepository,
  setChatMessageRepository,
  setContactRepository,
  setServiceOfferRepository,
  setServiceDecisionRepository,
  setServiceGrantRepository,
  setDeviceRepository,
  setKVRepository,
  setPeopleRepository,
  setReminderRepository,
  setStagingRepository,
  setTopicRepository,
  setVaultRepository,
  type DatabaseAdapter,
  type DBProvider,
} from '@dina/core/storage';
import { NodeDBProvider } from '@dina/storage-node';

import type { Logger } from '../logger';

/**
 * Default personas seeded on first boot. Mirrors
 * `apps/mobile/src/onboarding/default_personas.ts` so the LLM-driven
 * persona classifier sees the same descriptions on either runtime.
 */
const DEFAULT_PERSONAS: readonly {
  name: string;
  tier: 'default' | 'standard' | 'sensitive' | 'locked';
  description: string;
}[] = [
  {
    name: 'general',
    tier: 'default',
    description:
      'Personal facts, preferences, family, relationships, hobbies, recipes, pets, birthdays, daily life, opinions',
  },
  {
    name: 'work',
    tier: 'standard',
    description:
      'Professional context, meetings, colleagues, deadlines, projects, office logistics, career',
  },
  {
    name: 'health',
    tier: 'sensitive',
    description:
      'Medical records, diagnoses, prescriptions, lab results, doctor visits, symptoms, allergies, medications, vital signs',
  },
  {
    name: 'finance',
    tier: 'sensitive',
    description:
      'Bank accounts, investments, bills, rent, salary, tax, loans, insurance, financial planning',
  },
];

export interface StorageInitResult {
  /** The `DBProvider` instance — kept so caller can open more personas later. */
  provider: DBProvider;
  /** The identity DB adapter — needed for any future identity-scoped wiring. */
  identityDB: DatabaseAdapter;
  /** Personas that were opened (default + standard tier). */
  openedPersonas: string[];
}

/**
 * Initialize SQLite persistence + wire every identity-scoped
 * repository. Idempotent for the personas that already exist.
 *
 * Identity DEK and per-persona DEKs are derived from `masterSeed`
 * via HKDF-SHA256 with a constant zero-salt:
 *
 *   identityDEK = HKDF(sha256, masterSeed[:32], 0, "dina:vault:identity:v1", 32)
 *   personaDEK  = HKDF(sha256, masterSeed[:32], 0, "dina:vault:<name>:v1",  32)
 *
 * The lite stack is single-tenant; the per-install salt that mobile's
 * `derivePersonaDEK(masterSeed, persona, userSalt)` requires would
 * mostly be a constant here, so we collapse that to a zero salt.
 * Identical seed → identical DEKs across restarts (the desired
 * property — restart must open the same vault).
 */
export async function initializeStorage(
  masterSeed: Uint8Array,
  vaultDir: string,
  logger: Logger,
): Promise<StorageInitResult> {
  if (masterSeed.length < 32) {
    throw new Error(`initializeStorage: master seed too short (${masterSeed.length}, need ≥32)`);
  }
  const seed32 = masterSeed.slice(0, 32);

  const encoder = new TextEncoder();
  const identityDekHex = bytesToHex(
    hkdf(sha256, seed32, new Uint8Array(32), encoder.encode('dina:vault:identity:v1'), 32),
  );
  const resolvePersonaDekHex = async (persona: string): Promise<string> => {
    const dek = hkdf(sha256, seed32, new Uint8Array(32), encoder.encode(`dina:vault:${persona}:v1`), 32);
    // ISVC-10/R5-01 — register the DEK with the orchestrator so the run
    // plane's persona-open predicate (`hasDEK`) and payload cipher
    // (`wrapWithPersonaDEK`) see this vault as open. The registry takes
    // ownership of a copy (zeroed on release); the hex string feeds SQLCipher.
    registerPersonaDEK(persona, dek.slice());
    return bytesToHex(dek);
  };

  const provider = new NodeDBProvider({
    vaultDir,
    identityDekHex,
    resolvePersonaDekHex,
  });

  const identityDB = await bootstrapPersistence(provider);
  logger.info({ vaultDir }, 'identity SQLite opened + migrated');

  // Wire every identity-scoped repository the Core HTTP surface uses.
  setKVRepository(new SQLiteKVRepository(identityDB));
  setContactRepository(new SQLiteContactRepository(identityDB));
  setServiceOfferRepository(new SQLiteServiceOfferRepository(identityDB));
  setServiceDecisionRepository(new SQLiteServiceDecisionRepository(identityDB));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(identityDB));
  // Plugin dynamic registry (PLUGIN_ARCHITECTURE.md §6): installs +
  // grants (constraints, per-execution consumption) + owner-private
  // decision log.
  setPluginInstallRepository(new SQLitePluginInstallRepository(identityDB));
  setPluginGrantRepository(new SQLitePluginGrantRepository(identityDB));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(identityDB));
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  // R4-03 — the durable notification log (identity.sqlite). On the split server
  // Core owns it; Brain reaches it over the `/v1/notifications` routes so its
  // inbox dual-write survives restart here too.
  setNotificationLogRepository(new SqliteNotificationLogRepository(identityDB));
  setAuditRepository(new SQLiteAuditRepository(identityDB));
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  // Round-8 #2: wire the agent-grant repo BEFORE hydrating devices —
  // `hydrateDeviceRegistry` runs the boot reconciler, which must be able to
  // revoke a crash-orphaned revoked device's AGENT persona grants (not only its
  // plugin authority). Wiring it after hydrate left that half unreconciled.
  setAgentGrantRepository(new SQLiteAgentGrantRepository(identityDB));
  // Item D — durable coding-agent sessions. Back the SessionRegistry with the
  // identity SQLite store and reconcile on boot so a session (Claude Code /
  // Codex) survives a Core restart, and any session whose lease lapsed while
  // Core was down is reaped. `setSessionRegistry` replaces the auto-provisioned
  // in-memory global that every /v1/session route + the coding gate read.
  const sessionRegistry = new SessionRegistry(
    undefined,
    undefined,
    new SQLiteSessionRepository(identityDB),
  );
  sessionRegistry.reconcile();
  setSessionRegistry(sessionRegistry);
  // Pull every previously-paired device back into the in-memory
  // registry. Without this, every signed call from a paired agent
  // (workflow claim, service.query) lands as caller-type 'unknown'
  // and 403s. Matches mobile's boot_capabilities.ts.
  await hydrateDeviceRegistry();

  // PLG-29 #7: a runner plugin can only activate on a device that is a REAL,
  // unrevoked, role='plugin' registry entry. install_service can't import the
  // device registry (cycle), so the verifier is WIRED here at boot. Fail-closed:
  // if this is never wired, no runner install can activate.
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });

  // Service-config repo + hydrate. Without hydration, `getServiceConfig()`
  // returns null at boot even when a config was previously persisted —
  // and `isCapabilityConfigured` (consulted by D2D ingress for the
  // service-query bypass) reads that null and denies every inbound
  // service.query at the contact gate.
  setServiceConfigRepository(new SQLiteServiceConfigRepository(identityDB));
  await hydrateServiceConfig();
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  hydrateStagingFromRepository();
  // Interactive-run control store + service (INTERACTIVE_SERVICES §5/§12.5).
  const runRepository = new SQLiteRunRepository(identityDB);
  setRunRepository(runRepository);
  setRunService(new RunService({ repository: runRepository }));
  // Per-payload leaf erasure-key store (§13). Tier-0 backend ⇒ honest
  // `logical_deletion` crypto-shred on the shipping stack; a hardened
  // non-backed backend upgrades this to `backup_resistant` later.
  setErasureKeyStore(new SQLiteErasureKeyStore(identityDB));
  // Reservation store — the atomic bounded-queue admission slot (§7).
  setReservationRepository(new SQLiteReservationRepository(identityDB));
  // Per-message lifecycle + Brain-classify job stores (§6.3/§12.6).
  setMessageRepository(new SQLiteMessageRepository(identityDB));
  setClassificationJobRepository(new SQLiteClassificationJobRepository(identityDB));
  // Completion-receipt store — two-step idempotent-CAS advancement (§6.2).
  setCompletionReceiptRepository(new SQLiteCompletionReceiptRepository(identityDB));
  // Durable owner-command idempotency receipts (§12.5). The tx runner makes each
  // owner command's mutation + its receipt write ONE atomic identity.sqlite
  // commit (§5), so a crash can never lose a receipt and let a replayed old
  // command re-execute.
  setCommandReceiptRepository(new SQLiteCommandReceiptRepository(identityDB));
  setCommandTxRunner((fn) => identityDB.transaction(fn));
  // Push subscription store — the default-deny authorization gate + rate/cry-wolf
  // counters (PUSH_SERVICES_ARCHITECTURE.md §6/§15).
  setPushSubscriptionRepository(new SQLitePushSubscriptionRepository(identityDB));
  setChatMessageRepository(new SQLiteChatMessageRepository(identityDB));
  setPeopleRepository(new SQLitePeopleRepository(identityDB));
  hydrateContactDirectory();
  await hydrateRemindersFromRepo();

  // issues.txt §1 — durable D2D outbox (shared egress path with mobile).
  // Lite is a long-running process but still restarts; a queued service-
  // query/response that couldn't deliver immediately must survive. The
  // re-delivery fn + periodic drainer are wired in wire_workflow_plane
  // (where the signing identity + sendD2D live); here we just install the
  // SQL repo and reclaim crash-orphaned 'sending' rows.
  setD2DOutboxRepository(new SQLiteD2DOutboxRepository(identityDB));
  recoverOutboxOnBoot();

  // (agent persona grant repo — issues.txt §2 — is now wired ABOVE, before
  // hydrateDeviceRegistry, so the boot reconciler can reach it. Round-8 #2.)

  // Seed default personas, then open EVERY one via the shared
  // lifecycle helper. The lite stack's only client is the owner's own
  // app (SPA / mobile); locked tiers (health, finance) are protections
  // against external agents, not against the owner of the home node
  // (memory: `user-vs-agent-persona-access`). Leaving them closed at
  // boot would silently break cross-domain synthesis ("Emma birthday
  // → finance budget") for the in-app user.
  //
  // `openAllPersonasForInAppUser` is the same helper mobile's
  // `useUnlock` calls — one place to evolve the rule, one suite to
  // test it (`packages/home-node/__tests__/persona_lifecycle.test.ts`).
  // The `openVaultDB` callback wires the per-persona SQLite vault
  // handle + the topic repo after the registry marks it open.
  const { createPersona, personaExists, setPersonaDescription } = await import('@dina/core');
  const { openAllPersonasForInAppUser } = await import('@dina/home-node');
  for (const spec of DEFAULT_PERSONAS) {
    if (!personaExists(spec.name)) {
      createPersona(spec.name, spec.tier, spec.description);
      setPersonaDescription(spec.name, spec.description);
    }
  }
  const openVaultDB = async (persona: string): Promise<void> => {
    const personaDB = await openPersonaVault(provider, persona);
    setVaultRepository(persona, new SQLiteVaultRepository(personaDB));
    setTopicRepository(persona, new SQLiteTopicRepository(personaDB));
  };
  const opened = await openAllPersonasForInAppUser({ openVaultDB });
  logger.info({ openedPersonas: opened }, 'persona vaults opened');

  // issues.txt §2 — approving an agent locked-persona request also opens
  // that persona's vault (DEK into RAM) so the agent's retry can decrypt.
  setAgentPersonaUnlockHook(openVaultDB);

  return { provider, identityDB, openedPersonas: opened };
}
