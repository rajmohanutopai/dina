/**
 * Task 4.41 — MsgBox WS client: inbound-RPC pipeline orchestrator.
 *
 * When a sealed `CoreRPCRequest` arrives from the MsgBox relay, the
 * WS client handler glues the existing primitives together:
 *
 *   1. `unsealInboundRpc` (task 4.45) — decrypt + shape-validate.
 *   2. `IdempotencyCache.lookup` (task 4.49) — return the cached
 *      response if we've seen this request_id from this sender
 *      within the 5-minute window.
 *   3. `CancelRegistry.register` (task 4.48) — AbortController for
 *      this in-flight request.
 *   4. `dispatchTunneledRequest` (task 4.46) — run through Fastify's
 *      full middleware chain (auth + rate limit + body limit + routes).
 *   5. `sealOutboundRpc` (task 4.47) — sign + seal the response for
 *      the sender.
 *   6. `IdempotencyCache.recordResponse` — store for replay-window.
 *   7. `CancelRegistry.unregister` — clear the in-flight entry.
 *
 * This module is the orchestration: a single entry point
 * `handleInboundRpc(frame, context)` that every inbound sealed blob
 * flows through. The actual WebSocket / auth-handshake / reconnect
 * flow wraps this function — keeping the pipeline itself pure +
 * testable with mocks.
 *
 * **Why slice 4.41 this way**: the auth handshake (4.42/4.43), the
 * reconnect policy (4.44), and the recovery-on-disconnect (4.50)
 * are already done. The sole remaining integration is the "one
 * tunnelled request, end-to-end" pipeline. Packaging it here as a
 * pure function lets the outer WS loop trivially drive it.
 *
 * **Error handling**: any step failing produces a SEALED error
 * response (when the request was decodable enough to emit one), or
 * `null` (when the sealed blob itself was unusable — no recipient
 * identity to seal back to). Never throws.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.41.
 */

import type { CancelRegistry } from './cancel_registry';
import type { IdempotencyCache } from './idempotency_cache';
import type { DispatchAppShape } from './dispatch_pipeline';
import { dispatchTunneledRequest } from './dispatch_pipeline';
import { unsealInboundRpc } from './rpc_inbound';
import { sealOutboundRpc } from './rpc_outbound';

export interface InboundRpcContext {
  /** This Core's DID — emitted as `from` on the sealed response. */
  coreDid: string;
  /** This Core's 32-byte Ed25519 private key (for response signing). */
  corePrivateKey: Uint8Array;
  /** This Core's 32-byte Ed25519 public key (used by `unsealInboundRpc`). */
  corePublicKey: Uint8Array;
  /**
   * Function that returns the sender's 32-byte Ed25519 public key
   * given the sender's DID. The outer WS loop knows how to resolve
   * this (usually via a DID document lookup or a pre-paired peer
   * registry). Returns `null` when the sender is unknown — we drop
   * the frame in that case.
   */
  resolveSenderPubkey: (senderDid: string) => Uint8Array | null;
  /** Fastify app for the dispatch chain. */
  app: DispatchAppShape;
  /** Idempotency cache (task 4.49). */
  idempotency: IdempotencyCache;
  /** Cancel registry (task 4.48). */
  cancels: CancelRegistry;
  /** Optional diagnostic hook. Fires at each pipeline stage. */
  onEvent?: (event: InboundRpcEvent) => void;
}

export type InboundRpcEvent =
  | { kind: 'unseal_failed'; reason: string; detail?: string }
  | {
      kind: 'sender_unknown';
      senderDid: string;
    }
  | {
      kind: 'idempotency_hit';
      senderDid: string;
      requestId: string;
    }
  | {
      kind: 'dispatched';
      senderDid: string;
      requestId: string;
      status: number;
    }
  | {
      kind: 'completed';
      senderDid: string;
      requestId: string;
      status: number;
    }
  | {
      kind: 'aborted';
      senderDid: string;
      requestId: string;
    };

export interface InboundRpcResult {
  /** Sealed bytes the caller should write back on the WS. */
  sealed: Uint8Array;
}

/**
 * Drive one inbound sealed RPC through the full pipeline.
 *
 * Returns the sealed response bytes to send back on the wire, or
 * `null` when no response is emittable (sender unknown, sealed blob
 * undecodable, etc.). A pipeline error that COULD produce a response
 * (e.g. handler 500) produces a sealed 500 — we only return null
 * when we don't have the identity needed to seal one.
 */
export async function handleInboundRpc(
  sealed: Uint8Array,
  context: InboundRpcContext,
): Promise<InboundRpcResult | null> {
  // Step 1: unseal.
  const unsealed = unsealInboundRpc({
    sealed,
    recipientEd25519Pub: context.corePublicKey,
    recipientEd25519Priv: context.corePrivateKey,
  });
  if (!unsealed.ok) {
    const event: Extract<InboundRpcEvent, { kind: 'unseal_failed' }> = {
      kind: 'unseal_failed',
      reason: unsealed.reason,
    };
    if (unsealed.detail !== undefined) event.detail = unsealed.detail;
    context.onEvent?.(event);
    return null;
  }
  const request = unsealed.request;
  const senderDid = request.from;
  const requestId = request.request_id;

  // Step 2: resolve sender's pubkey so we know where to seal the response.
  const senderPub = context.resolveSenderPubkey(senderDid);
  if (senderPub === null) {
    context.onEvent?.({ kind: 'sender_unknown', senderDid });
    return null;
  }

  // Step 3: idempotency lookup.
  const cached = context.idempotency.lookup(senderDid, requestId);
  if (cached !== null) {
    context.onEvent?.({ kind: 'idempotency_hit', senderDid, requestId });
    // Re-seal the cached response. Produces different ciphertext every
    // call (fresh ephemeral per seal) but the plaintext is identical.
    const { sealed: reSealedBytes } = sealOutboundRpc({
      requestId,
      status: cached.status,
      headers: cached.headers,
      body: cached.body,
      coreDid: context.coreDid,
      corePrivateKey: context.corePrivateKey,
      senderEd25519Pub: senderPub,
    });
    return { sealed: reSealedBytes };
  }

  // Step 4: register a cancel token + dispatch.
  const { signal, unregister } = context.cancels.register(senderDid, requestId);

  let dispatchResult;
  try {
    dispatchResult = await dispatchTunneledRequest({
      app: context.app,
      request,
      coreDid: context.coreDid,
    });
  } finally {
    unregister();
  }

  // If the caller aborted mid-dispatch, the signal reports it; we
  // still emit a response (Fastify's response is already produced)
  // but surface the event for observability.
  if (signal.aborted) {
    context.onEvent?.({ kind: 'aborted', senderDid, requestId });
  }

  context.onEvent?.({
    kind: 'dispatched',
    senderDid,
    requestId,
    status: dispatchResult.status,
  });

  // Step 5: seal the response.
  const { sealed: sealedResponseBytes, response } = sealOutboundRpc({
    requestId,
    status: dispatchResult.status,
    headers: dispatchResult.headers,
    body: dispatchResult.body,
    coreDid: context.coreDid,
    corePrivateKey: context.corePrivateKey,
    senderEd25519Pub: senderPub,
  });

  // Step 6: record for idempotency — use the structured response (not
  // the sealed bytes) so re-delivery can re-seal with a fresh
  // ephemeral instead of replaying identical ciphertext.
  context.idempotency.recordResponse(senderDid, requestId, response);

  context.onEvent?.({
    kind: 'completed',
    senderDid,
    requestId,
    status: dispatchResult.status,
  });

  return { sealed: sealedResponseBytes };
}
