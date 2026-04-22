/**
 * Core RPC Relay — response authentication.
 *
 * Core signs the response with its root identity key:
 *   canonical = "core_rpc_response\n{request_id}\n{status}\n{sha256_hex(body)}"
 *   signature = Ed25519.sign(canonical, rootPrivateKey)
 *
 * The caller verifies against the target Core's DID public key.
 * This prevents MsgBox or MITM from forging responses.
 *
 * Mobile-specific protocol: Section 19.2 of ARCHITECTURE.md.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { RPC_RESPONSE_TYPE } from '../constants';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sign, verify } from '../crypto/ed25519';
import { sealEncrypt } from '../crypto/nacl';
import type { CoreRPCResponse } from './rpc_envelope';

/**
 * Build the canonical string for response signing.
 *
 * Format: "core_rpc_response\n{request_id}\n{status}\n{sha256_hex(body)}"
 * This binds the response to a specific request, preventing replay/reuse.
 */
export function buildResponseCanonical(requestId: string, status: number, body: string): string {
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  return `core_rpc_response\n${requestId}\n${status}\n${bodyHash}`;
}

/**
 * Build a signed Core RPC response.
 *
 * Signs the canonical string with the Core's root Ed25519 identity key.
 * The signature is hex-encoded and included in the response envelope.
 */
export function buildSignedResponse(
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: string,
  coreDID: string,
  corePrivateKey: Uint8Array,
): CoreRPCResponse {
  const canonical = buildResponseCanonical(requestId, status, body);
  const sig = sign(corePrivateKey, new TextEncoder().encode(canonical));

  return {
    type: RPC_RESPONSE_TYPE as 'core_rpc_response',
    request_id: requestId,
    from: coreDID,
    status,
    headers,
    body,
    signature: bytesToHex(sig),
  };
}

/**
 * Verify a Core RPC response signature.
 *
 * Reconstructs the canonical string from the response fields and verifies
 * the Ed25519 signature against the Core's public key.
 */
export function verifyResponseSignature(
  response: CoreRPCResponse,
  corePublicKey: Uint8Array,
): boolean {
  const canonical = buildResponseCanonical(response.request_id, response.status, response.body);
  const sigBytes = hexToBytes(response.signature);
  return verify(corePublicKey, new TextEncoder().encode(canonical), sigBytes);
}

/** Seal a response envelope with NaCl for MsgBox transport back to caller. */
export function sealRPCResponse(
  response: CoreRPCResponse,
  senderEd25519Pub: Uint8Array,
): Uint8Array {
  const json = JSON.stringify(response);
  return sealEncrypt(new TextEncoder().encode(json), senderEd25519Pub);
}
