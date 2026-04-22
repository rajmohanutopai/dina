/**
 * Task 4.38 — NaCl sealed-box push envelope to device X25519 pub.
 *
 * When Core pushes a notification (Fiduciary / Solicited / Engagement
 * per the Silence First doctrine) to a paired device over its client
 * WebSocket, the payload is encrypted end-to-end with the device's
 * public key. Only the device's private key can decrypt. This
 * ensures:
 *
 *   - Relay operators (MsgBox) can't read push content — they see
 *     encrypted blobs addressed to opaque device ids.
 *   - The Home Node operator with filesystem access can't read past
 *     notifications by snooping the WebSocket buffer — the plaintext
 *     never leaves RAM in a form that isn't already on the device.
 *
 * **Sealed-box semantics (libsodium crypto_box_seal)**: the sender is
 * anonymous. An ephemeral keypair is generated per message; the
 * ephemeral pub is prepended to the ciphertext. Only the recipient
 * (who has the secret counterpart to `recipientEd25519Pub`) can open
 * it; even the ephemeral sender can't decrypt after the fact.
 *
 * **Why Ed25519 at the API, X25519 under the hood**: device pubkeys
 * are registered as Ed25519 (the signing key that matches the
 * device's DID). `@dina/core.sealEncrypt` converts internally via
 * `ed25519PubToX25519`, so the caller doesn't need to manage a
 * second keypair per device. Matches Go Core's convention.
 *
 * **Envelope wire shape** (JSON serialized over the WS):
 *   ```json
 *   {
 *     "type": "push_envelope",
 *     "v": 1,
 *     "to": "<device DID>",
 *     "sealed_hex": "<hex of: eph_pub(32) || ciphertext || MAC(16)>"
 *   }
 *   ```
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.38.
 */

import { sealEncrypt, sealDecrypt } from '@dina/core';

export const PUSH_ENVELOPE_TYPE = 'push_envelope';
export const PUSH_ENVELOPE_VERSION = 1;

export interface PushEnvelopeFrame {
  type: typeof PUSH_ENVELOPE_TYPE;
  v: typeof PUSH_ENVELOPE_VERSION;
  /** Recipient device DID (e.g. `did:key:z6Mkdevice`). */
  to: string;
  /** Hex-encoded sealed bytes: `eph_pub(32) || ciphertext || Poly1305 MAC(16)`. */
  sealed_hex: string;
}

export interface BuildPushEnvelopeInput {
  /** Recipient device DID. Carried in the envelope for routing. */
  recipientDid: string;
  /** Device's Ed25519 pubkey (32 bytes) — converted internally for X25519 ECDH. */
  recipientEd25519Pub: Uint8Array;
  /** Raw bytes to encrypt. Caller JSON.stringifys the higher-level message. */
  plaintext: Uint8Array;
}

/**
 * Construct a push-envelope frame. Pure — no state, no clock.
 * Same input → different output (ephemeral key is fresh per call)
 * so callers can send the same payload to multiple recipients
 * without reusing any key material across them.
 */
export function buildPushEnvelope(input: BuildPushEnvelopeInput): PushEnvelopeFrame {
  if (!input.recipientDid || input.recipientDid.length === 0) {
    throw new Error('buildPushEnvelope: recipientDid is required');
  }
  if (!input.recipientEd25519Pub || input.recipientEd25519Pub.length !== 32) {
    throw new Error(
      'buildPushEnvelope: recipientEd25519Pub must be 32 bytes (Ed25519 public key)',
    );
  }
  const sealed = sealEncrypt(input.plaintext, input.recipientEd25519Pub);
  return {
    type: PUSH_ENVELOPE_TYPE,
    v: PUSH_ENVELOPE_VERSION,
    to: input.recipientDid,
    sealed_hex: bytesToHex(sealed),
  };
}

/**
 * Open a push envelope. Used by the device side (CLI / mobile) — the
 * Home Node's Core never decrypts its own push envelopes; it just
 * emits them. Included here because tests need to verify round-trip.
 */
export function openPushEnvelope(
  frame: PushEnvelopeFrame,
  recipientEd25519Priv: Uint8Array,
  recipientEd25519Pub: Uint8Array,
): Uint8Array {
  if (frame.type !== PUSH_ENVELOPE_TYPE) {
    throw new Error(`openPushEnvelope: wrong frame type "${frame.type}"`);
  }
  if (frame.v !== PUSH_ENVELOPE_VERSION) {
    throw new Error(`openPushEnvelope: unsupported envelope version ${frame.v}`);
  }
  const sealed = hexToBytes(frame.sealed_hex);
  return sealDecrypt(sealed, recipientEd25519Pub, recipientEd25519Priv);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`non-hex char at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
