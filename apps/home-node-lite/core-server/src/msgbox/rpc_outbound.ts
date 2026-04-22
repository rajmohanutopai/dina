/**
 * Task 4.47 — outbound response re-seal.
 *
 * Once the CoreRouter has produced a response for an inbound MsgBox
 * RPC (see task 4.46's dispatch pipeline), we need to:
 *
 *   1. Sign the response with Core's Ed25519 private key — the
 *      sender verifies that the response actually came from the
 *      recipient they asked, not a relay MITM.
 *   2. Seal the signed response with the **original sender's**
 *      Ed25519 pubkey (the RPC's `from` field). Only they can open
 *      it; the relay sees an opaque blob.
 *   3. Return the sealed bytes to the caller to ship over the WS.
 *
 * **Why sign then seal, not seal then sign**: the signature is
 * INSIDE the sealed envelope — relay operators can't strip it or
 * substitute a different signature without first compromising the
 * sender's private key (which would let them read the plaintext
 * anyway). Signing outside the seal leaks the response shape to
 * anyone with the public key.
 *
 * **Canonical signing payload** (pinned in @dina/core's
 * `buildResponseCanonical`): `"{request_id}\n{status}\n{body}"` —
 * binds the response to the SPECIFIC request_id so a relay can't
 * replay this response as an answer to a different request.
 *
 * Delegates the crypto to `@dina/core.buildSignedResponse` +
 * `sealRPCResponse`; this module is the orchestrator that
 * connects the CoreRouter's `CoreResponse` shape to the sealed
 * bytes that go over the WS.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.47.
 */

import {
  buildSignedResponse,
  sealRPCResponse,
  type CoreRPCResponse,
} from '@dina/core';

export interface SealOutboundRpcInput {
  /** Matches the inbound `request_id` — binds the response. */
  requestId: string;
  /** HTTP status from the CoreRouter response. */
  status: number;
  /** Response headers (may be empty). */
  headers: Record<string, string>;
  /** Response body, serialized to a string. */
  body: string;
  /** This Core's DID — embedded as the response's `from`. */
  coreDid: string;
  /** This Core's Ed25519 signing key. Used to sign the canonical payload. */
  corePrivateKey: Uint8Array;
  /**
   * Original sender's Ed25519 pubkey (from the inbound RPC's `from`).
   * The sealed envelope is addressed to this key — only the sender
   * can open it.
   */
  senderEd25519Pub: Uint8Array;
}

export interface SealOutboundRpcOutput {
  /** Sealed bytes — ship these over the MsgBox WS verbatim. */
  sealed: Uint8Array;
  /** The structured response (pre-seal) — useful for caching per task 4.49. */
  response: CoreRPCResponse;
}

/**
 * Sign + seal a Core response. Returns BOTH the sealed bytes (for
 * the wire) AND the pre-seal `CoreRPCResponse` (for the idempotency
 * cache: task 4.49 records the response so a re-delivery returns
 * the exact same bytes — the cache stores the structured response,
 * NOT the sealed bytes, because a re-seal would use a fresh
 * ephemeral key producing different ciphertext, which would be
 * fine for the receiver but wastes crypto cycles).
 */
export function sealOutboundRpc(input: SealOutboundRpcInput): SealOutboundRpcOutput {
  if (!input.requestId || input.requestId.length === 0) {
    throw new Error('sealOutboundRpc: requestId is required');
  }
  if (!Number.isInteger(input.status) || input.status < 100 || input.status >= 600) {
    throw new Error(
      `sealOutboundRpc: status must be a valid HTTP code 100..599 (got ${input.status})`,
    );
  }
  if (!input.coreDid) {
    throw new Error('sealOutboundRpc: coreDid is required');
  }
  if (input.corePrivateKey.length !== 32) {
    throw new Error(
      `sealOutboundRpc: corePrivateKey must be 32 bytes (got ${input.corePrivateKey.length})`,
    );
  }
  if (input.senderEd25519Pub.length !== 32) {
    throw new Error(
      `sealOutboundRpc: senderEd25519Pub must be 32 bytes (got ${input.senderEd25519Pub.length})`,
    );
  }

  const response = buildSignedResponse(
    input.requestId,
    input.status,
    input.headers,
    input.body,
    input.coreDid,
    input.corePrivateKey,
  );
  const sealed = sealRPCResponse(response, input.senderEd25519Pub);
  return { sealed, response };
}
