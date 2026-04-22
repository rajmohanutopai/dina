/**
 * Identity record — the DID the home node publishes under.
 *
 * The signing + rotation seeds live in `identity_store`; those are the
 * Ed25519 / secp256k1 keypairs. This module is a separate concern: it
 * stores the *identifier* string the node uses. For demo / pre-onboarding
 * builds the record is absent and the caller derives a `did:key` locally;
 * once PDS onboarding lands it writes the `did:plc` here and the boot path
 * picks it up on the next launch — no did:plc-specific plumbing in the
 * hook.
 *
 * Persisting the DID separately from the seed lets the onboarding flow
 * swap `did:key` for `did:plc` without regenerating keys — the continuity
 * property the reviewer asked for (issue #3).
 */

import * as Keychain from 'react-native-keychain';

const SERVICE = 'dina.node_identity.did';
const USERNAME = 'dina_node_did';

/**
 * Load the persisted DID. Returns `null` when nothing has been stored yet
 * (first run, or onboarding not complete).
 */
export async function loadPersistedDid(): Promise<string | null> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  if (!row) return null;
  const trimmed = row.password.trim();
  if (trimmed === '') return null;
  return trimmed;
}

/**
 * Persist the DID. Onboarding calls this after PDS publishes the did:plc
 * document — the next boot cycle reads it via `loadPersistedDid()` so the
 * node never falls back to the did:key dev scaffold.
 */
export async function savePersistedDid(did: string): Promise<void> {
  if (!did || !did.startsWith('did:')) {
    throw new Error('savePersistedDid: DID must be a non-empty "did:…" string');
  }
  await Keychain.setGenericPassword(USERNAME, did, { service: SERVICE });
}

/** Clear the DID — used on identity reset. */
export async function clearPersistedDid(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
