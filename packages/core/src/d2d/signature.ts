/**
 * D2D message signature — Ed25519 sign/verify on plaintext JSON.
 *
 * Signs BEFORE encryption, verifies AFTER decryption.
 * Multi-key verification supports key rotation.
 *
 * Source: core/test/transport_d2d_sig_test.go
 */

import { sign, verify } from '../crypto/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
// Import from the neutral `wire.ts` so there's no runtime edge back
// into envelope.ts. Previously `./envelope` → `./signature` (for
// signMessage) AND `./signature` → `./envelope` (for buildMessage +
// DinaMessage), which Metro correctly flagged as a require cycle and
// Hermes will eventually fault on during module init.
import { buildMessage, type DinaMessage } from './wire';

/** Sign a DinaMessage. Returns hex signature over the same JSON bytes
 *  the Go peer signs (and the receiver verifies against).
 *
 *  `buildMessage` emits the canonical wire shape — field order matches
 *  Go's `DinaMessage` struct declaration (id, type, from, to,
 *  created_time, body), `to` is a string[], `body` is base64. Signing
 *  over this byte sequence gives a signature Go's `ed25519.Verify`
 *  accepts against the plaintext it reconstructs via `json.Marshal`.
 *
 *  Previously we used `canonicalize` (alphabetical key order), which
 *  produced a different byte sequence from Go's declaration-order
 *  marshal — every cross-platform signature failed with
 *  "transport: invalid signature".
 */
export function signMessage(message: DinaMessage, privateKey: Uint8Array): string {
  const canonical = buildMessage(message);
  return bytesToHex(sign(privateKey, new TextEncoder().encode(canonical)));
}

/** Verify against multiple keys (rotation support). True if ANY key matches. */
export function verifyMessage(
  message: DinaMessage,
  signatureHex: string,
  verificationKeys: Uint8Array[],
): boolean {
  if (!verificationKeys || verificationKeys.length === 0) return false;
  return verificationKeys.some((key) => verifyMessageSingle(message, signatureHex, key));
}

/** Verify against a single public key. */
export function verifyMessageSingle(
  message: DinaMessage,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  if (!signatureHex || signatureHex.length !== 128 || !/^[0-9a-f]+$/i.test(signatureHex))
    return false;
  try {
    const canonical = buildMessage(message);
    return verify(publicKey, new TextEncoder().encode(canonical), hexToBytes(signatureHex));
  } catch {
    return false;
  }
}
