/**
 * Task 4.27 — `VerifyPairingIdentityBinding`.
 *
 * During pairing, the client sends an envelope `{from_did, body}` where
 * `body.public_key_multibase` is the multibase-encoded Ed25519 public
 * key the client is registering. The server MUST verify that
 *
 *   envelope.from_did == "did:key:" + body.public_key_multibase
 *
 * i.e., the stated sender DID is the self-referential did:key derivable
 * from the pubkey the client is claiming. If this check passes, the
 * client proved it controls the private key that the envelope was
 * signed with AND that the DID it's identifying as is computed from
 * that same key — so no other identity can be silently substituted
 * during the pairing handshake.
 *
 * **Why this matters.** Without this check, a client could sign an
 * envelope with keypair K1 but claim `from_did = did:key:<K2_pub>`.
 * The signature check (task 4.19) would verify against whichever key
 * the allowlist maps to — but at pairing time there's no allowlist
 * yet, and the server trusts the body's declared pub key. Binding the
 * two prevents "bring your own DID" substitution.
 *
 * Plugs into the pairing route handler (task 4.26's bypassed paths)
 * BEFORE the route accepts the pairing request.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.27.
 */

import { deriveDIDKey, multibaseToPublicKey } from '@dina/core';

export interface PairingBindingInput {
  /** The envelope's `from_did` field. Expected shape: `did:key:<multibase>`. */
  envelopeFromDid: string;
  /** The body's `public_key_multibase` field — multibase-encoded pub key. */
  bodyPublicKeyMultibase: string;
}

export type PairingBindingResult =
  | { ok: true; did: string }
  | {
      ok: false;
      reason:
        | 'missing_from_did'
        | 'missing_public_key'
        | 'malformed_public_key'
        | 'did_mismatch';
      detail?: string;
    };

/**
 * Verify the self-referential binding. Returns the derived DID on
 * success so downstream handlers have a single canonical form.
 */
export function verifyPairingIdentityBinding(
  input: PairingBindingInput,
): PairingBindingResult {
  if (!input.envelopeFromDid || input.envelopeFromDid.length === 0) {
    return { ok: false, reason: 'missing_from_did' };
  }
  if (!input.bodyPublicKeyMultibase || input.bodyPublicKeyMultibase.length === 0) {
    return { ok: false, reason: 'missing_public_key' };
  }

  // Decode the multibase pubkey — fail-closed on any malformed form.
  let pubKey: Uint8Array;
  try {
    pubKey = multibaseToPublicKey(input.bodyPublicKeyMultibase);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_public_key',
      detail: (err as Error).message,
    };
  }

  // Derive the canonical `did:key:<multibase>` from the pub key bytes.
  // This is the ONLY DID the client is allowed to claim during pairing.
  const expectedDid = deriveDIDKey(pubKey);

  if (input.envelopeFromDid !== expectedDid) {
    return {
      ok: false,
      reason: 'did_mismatch',
      detail: `envelope.from_did (${input.envelopeFromDid}) != did:key derived from body.public_key_multibase (${expectedDid})`,
    };
  }

  return { ok: true, did: expectedDid };
}
