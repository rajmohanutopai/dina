/**
 * Core RPC response send — build, sign, seal, deliver response.
 *
 * Pipeline:
 *   1. Build signed response (Ed25519 over canonical)
 *   2. NaCl seal for the original sender's public key
 *   3. Build MsgBox /forward headers (all 6 required)
 *   4. POST to MsgBox /forward
 *
 * This is the outbound half of the Core RPC relay protocol.
 * The inbound half (request) is in rpc_handler.ts.
 *
 * Source: ARCHITECTURE.md Tasks 2.24, 2.25
 */

import { buildSignedResponse, sealRPCResponse } from './rpc_response';
import { buildForwardHeaders, postToForward, type ForwardResult } from './msgbox_forward';
import { getPublicKey } from '../crypto/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { appendAudit } from '../audit/service';

export interface RespondInput {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  coreDID: string;
  corePrivateKey: Uint8Array;
  senderDID: string;
  senderEd25519Pub: Uint8Array;
  msgboxURL: string;
}

export interface RespondResult {
  sent: boolean;
  forwardResult?: ForwardResult;
  error?: string;
}

/**
 * Build, sign, seal, and send a Core RPC response.
 *
 * Full pipeline from response data to MsgBox delivery.
 */
export async function sendRPCResponse(input: RespondInput): Promise<RespondResult> {
  try {
    // 1. Build signed response
    const response = buildSignedResponse(
      input.requestId,
      input.status,
      input.headers,
      input.body,
      input.coreDID,
      input.corePrivateKey,
    );

    // 2. Seal for original sender
    const sealed = sealRPCResponse(response, input.senderEd25519Pub);

    // 3. Build forward headers
    const corePub = getPublicKey(input.corePrivateKey);
    const forwardHeaders = buildForwardHeaders(
      input.senderDID,
      input.coreDID,
      bytesToHex(corePub),
      input.corePrivateKey,
      sealed,
    );

    // 4. POST to MsgBox
    const forwardResult = await postToForward(input.msgboxURL, forwardHeaders, sealed);

    appendAudit(
      'rpc_responder',
      'rpc_response_sent',
      input.senderDID,
      `req_id=${input.requestId} status=${input.status} delivery=${forwardResult.status}`,
    );

    return { sent: true, forwardResult };
  } catch (err) {
    appendAudit(
      'rpc_responder',
      'rpc_response_failed',
      input.senderDID,
      `req_id=${input.requestId} error=${err instanceof Error ? err.message : 'unknown'}`,
    );

    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
