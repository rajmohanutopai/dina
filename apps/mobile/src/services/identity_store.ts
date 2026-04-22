/**
 * Home-node identity persistence — load/save Ed25519 signing + secp256k1
 * rotation seeds in the platform keychain (iOS Keychain / Android Keystore).
 *
 * This is the phone-side companion to `ensureNodeIdentity` (brain): the
 * keys persist across app launches so the DID stays stable; regenerating
 * them would mint a new did:plc and orphan the PDS account.
 *
 * Each seed is stored as a hex string because `react-native-keychain` is
 * string-only. Hex (not base64) keeps debug inspection trivial and
 * avoids any url-safe padding concerns.
 */

import * as Keychain from 'react-native-keychain';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from '@noble/ciphers/utils.js';

export interface NodeIdentitySeeds {
  signingSeed: Uint8Array;
  rotationSeed: Uint8Array;
}

/** Keychain service identifiers — one row per seed. */
const SERVICE_SIGNING = 'dina.node_identity.signing';
const SERVICE_ROTATION = 'dina.node_identity.rotation';

/** Username used for the keychain rows — opaque tag. */
const USERNAME = 'dina_node';

/**
 * Load existing seeds from the keychain. Returns null when either row is
 * missing — callers should treat that as "first run, generate new seeds".
 *
 * When ONE seed is present but not the other, we return null too (rather
 * than half-seeds) and let the caller regenerate both. A partial state
 * only arises from a bug or an interrupted write; fully regenerating is
 * safer than trying to patch.
 */
export async function loadIdentitySeeds(): Promise<NodeIdentitySeeds | null> {
  const [signingRow, rotationRow] = await Promise.all([
    Keychain.getGenericPassword({ service: SERVICE_SIGNING }),
    Keychain.getGenericPassword({ service: SERVICE_ROTATION }),
  ]);
  if (!signingRow || !rotationRow) return null;
  const signingSeed = safeHexToBytes(signingRow.password);
  const rotationSeed = safeHexToBytes(rotationRow.password);
  if (signingSeed === null || rotationSeed === null) return null;
  if (signingSeed.length !== 32 || rotationSeed.length !== 32) return null;
  return { signingSeed, rotationSeed };
}

/** Persist seeds to the keychain. Both rows are written. */
export async function saveIdentitySeeds(seeds: NodeIdentitySeeds): Promise<void> {
  if (seeds.signingSeed.length !== 32) {
    throw new Error('saveIdentitySeeds: signingSeed must be 32 bytes');
  }
  if (seeds.rotationSeed.length !== 32) {
    throw new Error('saveIdentitySeeds: rotationSeed must be 32 bytes');
  }
  await Promise.all([
    Keychain.setGenericPassword(USERNAME, bytesToHex(seeds.signingSeed), {
      service: SERVICE_SIGNING,
    }),
    Keychain.setGenericPassword(USERNAME, bytesToHex(seeds.rotationSeed), {
      service: SERVICE_ROTATION,
    }),
  ]);
}

/**
 * Remove seeds from the keychain — identity reset. Callers are
 * responsible for any downstream cleanup (revoking the PDS account,
 * rotating the did:plc, etc.) BEFORE invoking this.
 */
export async function clearIdentitySeeds(): Promise<void> {
  await Promise.all([
    Keychain.resetGenericPassword({ service: SERVICE_SIGNING }),
    Keychain.resetGenericPassword({ service: SERVICE_ROTATION }),
  ]);
}

/**
 * Load-or-generate seeds. Returns the existing pair when both rows are
 * present, or freshly-generated seeds (saved) otherwise. The `generated`
 * flag tells the caller whether they need to run the full PDS/PLC
 * bootstrap (new DID) or can skip straight to `createSession`.
 */
export async function loadOrGenerateSeeds(): Promise<{
  seeds: NodeIdentitySeeds;
  generated: boolean;
}> {
  const existing = await loadIdentitySeeds();
  if (existing !== null) return { seeds: existing, generated: false };
  const fresh: NodeIdentitySeeds = {
    signingSeed: randomBytes(32),
    rotationSeed: randomBytes(32),
  };
  await saveIdentitySeeds(fresh);
  return { seeds: fresh, generated: true };
}

function safeHexToBytes(s: string): Uint8Array | null {
  try {
    return hexToBytes(s);
  } catch {
    return null;
  }
}
