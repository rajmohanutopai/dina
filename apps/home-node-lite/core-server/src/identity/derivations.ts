/**
 * Task 4.54 — SLIP-0010 derivation orchestrator.
 * Task 4.55 — HKDF vault DEKs per persona.
 *
 * Given a master seed (from task 4.51's `loadOrGenerateSeed`), derive
 * all four key classes Dina's Home Node needs:
 *
 *   1. **Root signing key** — identity (m/9999'/0'/{gen}'). Signs the
 *      DID Document; rotated on compromise.
 *   2. **Persona signing keys** — per-persona Ed25519 messaging
 *      (m/9999'/1'/{idx}'/{gen}'). Signs DIDComm messages + Trust
 *      Network entries within that persona's compartment. Each
 *      persona has its own; crossing personas is impossible without
 *      the master seed.
 *   3. **Rotation key** — secp256k1 (m/9999'/2'/{gen}'). The `did:plc`
 *      recoveryKey handed to the community PDS; lets Dina sovereignly
 *      rotate the root signing key without PDS-admin intervention.
 *   4. **Service keys** — Core + Brain install-time auth keypairs
 *      (m/9999'/3'/{serviceIdx}'). Core signs requests outbound TO
 *      Brain, Brain TO Core, etc. Keys are install-time-only,
 *      load-only at runtime (fail-closed per CLAUDE.md).
 *
 * Separately from the signing tree, each persona gets a **vault DEK**
 * derived via HKDF-SHA256 — NOT SLIP-0010. Task 4.55 wraps
 * `@dina/core.derivePersonaDEK` for the orchestrator's ergonomics
 * (callers pass a persona name; the DEK is used as the SQLCipher
 * passphrase for that persona's `.sqlite` file).
 *
 * **Purity**: this module is deterministic + side-effect-free. Given
 * the same seed + inputs, always returns the same keys. Boot-time
 * derivation happens ONCE; the derived keys are then held in memory
 * for the process lifetime (cleared on SIGTERM via task 4.9 shutdown).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g tasks 4.54-4.55.
 */

import {
  deriveRootSigningKey,
  derivePersonaSigningKey,
  deriveRotationKey,
  deriveServiceKey,
  derivePersonaDEK,
  type DerivedKey,
} from '@dina/core';

/** Service indices per CLAUDE.md: Core = 0, Brain = 1. */
export const SERVICE_INDEX = Object.freeze({
  core: 0,
  brain: 1,
} as const);

/** Canonical persona indices per ARCHITECTURE.md §"Key Derivation". */
export const PERSONA_INDEX = Object.freeze({
  consumer: 0,
  professional: 1,
  social: 2,
  health: 3,
  financial: 4,
  citizen: 5,
  // User-defined personas get indices 6+ assigned at creation.
} as const);

/**
 * Bundle of keys the Home Node derives at boot. Held in memory for
 * the process lifetime; never persisted separately from the seed.
 */
export interface IdentityDerivations {
  /** Root identity key (signs the DID document). Current generation. */
  root: DerivedKey;
  /** Secp256k1 PLC rotation key (recoveryKey on the PDS). */
  rotation: DerivedKey;
  /** Core + Brain service keys for internal sidecar auth. */
  services: { core: DerivedKey; brain: DerivedKey };
  /**
   * Function to derive a persona signing key on demand. Personas are
   * unlocked lazily (see gatekeeper tiers), so we don't eagerly
   * derive all of them at boot — only compute when the persona is
   * touched.
   */
  derivePersona(personaIndex: number, generation?: number): DerivedKey;
  /** Same, for the persona's vault DEK (SQLCipher passphrase). */
  derivePersonaVaultDEK(personaName: string, userSalt: Uint8Array): Uint8Array;
}

export interface DeriveIdentityOptions {
  masterSeed: Uint8Array;
  /** Generation number for the root + rotation keys. Default 0. */
  generation?: number;
}

/**
 * Run the full derivation. Expensive (a handful of HMAC-SHA512 calls
 * + two secp256k1 scalar muls for rotation), but deterministic and
 * called once per process.
 */
export function deriveIdentity(opts: DeriveIdentityOptions): IdentityDerivations {
  const seed = opts.masterSeed;
  if (!seed || seed.length < 16) {
    throw new Error(
      `deriveIdentity: masterSeed must be at least 16 bytes, got ${seed?.length ?? 0}`,
    );
  }
  const generation = opts.generation ?? 0;

  const root = deriveRootSigningKey(seed, generation);
  const rotation = deriveRotationKey(seed, generation);
  const services = {
    core: deriveServiceKey(seed, SERVICE_INDEX.core),
    brain: deriveServiceKey(seed, SERVICE_INDEX.brain),
  };

  return {
    root,
    rotation,
    services,
    derivePersona(personaIndex: number, gen = generation): DerivedKey {
      if (!Number.isInteger(personaIndex) || personaIndex < 0) {
        throw new Error(
          `derivePersona: personaIndex must be a non-negative integer, got ${personaIndex}`,
        );
      }
      return derivePersonaSigningKey(seed, personaIndex, gen);
    },
    derivePersonaVaultDEK(personaName: string, userSalt: Uint8Array): Uint8Array {
      if (!personaName || personaName.length === 0) {
        throw new Error('derivePersonaVaultDEK: personaName is required');
      }
      // `@dina/core.derivePersonaDEK` uses the master seed directly as
      // the HKDF input keying material. Per ARCHITECTURE.md this is
      // NOT the SLIP-0010 signing tree — DEKs come from HKDF over the
      // raw seed with per-persona info strings (`dina:vault:<persona>:v1`).
      return derivePersonaDEK(seed, personaName, userSalt);
    },
  };
}
