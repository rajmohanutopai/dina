/**
 * Core RPC envelope — request/response payloads wrapped inside a NaCl
 * sealed-box for MsgBox relay transport.
 *
 * MsgBox sees only the opaque ciphertext; these types describe what
 * Core sees after unseal. The `inner` Ed25519 auth headers (X-DID,
 * X-Timestamp, X-Nonce, X-Signature) live on `headers` and are
 * verified against the canonical string built by
 * `buildCanonicalPayload()` from this package.
 *
 * Source: extracted from `@dina/core/src/relay/rpc_envelope.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16f).
 *
 * Zero runtime deps — pure type declarations.
 */

import type { RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE } from '../constants';

/**
 * Unsealed Core RPC request (after NaCl decrypt).
 * Carries the full HTTP-shaped request the Core handler will dispatch.
 */
export interface CoreRPCRequest {
  type: typeof RPC_REQUEST_TYPE;
  /** Caller-chosen unique id, used to match request → response. */
  request_id: string;
  /** Sender DID — the envelope's `from_did`, also used for auth binding. */
  from: string;
  method: string;
  /** URL path (e.g. `/v1/vault/query`). */
  path: string;
  /** Query string without leading `?` (empty string if none). */
  query: string;
  /** Inner HTTP headers, including Ed25519 auth headers. */
  headers: Record<string, string>;
  /** Raw body as a string (pre-sealed). */
  body: string;
}

/** Unsealed Core RPC response (after NaCl decrypt). */
export interface CoreRPCResponse {
  type: typeof RPC_RESPONSE_TYPE;
  request_id: string;
  /** Responder DID (the Core that produced this response). */
  from: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Ed25519 signature over the response — verifier binds to `from`. */
  signature: string;
}
