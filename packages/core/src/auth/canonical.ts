/**
 * Request signing — canonical payload construction and Ed25519 signing.
 *
 * Canonical payload format (from core/internal/middleware/auth.go):
 *   {METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}
 *
 * Timestamp: RFC3339 (e.g., "2026-04-09T12:00:00Z")
 * Nonce: random hex string
 * Signature: hex-encoded Ed25519 signature
 *
 * Source: core/internal/middleware/auth.go
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { buildCanonicalPayload as protocolBuildCanonicalPayload } from '@dina/protocol';
import { sign, verify } from '../crypto/ed25519';
import { toRFC3339 } from './timestamp';

/**
 * Build the canonical string for Ed25519 request signing.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - URL path (e.g., "/v1/vault/query")
 * @param query - Query string without leading ? (e.g., "limit=10"), empty string if none
 * @param timestamp - RFC3339 timestamp (e.g., "2026-04-09T12:00:00Z")
 * @param nonce - Random hex string for replay protection
 * @param body - Raw request body bytes (empty Uint8Array for GET)
 * @returns The canonical string to sign
 */
export function buildCanonicalPayload(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): string {
  // Delegate the string assembly to @dina/protocol's pure helper; core
  // keeps the raw-bytes overload for in-process callers that don't want
  // to hash twice. Protocol's helper is crypto-backend-free by design.
  return protocolBuildCanonicalPayload(method, path, query, timestamp, nonce, sha256Hex(body));
}

/**
 * Compute SHA-256 hex digest of a byte array.
 * Used as the body hash component of the canonical payload.
 */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/**
 * Sign a request and return the four auth headers.
 *
 * @returns Headers: X-DID, X-Timestamp, X-Nonce, X-Signature
 */
export function signRequest(
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  privateKey: Uint8Array,
  did: string,
): { 'X-DID': string; 'X-Timestamp': string; 'X-Nonce': string; 'X-Signature': string } {
  const timestamp = toRFC3339(new Date());
  const nonce = bytesToHex(randomBytes(16));
  const canonical = buildCanonicalPayload(method, path, query, timestamp, nonce, body);
  const signature = sign(privateKey, new TextEncoder().encode(canonical));

  return {
    'X-DID': did,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': bytesToHex(signature),
  };
}

/**
 * Verify a signed request.
 *
 * @param publicKey - Ed25519 public key of the claimed signer
 * @returns true if signature is valid for the canonical payload
 */
export function verifyRequest(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  const canonical = buildCanonicalPayload(method, path, query, timestamp, nonce, body);
  const signature = nobleHexToBytes(signatureHex);
  return verify(publicKey, new TextEncoder().encode(canonical), signature);
}
