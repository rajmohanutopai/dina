/**
 * Full unlock flow — cold-start sequence from passphrase to ready state.
 *
 * Pipeline:
 *   1. Unwrap master seed (Argon2id + AES-256-GCM)
 *   2. Derive root signing key (SLIP-0010 m/9999'/0'/0')
 *   3. Derive DID (did:key from root public key)
 *   4. Initialize key rotation manager
 *   5. Open all default + standard personas (auto-boot)
 *   6. Mark secrets as restored (lifecycle state)
 *   7. Return unlock result
 *
 * This is the keystone integration: crypto → identity → personas → ready.
 *
 * Source: ARCHITECTURE.md Task 1.52
 */

import { unwrapSeed, type WrappedSeed } from '../crypto/aesgcm';
import { deriveRootSigningKey } from '../crypto/slip0010';
import { deriveDIDKey } from '../identity/did';
import { initializeRotation } from '../identity/rotation';
import {
  createPersona,
  openBootPersonas,
  listPersonas,
  resetPersonaState,
} from '../persona/service';
import { markSecretsRestored } from './sleep_wake';

export interface UnlockResult {
  did: string;
  personasOpened: string[];
  totalPersonas: number;
  unlockTimeMs: number;
}

export interface UnlockInput {
  passphrase: string;
  wrappedSeed: WrappedSeed;
  personas?: Array<{ name: string; tier: 'default' | 'standard' | 'sensitive' | 'locked' }>;
}

/**
 * Run the full unlock flow.
 *
 * Throws on wrong passphrase (GCM tag mismatch from unwrapSeed).
 */
export async function fullUnlock(input: UnlockInput): Promise<UnlockResult> {
  const startTime = Date.now();

  // 1. Unwrap master seed
  const masterSeed = await unwrapSeed(input.passphrase, input.wrappedSeed);

  // 2. Derive root signing key
  const rootKey = deriveRootSigningKey(masterSeed, 0);

  // 3. Derive DID
  const did = deriveDIDKey(rootKey.publicKey);

  // 4. Initialize key rotation
  initializeRotation(masterSeed);

  // 5. Register personas (if provided) and open boot personas
  if (input.personas) {
    for (const p of input.personas) {
      try {
        createPersona(p.name, p.tier);
      } catch {
        // Already exists — skip (idempotent on re-unlock)
      }
    }
  }

  const personasOpened = openBootPersonas();

  // 6. Mark secrets restored
  markSecretsRestored();

  // 7. Return result
  return {
    did,
    personasOpened,
    totalPersonas: listPersonas().length,
    unlockTimeMs: Date.now() - startTime,
  };
}

/**
 * Quick check: can the passphrase decrypt the wrapped seed?
 *
 * Useful for "verify passphrase" before running the full unlock.
 * Does NOT modify any state.
 */
export async function verifyPassphrase(
  passphrase: string,
  wrappedSeed: WrappedSeed,
): Promise<boolean> {
  try {
    await unwrapSeed(passphrase, wrappedSeed);
    return true;
  } catch {
    return false;
  }
}
