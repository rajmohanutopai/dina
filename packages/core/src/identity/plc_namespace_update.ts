/**
 * PLC namespace-update composer (TN-IDENT-005).
 *
 * Composes a `plc_operation` UPDATE that appends a pseudonymous-namespace
 * Ed25519 signing key to the user's did:plc identity. The composer is
 * pure: no I/O, no clock — submission to the PLC directory is the
 * concern of TN-IDENT-006.
 *
 * Wire shape (matches `buildCreationOperation` for genesis ops, but
 * `prev` is the CID of the last applied signed operation rather than
 * `null`):
 *
 *     {
 *       type: "plc_operation",
 *       prev: "bafy...<CID of prior signed op>",
 *       rotationKeys: [...prior keys, unchanged],
 *       verificationMethods: {
 *         dina_signing: "did:key:<prior>",
 *         namespace_0:  "did:key:z<new-namespace-pub-multibase>",
 *         …
 *       },
 *       services: { …prior, unchanged },
 *       alsoKnownAs: [ …prior, unchanged ],
 *       sig: "<base64url(secp256k1 ECDSA over dag_cbor(op-without-sig))>"
 *     }
 *
 * The fragment that resolves to the new key in the published DID
 * document is `did:plc:xxxx#namespace_<N>`. PLC's resolver synthesises
 * `#`-prefixed fragments from `verificationMethods`' map keys.
 *
 * Why we expose two compose entry points:
 *   - `composeNamespaceUpdate` returns the unsigned op + the new
 *     fragment + the prior-op CID it'll be chained off. Useful when
 *     a UI wants to surface the change to the user before a signing
 *     ceremony (e.g. show "you're about to add namespace #2").
 *   - `composeAndSignNamespaceUpdate` runs the full ceremony in one
 *     call — caller passes the rotation private key directly. Used
 *     by the headless flow (mobile bootstrap, CLI, etc.).
 *
 * Determinism: same prior op + same namespace index + same key + same
 * rotation key → byte-identical signed operation. Pinned via unit tests.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { ED25519_PUBLIC_KEY_BYTES } from '../constants';

import { base32LowercaseNoPad } from './base32';
import { publicKeyToMultibase } from './did';
import { dagCborEncode, signOperation } from './directory';

// -----------------------------------------------------------------------
// CID — used for the `prev` field on PLC update ops.
// -----------------------------------------------------------------------

/**
 * Multicodec for IPLD `dag-cbor` codec — see
 * https://github.com/multiformats/multicodec/blob/master/table.csv
 */
const DAG_CBOR_CODEC = 0x71;

/** Multihash code for SHA-256. */
const MULTIHASH_SHA256 = 0x12;

/** SHA-256 digest length. */
const SHA256_DIGEST_LEN = 32;

/** CIDv1 version byte. */
const CID_V1 = 0x01;

/**
 * Compute the CIDv1 (dag-cbor + sha256) of any value the PLC op
 * format permits. This is what the next PLC update's `prev` field
 * references — the spec requires a CID, not just a hash.
 *
 * Format (raw bytes, before multibase): `0x01 0x71 0x12 0x20 ||
 * sha256(dagcbor(value))`. The result is multibase-encoded as
 * base32 lowercase no-padding with the `b` prefix.
 */
export function cidForOperation(operation: Record<string, unknown>): string {
  const cbor = dagCborEncode(operation);
  const digest = sha256(cbor);

  // Wrap the digest in CIDv1 + dag-cbor + sha256-multihash framing.
  const cidBytes = new Uint8Array(4 + SHA256_DIGEST_LEN);
  cidBytes[0] = CID_V1;
  cidBytes[1] = DAG_CBOR_CODEC;
  cidBytes[2] = MULTIHASH_SHA256;
  cidBytes[3] = SHA256_DIGEST_LEN;
  cidBytes.set(digest, 4);

  return 'b' + base32LowercaseNoPad(cidBytes);
}

// -----------------------------------------------------------------------
// Compose
// -----------------------------------------------------------------------

/**
 * The fragment under which a namespace key is registered in the PLC
 * `verificationMethods` map. PLC resolves these as
 * `did:plc:xxxx#namespace_<N>` in the published DID document.
 */
export function namespaceFragment(namespaceIndex: number): string {
  if (!Number.isInteger(namespaceIndex) || namespaceIndex < 0) {
    throw new Error(
      `plc_namespace: namespaceIndex must be a non-negative integer, got ${namespaceIndex}`,
    );
  }
  return `namespace_${namespaceIndex}`;
}

export interface ComposeNamespaceUpdateParams {
  /**
   * The full prior signed PLC operation as fetched from the PLC
   * directory's audit log (the latest entry, signed). Used to:
   *   - compute `prev` (the CID).
   *   - inherit `rotationKeys`, `services`, `alsoKnownAs`,
   *     `verificationMethods` (every prior key stays).
   *   - confirm the new fragment isn't already taken.
   */
  priorSignedOperation: Record<string, unknown>;

  /** New namespace index — becomes the `namespace_<N>` fragment. */
  namespaceIndex: number;

  /** 32-byte Ed25519 public key for the new namespace. */
  namespacePublicKey: Uint8Array;
}

export interface ComposedNamespaceUpdate {
  /** The unsigned op, ready to feed `signOperation`. */
  unsignedOperation: Record<string, unknown>;
  /** CIDv1 of the prior signed op — what we set `prev` to. */
  priorCid: string;
  /** The verification-method fragment, e.g. `namespace_2`. */
  fragment: string;
}

/**
 * Build the unsigned PLC update operation for adding a new namespace
 * Ed25519 key. Caller signs separately via `signOperation` (or uses the
 * full-ceremony `composeAndSignNamespaceUpdate`).
 *
 * Validation contract:
 *   - `namespacePublicKey` must be exactly 32 bytes.
 *   - The prior op must carry a `verificationMethods` map (every
 *     well-formed Dina genesis op does).
 *   - The fragment `namespace_<N>` must not already exist in the
 *     prior op's `verificationMethods` — collisions are caller error,
 *     not silent overwrites (would orphan the existing key, breaking
 *     attestations signed under it).
 */
export function composeNamespaceUpdate(
  params: ComposeNamespaceUpdateParams,
): ComposedNamespaceUpdate {
  validateNamespacePublicKey(params.namespacePublicKey);

  const fragment = namespaceFragment(params.namespaceIndex);
  const prior = params.priorSignedOperation;
  const priorCid = cidForOperation(prior);

  const priorVMs = readVerificationMethods(prior);
  if (Object.prototype.hasOwnProperty.call(priorVMs, fragment)) {
    throw new Error(
      `plc_namespace: fragment "${fragment}" is already present in prior op — refusing to overwrite (would orphan the existing key)`,
    );
  }

  const namespaceMultibase = publicKeyToMultibase(params.namespacePublicKey);

  // PLC update shape: copy every field the prior op carried, replacing
  // `prev`/`sig` and overlaying the new VM. Unknown fields pass through
  // untouched so a future PLC schema extension doesn't get silently
  // stripped on namespace updates.
  const next: Record<string, unknown> = { ...prior };
  delete next.sig; // signed below
  next.prev = priorCid;
  next.verificationMethods = {
    ...priorVMs,
    [fragment]: `did:key:${namespaceMultibase}`,
  };

  return {
    unsignedOperation: next,
    priorCid,
    fragment,
  };
}

export interface ComposeAndSignNamespaceUpdateParams extends ComposeNamespaceUpdateParams {
  /** 32-byte secp256k1 rotation private key. Must correspond to one
   * of the prior op's `rotationKeys` — the PLC directory rejects
   * sigs from any other key, so we don't pre-validate here (caller
   * controls which rotation key is held in memory). */
  rotationPrivateKey: Uint8Array;
}

export interface SignedNamespaceUpdate extends ComposedNamespaceUpdate {
  /** The signed op, ready to POST to the PLC directory. */
  signedOperation: Record<string, unknown>;
  /** Hex-encoded SHA-256 of dag_cbor(signedOperation), as returned
   * by `signOperation`. NOT the CID — for that, see `cidForOperation`. */
  operationHash: string;
}

/**
 * Full ceremony: compose + sign in one call. Returns everything a
 * caller needs to either submit (TN-IDENT-006) or audit.
 */
export function composeAndSignNamespaceUpdate(
  params: ComposeAndSignNamespaceUpdateParams,
): SignedNamespaceUpdate {
  const composed = composeNamespaceUpdate(params);
  const { signedOperation, operationHash } = signOperation(
    composed.unsignedOperation,
    params.rotationPrivateKey,
  );
  return {
    ...composed,
    signedOperation,
    operationHash,
  };
}

// -----------------------------------------------------------------------
// Disable (TN-IDENT-008) — REMOVE a namespace verificationMethod.
//
// Per plan §3.5.4, the user can disable a namespace they no longer
// want to use. Disable composes a PLC update that strips
// `verificationMethods.namespace_<N>` while preserving every other
// field. The on-chain record of the prior op stays — the namespace
// key continues to verify any historical attestations it ever signed
// (PLC's audit log doesn't rewrite history). Disable just stops the
// resolver from synthesising the `#namespace_<N>` fragment going
// forward.
//
// Disabling `dina_signing` is forbidden — that would brick the
// account's primary signing identity.
// -----------------------------------------------------------------------

/** The fragment whose removal is forbidden — disabling it would
 * brick the primary signing identity. */
const PROTECTED_DINA_SIGNING_FRAGMENT = 'dina_signing';

export interface ComposeNamespaceDisableParams {
  /** The full prior signed PLC operation, used the same way as in the
   * add path — provides `prev` (CID), `rotationKeys`, etc. */
  priorSignedOperation: Record<string, unknown>;
  /** Index of the namespace to disable. Must currently exist as
   * `namespace_<N>` in the prior op's `verificationMethods`. */
  namespaceIndex: number;
}

export interface ComposedNamespaceDisable {
  /** The unsigned op, ready to feed `signOperation`. */
  unsignedOperation: Record<string, unknown>;
  /** CIDv1 of the prior signed op — what we set `prev` to. */
  priorCid: string;
  /** The verification-method fragment that's being removed. */
  fragment: string;
}

export interface ComposeAndSignNamespaceDisableParams extends ComposeNamespaceDisableParams {
  /** 32-byte secp256k1 rotation private key (must match a rotation key
   * in the prior op). */
  rotationPrivateKey: Uint8Array;
}

export interface SignedNamespaceDisable extends ComposedNamespaceDisable {
  /** The signed op, ready to POST to the PLC directory. */
  signedOperation: Record<string, unknown>;
  /** Hex-encoded SHA-256 of dag_cbor(signedOperation). NOT the CID. */
  operationHash: string;
}

/**
 * Build the unsigned PLC update operation that REMOVES a namespace
 * verification key. Caller signs separately via `signOperation` (or
 * uses the full-ceremony `composeAndSignNamespaceDisable`).
 *
 * Validation contract:
 *   - The fragment `namespace_<N>` MUST exist in the prior op (can't
 *     disable what's not there — caller error, not a no-op).
 *   - The prior op's `verificationMethods` map must still carry at
 *     least one non-namespace entry after the removal (we never strip
 *     `dina_signing`; disabling the last namespace is fine because
 *     `dina_signing` always remains).
 */
export function composeNamespaceDisable(
  params: ComposeNamespaceDisableParams,
): ComposedNamespaceDisable {
  const fragment = namespaceFragment(params.namespaceIndex);
  const prior = params.priorSignedOperation;
  const priorCid = cidForOperation(prior);

  const priorVMs = readVerificationMethods(prior);
  if (!Object.prototype.hasOwnProperty.call(priorVMs, fragment)) {
    throw new Error(
      `plc_namespace: cannot disable "${fragment}" — fragment not present in prior op`,
    );
  }
  // Defence-in-depth: namespaceFragment(...) only ever returns
  // `namespace_<N>`, never `dina_signing`, so this branch can only fire
  // if a future code path bypasses the helper. Keep the guard anyway —
  // accidentally bricking dina_signing via a refactor would be silent
  // and irrecoverable from the user's side without re-running PLC
  // recovery.
  if (fragment === PROTECTED_DINA_SIGNING_FRAGMENT) {
    throw new Error(
      `plc_namespace: refusing to disable "${PROTECTED_DINA_SIGNING_FRAGMENT}" — primary signing key is protected`,
    );
  }

  // Build the trimmed VM map by filtering out the disabled fragment —
  // safer than `delete nextVMs[fragment]` (lint-flagged dynamic delete)
  // and produces a fresh object with predictable enumeration order.
  const nextVMs: Record<string, string> = Object.fromEntries(
    Object.entries(priorVMs).filter(([k]) => k !== fragment),
  );

  // Preserve unknown prior-op fields (forward-compat with future PLC
  // schema). Replace prev/sig and overlay the trimmed VMs.
  const next: Record<string, unknown> = { ...prior };
  delete next.sig;
  next.prev = priorCid;
  next.verificationMethods = nextVMs;

  return {
    unsignedOperation: next,
    priorCid,
    fragment,
  };
}

/**
 * Full disable ceremony: compose + sign in one call.
 */
export function composeAndSignNamespaceDisable(
  params: ComposeAndSignNamespaceDisableParams,
): SignedNamespaceDisable {
  const composed = composeNamespaceDisable(params);
  const { signedOperation, operationHash } = signOperation(
    composed.unsignedOperation,
    params.rotationPrivateKey,
  );
  return {
    ...composed,
    signedOperation,
    operationHash,
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function validateNamespacePublicKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array)) {
    throw new Error('plc_namespace: namespacePublicKey must be a Uint8Array');
  }
  if (key.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `plc_namespace: namespacePublicKey must be exactly ${ED25519_PUBLIC_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  // All-zero pubkey is the degenerate Ed25519 identity element — never
  // a real key, always a sign of an uninitialised buffer. Fail-closed.
  if (key.every((b) => b === 0)) {
    throw new Error('plc_namespace: namespacePublicKey is all-zero (uninitialised buffer?)');
  }
}

function readVerificationMethods(op: Record<string, unknown>): Record<string, string> {
  const vms = op.verificationMethods;
  if (!vms || typeof vms !== 'object') {
    throw new Error(
      'plc_namespace: prior signed operation has no `verificationMethods` map — not a Dina-shape PLC op',
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vms as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(
        `plc_namespace: prior verificationMethods["${k}"] is not a string (got ${typeof v}) — refusing to mutate a malformed op`,
      );
    }
    out[k] = v;
  }
  return out;
}

