/**
 * Key rotation manager — generation-based Ed25519 key lifecycle.
 *
 * Each rotation increments the signing generation:
 *   gen 0: m/9999'/0'/0' (initial root key)
 *   gen 1: m/9999'/0'/1' (first rotation)
 *   gen N: m/9999'/0'/N'
 *
 * Old public keys are kept in the verification list so that
 * messages signed with prior generations remain verifiable.
 * This maps to the DID document's multiple verification methods.
 *
 * Source: ARCHITECTURE.md Section 10.1 (key rotation)
 */

import { deriveRootSigningKey } from '../crypto/slip0010';
import { sign, verify } from '../crypto/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface KeyGeneration {
  generation: number;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

/** Current signing generation. */
let currentGeneration = 0;

/** Master seed used for derivation. */
let masterSeed: Uint8Array | null = null;

/** History of all public keys (current + all rotated). Oldest first. */
const keyHistory: KeyGeneration[] = [];

/**
 * Initialize the rotation manager with a master seed.
 *
 * Derives the initial root signing key (generation 0) and records it.
 * Must be called before any signing or rotation operations.
 */
export function initializeRotation(seed: Uint8Array): KeyGeneration {
  masterSeed = seed;
  currentGeneration = 0;
  keyHistory.length = 0;

  const derived = deriveRootSigningKey(seed, 0);
  const entry: KeyGeneration = {
    generation: 0,
    publicKey: derived.publicKey,
    publicKeyHex: bytesToHex(derived.publicKey),
  };
  keyHistory.push(entry);
  return entry;
}

/**
 * Rotate to the next signing generation.
 *
 * Derives a new root key at generation N+1. The old public key
 * remains in keyHistory for signature verification.
 * Returns the new key generation info.
 */
export function rotateKey(): KeyGeneration {
  if (!masterSeed) throw new Error('rotation: not initialized — call initializeRotation first');

  currentGeneration += 1;
  const derived = deriveRootSigningKey(masterSeed, currentGeneration);
  const entry: KeyGeneration = {
    generation: currentGeneration,
    publicKey: derived.publicKey,
    publicKeyHex: bytesToHex(derived.publicKey),
  };
  keyHistory.push(entry);
  return entry;
}

/** Get the current signing generation number. */
export function getCurrentGeneration(): number {
  return currentGeneration;
}

/** Get the current (latest) public key. */
export function getCurrentPublicKey(): Uint8Array | null {
  if (keyHistory.length === 0) return null;
  return keyHistory[keyHistory.length - 1].publicKey;
}

/**
 * Get all verification public keys (current + all historical).
 *
 * Used to populate the DID document's verification methods.
 * Includes all generations from 0 to current.
 */
export function getAllVerificationKeys(): Uint8Array[] {
  return keyHistory.map((k) => k.publicKey);
}

/** Get the full key history with generation numbers. */
export function getKeyHistory(): KeyGeneration[] {
  return [...keyHistory];
}

/**
 * Sign data with the current generation's private key.
 *
 * Returns the hex-encoded signature.
 */
export function signWithCurrentKey(data: Uint8Array): string {
  if (!masterSeed) throw new Error('rotation: not initialized');
  const derived = deriveRootSigningKey(masterSeed, currentGeneration);
  return bytesToHex(sign(derived.privateKey, data));
}

/**
 * Verify a signature against ANY generation's public key.
 *
 * This is the key rotation invariant: old signatures remain verifiable
 * because all historical public keys are retained.
 */
export function verifyWithAnyKey(data: Uint8Array, signatureHex: string): boolean {
  if (signatureHex.length !== 128 || !/^[0-9a-f]+$/i.test(signatureHex)) return false;

  const sigBytes = new Uint8Array(signatureHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

  for (const entry of keyHistory) {
    try {
      if (verify(entry.publicKey, data, sigBytes)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Reset all rotation state (for testing). */
export function resetRotationState(): void {
  currentGeneration = 0;
  masterSeed = null;
  keyHistory.length = 0;
}
