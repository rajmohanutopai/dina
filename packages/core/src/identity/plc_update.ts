/**
 * PLC update operation — generic.
 *
 * Updates a published `did:plc` identity — rotate keys, change handle,
 * add/remove service endpoints. The update ceremony:
 *
 *   1. Fetch the current DID doc from the PLC directory.
 *   2. Build an update operation that references the previous op's
 *      CID via `prev`.
 *   3. Sign with a key currently in `rotationKeys` (per PLC spec,
 *      the signer must be one of the listed rotation keys).
 *   4. POST the signed op to the PLC directory.
 *
 * This module focuses on steps 2–4 — step 1 is the caller's concern
 * (resolve + parse the current doc via `resolveDIDPLC`).
 *
 * **Sign with rotation key, not signing key** — the distinction
 * matters: Ed25519 signing key handles D2D + request auth; secp256k1
 * rotation key is the PLC-authoritative key that authorises changes.
 * Rotation keys live in `rotationKeys[]` on the op; signing keys live
 * in `verificationMethods`. Reuses `signOperation` from
 * `./directory` — same canonical dag-cbor + SHA-256 + ECDSA low-s
 * signing as the creation ceremony.
 *
 * **Update-scope fields**: `verificationMethods`, `rotationKeys`,
 * `services`, `alsoKnownAs`. Everything else (type, prev) is locked
 * by the spec or derived from context.
 *
 * Originally lived in `apps/home-node-lite/core-server/src/identity/`
 * (Phase 4g task 4.60); promoted to `@dina/core` so mobile onboarding
 * (PDS-first flow → mint via PDS → update to add `dina-messaging`
 * service + `dina_signing` VM) can import without reaching across the
 * apps boundary.
 */

import { deriveRotationKey } from '../crypto/slip0010';
import { publicKeyToMultibase } from './did';
import { signOperation, type PLCDirectoryConfig } from './directory';
import { base58 } from '@scure/base';

/** Default PLC directory — mirrors `DEFAULT_PLC_DIRECTORY` in `../constants`. */
const DEFAULT_PLC_URL = 'https://plc.directory';

/** Multicodec varint prefix for secp256k1 public key. */
const SECP256K1_MULTICODEC = new Uint8Array([0xe7, 0x01]);

export interface PLCUpdateParams {
  /** DID to update. */
  did: string;
  /**
   * CID of the PREVIOUS op. Every update chains to the prior record
   * via this field; tampering invalidates the chain. Obtained from
   * the `prev` of the current resolved op.
   */
  prev: string;
  /** New `verificationMethods` map — fragment → `did:key:z...`. */
  verificationMethods: Record<string, string>;
  /**
   * New `rotationKeys` list — each entry is a `did:key:z...` string.
   * Must contain at least one key; PLC spec forbids an empty list.
   */
  rotationKeys: string[];
  /** New `services` map — fragment → `{type, endpoint}`. */
  services?: Record<string, { type: string; endpoint: string }>;
  /** `alsoKnownAs` — usually `[`at://${handle}`]`. */
  alsoKnownAs?: string[];
  /**
   * 32-byte secp256k1 seed to derive the SIGNER (current rotation
   * key). Must match one of the rotation keys currently published
   * in the DID doc — otherwise the PLC directory rejects the op.
   */
  signerRotationSeed: Uint8Array;
  /** Generation for the signer's rotation key. Default 0. */
  signerRotationGeneration?: number;
}

export interface PLCUpdateResult {
  /** The did (unchanged from input — update doesn't remint the DID). */
  did: string;
  /** Signed, fully-formed update op ready to POST to PLC. */
  signedOperation: Record<string, unknown>;
  /** Hex SHA-256 of the unsigned op's dag-cbor encoding. */
  operationHash: string;
}

/**
 * Build an unsigned PLC update operation. Pure — no I/O, no signing.
 * Returns the op ready for `signOperation` from `./directory`.
 */
export function buildUpdateOperation(
  params: PLCUpdateParams,
): Record<string, unknown> {
  if (!params.did || !params.did.startsWith('did:plc:')) {
    throw new Error(
      `buildUpdateOperation: did must start with "did:plc:" (got ${JSON.stringify(params.did)})`,
    );
  }
  if (!params.prev || params.prev.length === 0) {
    throw new Error('buildUpdateOperation: prev is required');
  }
  if (!Array.isArray(params.rotationKeys) || params.rotationKeys.length === 0) {
    throw new Error('buildUpdateOperation: rotationKeys must be non-empty');
  }
  for (const rk of params.rotationKeys) {
    if (typeof rk !== 'string' || !rk.startsWith('did:key:')) {
      throw new Error(
        `buildUpdateOperation: every rotationKey must be a did:key string (got ${JSON.stringify(rk)})`,
      );
    }
  }
  if (
    params.verificationMethods === null ||
    typeof params.verificationMethods !== 'object'
  ) {
    throw new Error(
      'buildUpdateOperation: verificationMethods must be a record',
    );
  }
  for (const [k, v] of Object.entries(params.verificationMethods)) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new Error(
        'buildUpdateOperation: verificationMethods keys must be non-empty strings',
      );
    }
    if (typeof v !== 'string' || !v.startsWith('did:key:')) {
      throw new Error(
        `buildUpdateOperation: verificationMethods[${JSON.stringify(k)}] must be a did:key string`,
      );
    }
  }

  const op: Record<string, unknown> = {
    type: 'plc_operation',
    verificationMethods: { ...params.verificationMethods },
    rotationKeys: [...params.rotationKeys],
    alsoKnownAs: [...(params.alsoKnownAs ?? [])],
    services: params.services ? { ...params.services } : {},
    prev: params.prev,
  };
  return op;
}

/**
 * Build + sign + (optionally) submit a PLC update. Single-call
 * ceremony the admin CLI / mobile onboarding uses. Returns the signed
 * op + the DID + the operation hash. When `config.fetch` is wired,
 * also POSTs to the PLC directory and throws on non-2xx.
 */
export async function updateDIDPLC(
  params: PLCUpdateParams,
  config?: PLCDirectoryConfig,
): Promise<PLCUpdateResult> {
  if (!params.signerRotationSeed || params.signerRotationSeed.length !== 32) {
    throw new Error(
      'updateDIDPLC: signerRotationSeed must be 32 bytes (secp256k1 seed)',
    );
  }

  const operation = buildUpdateOperation(params);
  const signerGen = params.signerRotationGeneration ?? 0;
  const signer = deriveRotationKey(params.signerRotationSeed, signerGen);

  // Sanity: the signer's derived pubkey must appear in rotationKeys.
  // If it doesn't, we're about to POST an op PLC will reject. Fail
  // fast with a clear error rather than waiting for the 400.
  const signerMultibase = secp256k1ToMultibase(signer.publicKey);
  const signerDidKey = `did:key:${signerMultibase}`;
  if (!params.rotationKeys.includes(signerDidKey)) {
    throw new Error(
      `updateDIDPLC: signer key ${signerDidKey} is not in rotationKeys — PLC will reject this op`,
    );
  }

  const { signedOperation, operationHash } = signOperation(
    operation,
    signer.privateKey,
  );

  if (config?.fetch) {
    const plcURL = (config.plcURL ?? DEFAULT_PLC_URL).replace(/\/$/, '');
    const response = await config.fetch(`${plcURL}/${params.did}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedOperation),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `updateDIDPLC: PLC directory rejected update — HTTP ${response.status} — ${errorText}`,
      );
    }
  }

  return {
    did: params.did,
    signedOperation,
    operationHash,
  };
}

/** Encode a 33-byte compressed secp256k1 pub into did:key multibase. */
export function secp256k1ToDidKeyMultibase(pubKey: Uint8Array): string {
  return secp256k1ToMultibase(pubKey);
}

function secp256k1ToMultibase(pubKey: Uint8Array): string {
  const payload = new Uint8Array(SECP256K1_MULTICODEC.length + pubKey.length);
  payload.set(SECP256K1_MULTICODEC, 0);
  payload.set(pubKey, SECP256K1_MULTICODEC.length);
  return 'z' + base58.encode(payload);
}

// ---------------------------------------------------------------------------
// Convenience builders for common update scenarios.
// ---------------------------------------------------------------------------

/**
 * Build an update that ONLY rotates the signing key (leaves rotation
 * keys + services + handle intact). Convenience for the common
 * "rotate my Ed25519 signing key" flow — caller supplies the existing
 * rest of the doc.
 */
export interface SigningKeyRotationParams {
  did: string;
  prev: string;
  newSigningPubKey: Uint8Array;
  /** Existing rotation keys (unchanged). */
  rotationKeys: string[];
  /** Existing services (unchanged). */
  services?: Record<string, { type: string; endpoint: string }>;
  /** Existing alsoKnownAs (unchanged). */
  alsoKnownAs?: string[];
  /** 32-byte secp256k1 seed to derive the current signer (rotation key). */
  signerRotationSeed: Uint8Array;
  signerRotationGeneration?: number;
}

export function buildSigningKeyRotation(
  params: SigningKeyRotationParams,
): PLCUpdateParams {
  if (!params.newSigningPubKey || params.newSigningPubKey.length !== 32) {
    throw new Error(
      'buildSigningKeyRotation: newSigningPubKey must be 32 bytes (Ed25519 public)',
    );
  }
  const newSigningMultibase = publicKeyToMultibase(params.newSigningPubKey);
  return {
    did: params.did,
    prev: params.prev,
    verificationMethods: {
      dina_signing: `did:key:${newSigningMultibase}`,
    },
    rotationKeys: params.rotationKeys,
    ...(params.services !== undefined ? { services: params.services } : {}),
    ...(params.alsoKnownAs !== undefined ? { alsoKnownAs: params.alsoKnownAs } : {}),
    signerRotationSeed: params.signerRotationSeed,
    ...(params.signerRotationGeneration !== undefined
      ? { signerRotationGeneration: params.signerRotationGeneration }
      : {}),
  };
}
