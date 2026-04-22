/**
 * MsgBox auth-handshake wire frames.
 *
 * Three-step exchange between client and MsgBox relay on every new
 * WebSocket connection:
 *
 *   server → client   {type: "auth_challenge", nonce, ts}
 *   client → server   {type: "auth_response",  did, sig, pub}
 *   server → client   {type: "auth_success"}                 ← introduced in 0.14
 *
 * Strict `auth_success` behaviour documented in
 * `docs/designs/MSGBOX_TRANSPORT.md` (decision: fail-closed if frame
 * missing, rather than optimistic-success timeout fallback).
 *
 * The signed payload the client's Ed25519 signature commits to is:
 *   `"AUTH_RELAY\n{nonce}\n{ts}"`
 *
 * Source: extracted (as explicit type declarations) from the shape
 * parsed in `@dina/core/src/relay/msgbox_ws.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16d). The donor
 * file never declared these as TS interfaces — the wire shape was
 * implicit in the `msg.type === 'auth_challenge'` runtime branches.
 * Lifting them into the protocol package gives third-party
 * implementers a type contract to reference.
 *
 * Zero runtime deps — pure type declarations.
 */

import type { AUTH_CHALLENGE, AUTH_RESPONSE, AUTH_SUCCESS } from '../constants';

/**
 * Server-initiated challenge sent immediately on WebSocket open.
 * `nonce` is hex-encoded; `ts` is Unix seconds (number, not string).
 */
export interface AuthChallengeFrame {
  type: typeof AUTH_CHALLENGE;
  nonce: string;
  ts: number;
}

/**
 * Client response carrying the signed `"AUTH_RELAY\n{nonce}\n{ts}"`
 * payload + the public key the server should verify against.
 *
 * Fields:
 *   - `did`  — home-node `did:plc:...` or `did:key:...`
 *   - `sig`  — hex-encoded Ed25519 signature over the signed payload
 *   - `pub`  — hex-encoded Ed25519 public key (matches the DID's signing key)
 */
export interface AuthResponseFrame {
  type: typeof AUTH_RESPONSE;
  did: string;
  sig: string;
  pub: string;
}

/**
 * Server acknowledgment — relay verified the response and will deliver
 * buffered envelopes from here on. Introduced 0.14 (msgbox 0.14.0+ + Go
 * core 0.14+ + Python CLI 0.14). Pre-0.14 servers omit this frame and
 * stream envelopes directly — that transitional behaviour is no longer
 * supported (strict fail-closed).
 */
export interface AuthSuccessFrame {
  type: typeof AUTH_SUCCESS;
}

/** Discriminated union of all three handshake frame shapes. */
export type AuthFrame = AuthChallengeFrame | AuthResponseFrame | AuthSuccessFrame;

/**
 * Build the signed payload a client's Ed25519 sig commits to.
 * Included here (rather than in `canonical_sign.ts`) because this is
 * a separate wire format from HTTP request signing.
 *
 * Pure string concatenation; zero runtime deps.
 */
export function buildAuthSignedPayload(nonce: string, ts: number): string {
  return `AUTH_RELAY\n${nonce}\n${ts}`;
}
