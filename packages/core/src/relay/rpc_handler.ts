/**
 * Core RPC request handler — process inbound Core RPC envelopes.
 *
 * Pipeline:
 *   1. NaCl unseal the encrypted blob (recipient's keys)
 *   2. Validate identity binding (envelope.from == inner X-DID)
 *   3. Resolve sender's public key from DID
 *   4. Verify inner Ed25519 signature via auth middleware
 *   5. Return the validated, authenticated request
 *
 * This is the inbound half of the Core RPC relay protocol.
 * The outbound half (response) is in rpc_responder.ts.
 *
 * Source: ARCHITECTURE.md Tasks 2.22, 2.23
 */

import { unsealRPCRequest, type CoreRPCRequest } from './rpc_envelope';
import { validateIdentityBinding } from './identity_binding';
import { validateInnerAuth } from './rpc_envelope';
import { appendAudit } from '../audit/service';
import { verifyRequest } from '../auth/canonical';

export interface RPCHandlerResult {
  valid: boolean;
  request?: CoreRPCRequest;
  senderDID?: string;
  rejectedAt?: 'unseal' | 'identity_binding' | 'inner_auth';
  reason?: string;
}

/** Injectable public key resolver (DID → public key, for signature verification). */
let publicKeyResolver: ((did: string) => Uint8Array | null) | null = null;

/** Register a public key resolver. */
export function registerRPCPublicKeyResolver(resolver: (did: string) => Uint8Array | null): void {
  publicKeyResolver = resolver;
}

/** Reset (for testing). */
export function resetRPCHandler(): void {
  publicKeyResolver = null;
}

/**
 * Handle an incoming sealed Core RPC request.
 *
 * Decrypts, validates identity binding, verifies auth headers.
 * Returns the validated request or a rejection reason.
 */
export function handleRPCRequest(
  sealedBlob: Uint8Array,
  recipientPub: Uint8Array,
  recipientPriv: Uint8Array,
): RPCHandlerResult {
  // 1. Unseal
  let request: CoreRPCRequest;
  try {
    request = unsealRPCRequest(sealedBlob, recipientPub, recipientPriv);
  } catch (err) {
    return {
      valid: false,
      rejectedAt: 'unseal',
      reason: `NaCl unseal failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  // 2. Validate identity binding (envelope.from == inner X-DID)
  const binding = validateIdentityBinding(request);
  if (!binding.valid) {
    appendAudit(
      'rpc_handler',
      'rpc_identity_rejected',
      request.from,
      `id=${request.request_id} error=${binding.error}`,
    );
    return {
      valid: false,
      request,
      senderDID: request.from,
      rejectedAt: 'identity_binding',
      reason: binding.error,
    };
  }

  // 3. Validate inner Ed25519 auth headers present
  if (!validateInnerAuth(request)) {
    appendAudit(
      'rpc_handler',
      'rpc_auth_rejected',
      request.from,
      `id=${request.request_id} reason=missing_auth_headers`,
    );
    return {
      valid: false,
      request,
      senderDID: request.from,
      rejectedAt: 'inner_auth',
      reason: 'Missing required inner auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
    };
  }

  // 4. Verify inner Ed25519 signature (not just header presence)
  if (publicKeyResolver) {
    const senderPubKey = publicKeyResolver(request.from);
    if (!senderPubKey) {
      appendAudit(
        'rpc_handler',
        'rpc_auth_rejected',
        request.from,
        `id=${request.request_id} reason=unknown_sender_did`,
      );
      return {
        valid: false,
        request,
        senderDID: request.from,
        rejectedAt: 'inner_auth',
        reason: `Cannot resolve public key for sender DID: ${request.from}`,
      };
    }

    // Verify the inner request signature using canonical verification
    const bodyBytes = request.body
      ? new TextEncoder().encode(
          typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
        )
      : new Uint8Array(0);
    const signatureValid = verifyRequest(
      request.method,
      request.path,
      request.headers['X-Query'] ?? '',
      request.headers['X-Timestamp'] ?? '',
      request.headers['X-Nonce'] ?? '',
      bodyBytes,
      request.headers['X-Signature'] ?? '',
      senderPubKey,
    );

    if (!signatureValid) {
      appendAudit(
        'rpc_handler',
        'rpc_sig_rejected',
        request.from,
        `id=${request.request_id} reason=invalid_signature`,
      );
      return {
        valid: false,
        request,
        senderDID: request.from,
        rejectedAt: 'inner_auth',
        reason: 'Inner Ed25519 signature verification failed',
      };
    }
  }

  // 5. Success
  appendAudit(
    'rpc_handler',
    'rpc_accepted',
    request.from,
    `id=${request.request_id} method=${request.method} path=${request.path}`,
  );

  return {
    valid: true,
    request,
    senderDID: request.from,
  };
}
