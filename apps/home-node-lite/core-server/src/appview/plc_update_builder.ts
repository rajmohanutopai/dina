/**
 * Task 6.7 — `updateDid` PLC operation + signed rotation.
 *
 * When an identity's rotation keys, verification methods, or
 * service endpoints change, a new PLC operation is built on top
 * of the chain. This module constructs that operation + signs it
 * via an injected signer, producing a ready-to-publish op.
 *
 * **Contract** (pinned by tests):
 *
 *   1. **prev**: the new op's `prev` is the CID of the current
 *      head (provided via `prevCid`). For updates, this must
 *      never be null.
 *   2. **rotationKeys**: the new set lives in the produced op.
 *      `ensureRotationKeyNonEmpty` rule applies — the caller can't
 *      accidentally lock themselves out by publishing an op with
 *      zero keys.
 *   3. **verificationMethod / services**: optional — when absent,
 *      inherit from the previous op (the caller passes the prev
 *      op so the builder can copy through unchanged fields).
 *   4. **createdAtMs**: monotonic — must be >= prev.createdAtMs.
 *      Default is `nowMsFn()`, clamped up to prev's time if
 *      clock-skew produced a regression.
 *   5. **Signer authority**: the signing key must be in the
 *      PREVIOUS op's rotationKeys. The builder passes this
 *      constraint to `signFn`; a signer for an unauthorised key
 *      rejects + the builder surfaces the rejection verbatim.
 *
 * **Injected signer**: `signFn({messageBytes, publicKey})` returns
 * a signature string. Production wires Ed25519 / K-256 via Core's
 * signing key. Tests pass a scripted signer.
 *
 * **Pure + deterministic** (with injected clock + signer). The
 * produced op is JSON-serialisable — ready for CBOR + CID + post
 * at the call-site.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6c task 6.7.
 */

import type { PlcOperation } from './plc_chain_verifier';

export interface PlcUpdateInput {
  /** New rotation-key set. Must be non-empty. */
  rotationKeys: string[];
  /** Optional new verification methods. When absent, inherits from prev. */
  verificationMethods?: Array<Record<string, unknown>>;
  /** Optional new services. When absent, inherits from prev. */
  services?: Array<Record<string, unknown>>;
  /** Optional new handles (`at://…`). When absent, inherits from prev. */
  handles?: string[];
  /** Public key used to sign this op. MUST be in `prev.rotationKeys`. */
  signerPublicKey: string;
}

export interface SignerInput {
  /** Canonical op bytes (without `sig`) — what to sign. */
  messageBytes: Uint8Array;
  /** The key the caller asked us to sign with. */
  publicKey: string;
}

/** Signer — production wires to Core's signing service. */
export type SignerFn = (input: SignerInput) => Promise<string>;

export interface BuildUpdateOptions {
  /** CID of the current chain head (the `prev` for the new op). */
  prevCid: string;
  /** The current head op — needed to inherit unchanged fields + enforce monotonic time. */
  prev: PlcOperation;
  update: PlcUpdateInput;
  signFn: SignerFn;
  /** Clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Serialise op → bytes (without `sig`). Defaults to JSON. */
  serialiseFn?: (op: Omit<PlcOperation, 'sig'>) => Uint8Array;
}

export type BuildUpdateOutcome =
  | { ok: true; op: PlcOperation }
  | {
      ok: false;
      reason:
        | 'empty_rotation_keys'
        | 'signer_not_authorised'
        | 'invalid_prev_cid'
        | 'signer_failed';
      detail: string;
    };

/**
 * Build a signed PLC update operation. Returns a structured
 * outcome; never throws.
 */
export async function buildPlcUpdateOp(
  opts: BuildUpdateOptions,
): Promise<BuildUpdateOutcome> {
  validateOptions(opts);
  const { prevCid, prev, update, signFn } = opts;
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const serialiseFn = opts.serialiseFn ?? defaultSerialise;

  if (typeof prevCid !== 'string' || prevCid === '') {
    return {
      ok: false,
      reason: 'invalid_prev_cid',
      detail: 'prevCid must be a non-empty string',
    };
  }
  if (!Array.isArray(update.rotationKeys) || update.rotationKeys.length === 0) {
    return {
      ok: false,
      reason: 'empty_rotation_keys',
      detail: 'update.rotationKeys must be non-empty',
    };
  }
  for (const k of update.rotationKeys) {
    if (typeof k !== 'string' || k === '') {
      return {
        ok: false,
        reason: 'empty_rotation_keys',
        detail: 'rotationKeys entries must be non-empty strings',
      };
    }
  }
  // Signer must be in prev's rotation keys.
  if (!prev.rotationKeys.includes(update.signerPublicKey)) {
    return {
      ok: false,
      reason: 'signer_not_authorised',
      detail: `signer "${update.signerPublicKey}" is not in prev.rotationKeys`,
    };
  }

  // Build the op body, inheriting unchanged fields from prev.
  const createdAtMs = Math.max(nowMsFn(), prev.createdAtMs);
  const body: Omit<PlcOperation, 'sig'> = {
    prev: prevCid,
    rotationKeys: [...update.rotationKeys],
    createdAtMs,
  };
  // Inherited / updated fields live under canonical keys.
  const verificationMethod =
    update.verificationMethods !== undefined
      ? update.verificationMethods
      : (prev as { verificationMethod?: unknown }).verificationMethod;
  if (verificationMethod !== undefined) {
    (body as Record<string, unknown>).verificationMethod = verificationMethod;
  }
  const services =
    update.services !== undefined
      ? update.services
      : (prev as { services?: unknown }).services;
  if (services !== undefined) {
    (body as Record<string, unknown>).services = services;
  }
  const alsoKnownAs =
    update.handles !== undefined
      ? update.handles
      : (prev as { alsoKnownAs?: unknown }).alsoKnownAs;
  if (alsoKnownAs !== undefined) {
    (body as Record<string, unknown>).alsoKnownAs = alsoKnownAs;
  }

  let sig: string;
  try {
    const messageBytes = serialiseFn(body);
    sig = await signFn({ messageBytes, publicKey: update.signerPublicKey });
    if (typeof sig !== 'string' || sig === '') {
      return {
        ok: false,
        reason: 'signer_failed',
        detail: 'signer returned an empty signature',
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'signer_failed', detail: msg };
  }

  return {
    ok: true,
    op: { ...body, sig } as PlcOperation,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateOptions(opts: BuildUpdateOptions): void {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('buildPlcUpdateOp: options required');
  }
  if (typeof opts.signFn !== 'function') {
    throw new TypeError('buildPlcUpdateOp: signFn is required');
  }
  if (!opts.prev || typeof opts.prev !== 'object') {
    throw new TypeError('buildPlcUpdateOp: prev is required');
  }
  if (!Array.isArray(opts.prev.rotationKeys)) {
    throw new TypeError('buildPlcUpdateOp: prev.rotationKeys is malformed');
  }
  if (!opts.update || typeof opts.update !== 'object') {
    throw new TypeError('buildPlcUpdateOp: update is required');
  }
  if (typeof opts.update.signerPublicKey !== 'string' || opts.update.signerPublicKey === '') {
    throw new TypeError('buildPlcUpdateOp: update.signerPublicKey required');
  }
}

function defaultSerialise(body: Omit<PlcOperation, 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}
