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

import { GOODS_BUYER, installGoodsCounterStrategy } from '../commerce/goods_counter_strategy';
import { installEvidenceStore } from '../commitment/evidence_handler';
import { setCommitmentPersonaDB , ValueModelStore } from '../commitment/model_store';
import { installOptionStores, setShipperFeeSubmitter } from '../commitment/option_handler';
import { StrategyStore } from '../commitment/strategy_store';
import { createNegotiationSubmitter } from '../commitment/strategy_submit';
import { StrategyTurnStore } from '../commitment/strategy_turns';
import { BookingStore, installBookingStore } from '../coordination/group_booking';
import { GROUP_ORGANIZER, installGroupSlotStrategy } from '../coordination/group_slot_strategy';
import { installSharingPolicyStore } from '../gatekeeper/sharing';
import { getNodeDID } from '../pairing/ceremony';
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
  // COMMITMENT_KERNEL §11 — sharing tiers survive a restart.
  installSharingPolicyStore(identityDB);
  installBookingStore(new BookingStore(identityDB));
  // COMMITMENT_KERNEL §15 step 7 — options issued and taken up survive a restart.
  installOptionStores(identityDB);
  // §15 step 11 — a shipper's fee may be Brain's: the door to the owner's
  // reasoning backend, read when a request arrives.
  const submitMove = createNegotiationSubmitter({ ownerDid: () => getNodeDID() ?? '' });
  setShipperFeeSubmitter(submitMove);
  // §15 step 11 — and a group booking's slot, among those every required guest accepted.
  const strategies = new StrategyStore(identityDB);
  installGroupSlotStrategy({
    settings: () => strategies.settings(GROUP_ORGANIZER),
    canSpend: (negotiationId, nowMs) =>
      strategies.canSpend({ kind: GROUP_ORGANIZER, negotiationId, nowMs, thresholdVersion: 0 }).ok,
    charge: (negotiationId, nowMs) =>
      strategies.charge({ kind: GROUP_ORGANIZER, negotiationId, count: 1, nowMs, thresholdVersion: 0 }).ok,
    turns: new StrategyTurnStore(identityDB),
    submit: submitMove,
    atomically: (fn) => identityDB.transaction(fn),
  });
  // §15 step 11 — and a goods tender's counter targets, for the buyer.
  installGoodsCounterStrategy({
    settings: () => strategies.settings(GOODS_BUYER),
    canSpend: (negotiationId, nowMs, thresholdVersion) =>
      strategies.canSpend({ kind: GOODS_BUYER, negotiationId, nowMs, thresholdVersion }).ok,
    charge: (negotiationId, nowMs, thresholdVersion) =>
      strategies.charge({ kind: GOODS_BUYER, negotiationId, count: 1, nowMs, thresholdVersion }).ok,
    turns: new StrategyTurnStore(identityDB),
    submit: submitMove,
    brainModel: () => {
      try {
        return new ValueModelStore(identityDB).loadForBrain(GOODS_BUYER);
      } catch {
        return null;
      }
    },
    nowMs: Date.now,
  });
  // COMMITMENT_KERNEL §15 step 8 — evidence and each relationship's consent.
  installEvidenceStore(identityDB);

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
  // COMMITMENT_KERNEL §7 — value-model entries this persona holds are read
  // from its own file, and only while the persona is open.
  setCommitmentPersonaDB(persona, personaDB);
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
