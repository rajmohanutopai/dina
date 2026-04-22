/**
 * Verdict/content signing — sign arbitrary content with Ed25519 identity.
 *
 * Used for: attestation signing, verdict signing, content authentication.
 * Matches the Python tests/test_signing.py canonicalization and verification.
 *
 * Canonical JSON: sorted keys recursively, compact separators, signature
 * fields excluded before hashing.
 *
 * Source: tests/test_signing.py
 */

import { sign, verify } from '../crypto/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Canonicalize a JSON-serializable object for signing.
 *
 * Rules:
 * 1. Exclude specified fields (e.g., signature_hex, signer_did)
 * 2. Sort keys alphabetically (recursively for nested objects)
 * 3. Compact separators: no whitespace after : or ,
 *
 * @param obj - Object to canonicalize
 * @param excludeFields - Field names to exclude before canonicalization
 * @returns Deterministic JSON string
 */
export function canonicalize(obj: Record<string, unknown>, excludeFields?: string[]): string {
  const filtered = excludeFields ? filterFields(obj, new Set(excludeFields)) : obj;

  return JSON.stringify(sortKeys(filtered));
}

/**
 * Sign canonical JSON with Ed25519. Returns hex-encoded signature.
 *
 * @param canonical - Canonical JSON string to sign
 * @param privateKey - 32-byte Ed25519 private key
 * @returns 128-character hex string (64-byte Ed25519 signature)
 */
export function signCanonical(canonical: string, privateKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonical);
  const signature = sign(privateKey, message);
  return bytesToHex(signature);
}

/**
 * Verify a signature against canonical JSON and a public key.
 *
 * @param canonical - Canonical JSON string that was signed
 * @param signatureHex - Hex-encoded Ed25519 signature
 * @param publicKey - 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyCanonical(
  canonical: string,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  if (!signatureHex || signatureHex.length !== 128 || !/^[0-9a-f]+$/i.test(signatureHex)) {
    return false;
  }

  const message = new TextEncoder().encode(canonical);
  const signature = hexToBytes(signatureHex);

  try {
    return verify(publicKey, message, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/**
 * Recursively sort all object keys alphabetically.
 * Arrays are preserved in order; nested objects are sorted recursively.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Remove specified fields from an object (shallow — top-level only).
 */
function filterFields(obj: Record<string, unknown>, exclude: Set<string>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!exclude.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
