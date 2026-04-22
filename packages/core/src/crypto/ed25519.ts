/**
 * Ed25519 signing and verification.
 *
 * Uses @noble/ed25519 — audited, pure JS, no native dependency.
 * All operations are synchronous (no async needed for Ed25519).
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// @noble/ed25519 v3+ requires explicit SHA-512 hash configuration.
// The `hashes` object is untyped but is the library's designated config point.
const edHashes = ed.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
edHashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

/** Sign a message with an Ed25519 private key (32-byte seed). Returns 64-byte signature. */
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed.sign(message, privateKey);
}

/** Verify an Ed25519 signature against a public key. */
export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return ed.verify(signature, message, publicKey);
}

/** Derive the 32-byte public key from a 32-byte private key (seed). */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKey);
}
