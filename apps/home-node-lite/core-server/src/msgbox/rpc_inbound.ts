/**
 * Task 4.45 — inbound RPC sealed-box decrypt.
 *
 * When the MsgBox relay delivers a sealed RPC blob over the
 * WebSocket, Core must:
 *
 *   1. NaCl `crypto_box_seal_open` the bytes with its own Ed25519
 *      keypair (Ed25519 → X25519 conversion happens inside
 *      `@dina/core.sealDecrypt`).
 *   2. JSON.parse the plaintext into a `CoreRPCRequest`.
 *   3. Shape-validate the result: type tag + required fields.
 *   4. Return a structured result — success with the request, or
 *      failure with a specific reason (decrypt failed, JSON
 *      corrupt, wrong envelope type, missing fields).
 *
 * The caller (MsgBox WS client) then:
 *   - On `ok:false`, drops the frame + logs the reason (and may
 *     reconnect if decrypts start failing consistently — wrong key).
 *   - On `ok:true`, hands the request to the 4.46 dispatch pipeline.
 *
 * **Why a thin wrapper over `@dina/core.unsealRPCRequest`**: that
 * function throws on every failure path. The MsgBox client wants a
 * structured result so it can log + react per-reason (e.g. JSON
 * corruption might be a relay bug; decrypt failure is usually a key
 * mismatch worth alerting on). Try/catch + dispatch on the error
 * message is fragile; this module gives the caller a stable enum.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.45.
 */

import {
  sealDecrypt,
  type CoreRPCRequest,
} from '@dina/core';
import { RPC_REQUEST_TYPE } from '@dina/protocol';

export type UnsealRpcResult =
  | { ok: true; request: CoreRPCRequest }
  | {
      ok: false;
      reason:
        | 'decrypt_failed'
        | 'malformed_json'
        | 'wrong_envelope_type'
        | 'missing_required_field';
      detail?: string;
    };

export interface UnsealRpcInput {
  /** Raw bytes from the WS frame (sealed RPC envelope). */
  sealed: Uint8Array;
  /** Home Node's own Ed25519 pubkey. Must match the one senders sealed TO. */
  recipientEd25519Pub: Uint8Array;
  /** Home Node's own Ed25519 private key. */
  recipientEd25519Priv: Uint8Array;
}

/**
 * Unseal + parse + shape-validate an inbound MsgBox RPC. Never throws.
 */
export function unsealInboundRpc(input: UnsealRpcInput): UnsealRpcResult {
  if (input.recipientEd25519Pub.length !== 32) {
    return {
      ok: false,
      reason: 'decrypt_failed',
      detail: `recipientEd25519Pub must be 32 bytes (got ${input.recipientEd25519Pub.length})`,
    };
  }
  if (input.recipientEd25519Priv.length !== 32) {
    return {
      ok: false,
      reason: 'decrypt_failed',
      detail: `recipientEd25519Priv must be 32 bytes (got ${input.recipientEd25519Priv.length})`,
    };
  }

  let plaintext: Uint8Array;
  try {
    plaintext = sealDecrypt(
      input.sealed,
      input.recipientEd25519Pub,
      input.recipientEd25519Priv,
    );
  } catch (err) {
    return {
      ok: false,
      reason: 'decrypt_failed',
      detail: (err as Error).message,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_json',
      detail: (err as Error).message,
    };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'malformed_json', detail: 'top-level JSON is not an object' };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj['type'] !== RPC_REQUEST_TYPE) {
    return {
      ok: false,
      reason: 'wrong_envelope_type',
      detail: `type=${JSON.stringify(obj['type'])} (want ${RPC_REQUEST_TYPE})`,
    };
  }

  // Shape check — every required field present + correct type.
  const required: Array<keyof CoreRPCRequest> = [
    'request_id',
    'from',
    'method',
    'path',
    'query',
    'headers',
    'body',
  ];
  for (const key of required) {
    if (!(key in obj)) {
      return {
        ok: false,
        reason: 'missing_required_field',
        detail: `missing "${key}"`,
      };
    }
  }
  // String-valued fields — strict type check so a malicious sender
  // sending `null` or a number doesn't reach the handler.
  for (const key of ['request_id', 'from', 'method', 'path', 'query', 'body'] as const) {
    if (typeof obj[key] !== 'string') {
      return {
        ok: false,
        reason: 'missing_required_field',
        detail: `"${key}" must be a string (got ${typeof obj[key]})`,
      };
    }
  }
  if (typeof obj['headers'] !== 'object' || obj['headers'] === null) {
    return {
      ok: false,
      reason: 'missing_required_field',
      detail: `"headers" must be an object (got ${typeof obj['headers']})`,
    };
  }

  return { ok: true, request: obj as unknown as CoreRPCRequest };
}
