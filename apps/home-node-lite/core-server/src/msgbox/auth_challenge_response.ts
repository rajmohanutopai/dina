/**
 * Task 4.42 — Ed25519 challenge-response for MsgBox WebSocket auth.
 *
 * When Core connects to its MsgBox relay over WebSocket, the relay
 * sends an `auth_challenge` frame immediately on open. Core must
 * reply with an `auth_response` containing a signature over the
 * canonical challenge payload, proving it controls the Ed25519
 * private key for its DID. The relay verifies + sends `auth_success`
 * (task 4.43 wires the strict-wait timeout).
 *
 * **Canonical payload** (pinned in `@dina/protocol`):
 *   `"AUTH_RELAY\n{nonce}\n{ts}"`
 *
 * The nonce is hex from the challenge frame; `ts` is the Unix
 * SECONDS (not milliseconds — relay uses seconds per the wire shape
 * in `msgbox_ws.ts`). Any change to this payload breaks every Dina
 * client on the wire, so it's deliberately simple + stable.
 *
 * **Timestamp window**: the server enforces its own freshness check
 * using `ts`, but our sign-side just uses whatever the challenge
 * declared — we don't reject an old challenge before signing. The
 * server's rejection surfaces as `auth_success` never arriving
 * (→ task 4.43's timeout).
 *
 * **Why a separate module** from `pairing_identity_binding.ts` (task
 * 4.27): pairing is a peer-to-peer identity self-binding BEFORE the
 * Home Node has any allowlist; MsgBox auth is a point-to-point WS
 * handshake with a trusted relay, AFTER the Home Node already has
 * its signing key. Different trust model, different threat surface.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.42.
 */

import { sign as ed25519Sign } from '@dina/core';
import type {
  AuthChallengeFrame,
  AuthResponseFrame,
} from '@dina/protocol';
import { AUTH_RESPONSE } from '@dina/protocol';

/** Prefix pinned per `packages/protocol/src/types/auth_frames.ts`. */
export const AUTH_RELAY_PREFIX = 'AUTH_RELAY';

export interface BuildAuthResponseInput {
  /** The challenge frame the relay sent on open. */
  challenge: AuthChallengeFrame;
  /** Home Node's DID (what it's authenticating as). */
  did: string;
  /** Ed25519 private key (32-byte seed) matching the DID's signing key. */
  privateKey: Uint8Array;
  /** Ed25519 public key (32 bytes) matching the DID's signing key. */
  publicKey: Uint8Array;
}

/**
 * Sign the canonical AUTH_RELAY payload with the supplied Ed25519
 * keypair and produce the `auth_response` frame the WebSocket client
 * ships back to MsgBox.
 *
 * Fully pure — no I/O, no clock. The challenge's `nonce` + `ts` are
 * authoritative; we don't recompute either.
 */
export function buildAuthResponse(input: BuildAuthResponseInput): AuthResponseFrame {
  if (!input.challenge || input.challenge.type !== 'auth_challenge') {
    throw new Error(
      `buildAuthResponse: challenge.type must be "auth_challenge" (got ${JSON.stringify(input.challenge?.type)})`,
    );
  }
  if (!input.challenge.nonce || input.challenge.nonce.length === 0) {
    throw new Error('buildAuthResponse: challenge.nonce is required');
  }
  if (typeof input.challenge.ts !== 'number' || !Number.isFinite(input.challenge.ts)) {
    throw new Error(
      `buildAuthResponse: challenge.ts must be a finite number (got ${input.challenge.ts})`,
    );
  }
  if (!input.did) throw new Error('buildAuthResponse: did is required');
  if (!input.privateKey || input.privateKey.length !== 32) {
    throw new Error('buildAuthResponse: privateKey must be 32 bytes (Ed25519 seed)');
  }
  if (!input.publicKey || input.publicKey.length !== 32) {
    throw new Error('buildAuthResponse: publicKey must be 32 bytes (Ed25519 public key)');
  }

  const payload = buildAuthRelayPayload(input.challenge.nonce, input.challenge.ts);
  const payloadBytes = new TextEncoder().encode(payload);
  // `@dina/core.sign` takes (privateKey, message) — not (message, privateKey).
  const signature = ed25519Sign(input.privateKey, payloadBytes);

  return {
    type: AUTH_RESPONSE,
    did: input.did,
    sig: bytesToHex(signature),
    pub: bytesToHex(input.publicKey),
  };
}

/**
 * Build the canonical AUTH_RELAY payload. Exported so callers +
 * cross-runtime consumers can reproduce the byte-exact input Dina
 * clients sign.
 */
export function buildAuthRelayPayload(nonce: string, ts: number): string {
  return `${AUTH_RELAY_PREFIX}\n${nonce}\n${ts}`;
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
