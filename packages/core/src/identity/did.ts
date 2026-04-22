/**
 * DID generation from Ed25519 key material.
 *
 * Format: did:key:z{base58btc(0xed01 + raw_32byte_pubkey)}
 *
 * - "z" prefix = multibase indicator for base58btc
 * - 0xed01 = multicodec varint for Ed25519 public key
 * - The 34-byte payload (2 multicodec + 32 key) is base58btc encoded
 *
 * Ed25519 did:key identifiers always start with "did:key:z6Mk".
 *
 * Source: W3C did:key spec, core/internal/adapter/identity/did.go
 */

import { base58 } from '@scure/base';
import { ED25519_PUBLIC_KEY_BYTES, ED25519_MULTICODEC as ED_MULTICODEC } from '../constants';

/** Multicodec varint prefix for Ed25519 public key (from shared constants). */
const ED25519_MULTICODEC = ED_MULTICODEC;

/**
 * Derive a did:key identifier from an Ed25519 public key.
 *
 * @param publicKey - 32-byte Ed25519 public key
 * @returns did:key:z6Mk... string
 */
export function deriveDIDKey(publicKey: Uint8Array): string {
  if (!publicKey || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('did: public key must be exactly 32 bytes');
  }
  const multibase = publicKeyToMultibase(publicKey);
  return `did:key:${multibase}`;
}

/**
 * Extract the raw Ed25519 public key from a did:key identifier.
 *
 * @param did - did:key:z6Mk... string
 * @returns 32-byte Ed25519 public key
 * @throws if DID format is invalid
 */
export function extractPublicKey(did: string): Uint8Array {
  if (!did || !did.startsWith('did:key:z')) {
    throw new Error('did: invalid format — must start with "did:key:z"');
  }
  const multibase = did.slice('did:key:'.length);
  return multibaseToPublicKey(multibase);
}

/**
 * Encode a public key as multibase (z-prefixed base58btc).
 *
 * Format: "z" + base58btc(0xed01 + 32-byte-pubkey)
 *
 * @param publicKey - 32-byte Ed25519 public key
 * @returns z-prefixed multibase string (e.g., "z6Mk...")
 */
export function publicKeyToMultibase(publicKey: Uint8Array): string {
  if (!publicKey || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('did: public key must be exactly 32 bytes');
  }
  // Prepend multicodec prefix
  const payload = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  payload.set(ED25519_MULTICODEC, 0);
  payload.set(publicKey, ED25519_MULTICODEC.length);

  return 'z' + base58.encode(payload);
}

/**
 * Decode a multibase string to raw Ed25519 public key.
 *
 * @param multibase - z-prefixed base58btc string
 * @returns 32-byte Ed25519 public key (strips 0xed01 multicodec prefix)
 */
export function multibaseToPublicKey(multibase: string): Uint8Array {
  if (!multibase || multibase[0] !== 'z') {
    throw new Error('did: multibase must start with "z" (base58btc)');
  }

  const decoded = base58.decode(multibase.slice(1));

  // Verify multicodec prefix
  if (decoded.length < ED25519_MULTICODEC.length) {
    throw new Error('did: decoded multibase too short');
  }
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new Error('did: invalid multicodec prefix — expected 0xed01 (Ed25519)');
  }

  const publicKey = decoded.slice(ED25519_MULTICODEC.length);
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`did: decoded public key is ${publicKey.length} bytes, expected 32`);
  }

  return publicKey;
}
