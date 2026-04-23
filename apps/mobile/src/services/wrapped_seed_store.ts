/**
 * Wrapped-seed persistence — remembers the user's Argon2id-wrapped master
 * seed across app launches so the unlock screen has something to unwrap.
 *
 * The node's Ed25519 signing + secp256k1 rotation seeds live in
 * `identity_store.ts` (their own Keychain rows). The WRAPPED MASTER seed
 * stored here is the passphrase-gated content-encryption root — it only
 * exists once the user has set a passphrase in onboarding.
 *
 * Storage: react-native-keychain, its own service name so clearing node
 * identity and clearing the vault lock can happen independently. The
 * record is JSON with hex-encoded byte arrays — Keychain is string-only.
 *
 * A load failure (corrupt JSON, missing fields, wrong lengths) surfaces
 * as `null` rather than an exception: the gate screen treats `null` as
 * "no identity yet, run onboarding" and a corrupt record would otherwise
 * trap the user forever.
 */

import * as Keychain from 'react-native-keychain';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { WrappedSeed } from '@dina/core/src/crypto/aesgcm';

const SERVICE = 'dina.vault.wrapped_seed';
const USERNAME = 'dina_vault';

interface SerializedWrappedSeed {
  saltHex: string;
  wrappedHex: string;
  params: {
    memory: number;
    iterations: number;
    parallelism: number;
  };
  /** Schema version — bump if the wire format changes. */
  v: 1;
}

export async function saveWrappedSeed(seed: WrappedSeed): Promise<void> {
  const record: SerializedWrappedSeed = {
    v: 1,
    saltHex: bytesToHex(seed.salt),
    wrappedHex: bytesToHex(seed.wrapped),
    params: { ...seed.params },
  };
  await Keychain.setGenericPassword(USERNAME, JSON.stringify(record), {
    service: SERVICE,
  });
}

export async function loadWrappedSeed(): Promise<WrappedSeed | null> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  if (!row) return null;
  return parseRecord(row.password);
}

export async function hasWrappedSeed(): Promise<boolean> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  return row !== false && row !== null;
}

export async function clearWrappedSeed(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}

function parseRecord(raw: string): WrappedSeed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const r = parsed as Partial<SerializedWrappedSeed>;
  if (r.v !== 1) return null;
  if (typeof r.saltHex !== 'string' || typeof r.wrappedHex !== 'string') return null;
  if (r.params === undefined || typeof r.params !== 'object') return null;
  const { memory, iterations, parallelism } = r.params;
  if (
    typeof memory !== 'number' ||
    typeof iterations !== 'number' ||
    typeof parallelism !== 'number'
  ) {
    return null;
  }
  const salt = safeHex(r.saltHex);
  const wrapped = safeHex(r.wrappedHex);
  if (salt === null || wrapped === null) return null;
  if (salt.length !== 16) return null;
  // `wrapped` is nonce(12) + ciphertext + GCM tag(16). A 32-byte master
  // seed wrapping produces exactly 60 bytes; reject anything obviously
  // truncated so a corrupt row becomes "no seed" rather than a Keychain
  // hex blob that unwrapSeed will choke on later.
  if (wrapped.length < 12 + 16 + 1) return null;
  return {
    salt,
    wrapped,
    params: { memory, iterations, parallelism },
  };
}

function safeHex(s: string): Uint8Array | null {
  try {
    return hexToBytes(s);
  } catch {
    return null;
  }
}
