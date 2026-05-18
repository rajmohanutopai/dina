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
import { NodeDBProvider } from '@dina/storage-node';
import { hydrateContactDirectory } from '@dina/core';
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
  setAuditRepository,
  setChatMessageRepository,
  setContactRepository,
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

import type { Logger } from '../logger';

/**
 * Default personas seeded on first boot. Mirrors
 * `apps/mobile/src/onboarding/default_personas.ts` so the LLM-driven
 * persona classifier sees the same descriptions on either runtime.
 */
const DEFAULT_PERSONAS: ReadonlyArray<{
  name: string;
  tier: 'default' | 'standard' | 'sensitive' | 'locked';
  description: string;
}> = [
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
  const resolvePersonaDekHex = async (persona: string): Promise<string> =>
    bytesToHex(
      hkdf(sha256, seed32, new Uint8Array(32), encoder.encode(`dina:vault:${persona}:v1`), 32),
    );

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
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  setAuditRepository(new SQLiteAuditRepository(identityDB));
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  hydrateStagingFromRepository();
  setChatMessageRepository(new SQLiteChatMessageRepository(identityDB));
  setPeopleRepository(new SQLitePeopleRepository(identityDB));
  hydrateContactDirectory();
  await hydrateRemindersFromRepo();

  // Seed default personas, then open EVERY one — not just the tiered
  // auto-opens. The lite stack's only client is the owner's own app
  // (SPA / mobile); locked tiers (health, finance) are protections
  // against external agents, not against the owner of the home node
  // (memory: `user-vs-agent-persona-access`). Leaving them closed at
  // boot would silently break cross-domain synthesis ("Emma birthday
  // → finance budget") for the in-app user.
  const { createPersona, listPersonas, openPersona, personaExists, setPersonaDescription } =
    await import('@dina/core');
  for (const spec of DEFAULT_PERSONAS) {
    if (!personaExists(spec.name)) {
      createPersona(spec.name, spec.tier, spec.description);
      setPersonaDescription(spec.name, spec.description);
    }
  }
  const opened: string[] = [];
  for (const persona of listPersonas()) {
    openPersona(persona.name);
    const personaDB = await openPersonaVault(provider, persona.name);
    setVaultRepository(persona.name, new SQLiteVaultRepository(personaDB));
    setTopicRepository(persona.name, new SQLiteTopicRepository(personaDB));
    opened.push(persona.name);
  }
  logger.info({ openedPersonas: opened }, 'persona vaults opened');

  return { provider, identityDB, openedPersonas: opened };
}
