/**
 * Task 6.8 — Verify PLC signature chain.
 *
 * A `did:plc:*` identifier's authoritative state lives in the PLC
 * directory as an append-only chain of operations. Each operation:
 *
 *   - References the CID of the previous op (or null for genesis).
 *   - Declares the identity's current rotation-key set + verification
 *     methods + service endpoints.
 *   - Is signed by ONE of the PREVIOUS op's rotation keys (for
 *     updates) or by the genesis op's own declared rotation key
 *     (the self-signing genesis case).
 *
 * **Verification rules** this module enforces (pinned by tests):
 *
 *   1. **Shape**: each op has `{sig, prev, rotationKeys[], ...}`.
 *   2. **Genesis**: op[0]'s `prev === null` and is signed by one of
 *      its own `rotationKeys`.
 *   3. **Chain linking**: op[i]'s `prev === cid(op[i-1])` for all
 *      i > 0.
 *   4. **Signer authority**: op[i] (i > 0) must be signed by a key
 *      that appears in op[i-1]'s `rotationKeys`.
 *   5. **Monotonic timestamps**: op[i].createdAtMs must be >=
 *      op[i-1].createdAtMs. Simultaneous ops are allowed (two
 *      rotations approved in the same ms).
 *
 * **Deterministic + pure**: the cryptographic primitives (CID +
 * signature verification) are INJECTED via `cidFn` and `verifyFn`.
 * This module orchestrates them + enforces the chain invariants.
 * Tests pass scripted cid / verify stubs + exercise the full
 * validation tree without real crypto.
 *
 * **Error taxonomy** gives an exact operation index + reason so
 * observability can flag which op in a malicious chain rebase
 * attempts to forge.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6c task 6.8.
 */

/** A single PLC operation — field shape matches the plc.directory JSON. */
export interface PlcOperation {
  /** Base64 / multibase signature over the op body (without `sig`). */
  sig: string;
  /** CID of the previous op in this chain, or null for genesis. */
  prev: string | null;
  /** Rotation keys permitted to sign the NEXT op. `publicKeyMultibase` strings. */
  rotationKeys: string[];
  /** UTC ms when the op was signed. */
  createdAtMs: number;
  /** Remaining op body (verification methods, services, handles). Kept opaque. */
  [key: string]: unknown;
}

export interface VerifyFnInput {
  /** Canonical op bytes without the `sig` field — what was signed. */
  messageBytes: Uint8Array;
  /** The signature from the op's `sig` field. */
  signature: string;
  /** One of the candidate rotation keys from the previous op. */
  publicKey: string;
}

/** Compute the CID of an op. Production: CBOR + SHA-256 + multibase. */
export type CidFn = (op: PlcOperation) => Promise<string>;

/** Verify a signature. Returns true when the message + sig + key match. */
export type VerifyFn = (input: VerifyFnInput) => Promise<boolean>;

/** Serialise an op to the canonical signed-bytes form. */
export type SerialiseOpFn = (op: PlcOperation) => Uint8Array;

export interface VerifyPlcChainOptions {
  cidFn: CidFn;
  verifyFn: VerifyFn;
  /** Canonical serialiser. Defaults to JSON without the `sig` field. */
  serialiseFn?: SerialiseOpFn;
}

export type PlcChainVerifyResult =
  | { ok: true; headCid: string; opCount: number }
  | { ok: false; reason: PlcChainVerifyFailure; opIndex: number; detail?: string };

export type PlcChainVerifyFailure =
  | 'empty_chain'
  | 'malformed_op'
  | 'genesis_prev_not_null'
  | 'genesis_sig_invalid'
  | 'prev_mismatch'
  | 'signer_not_authorised'
  | 'sig_invalid'
  | 'timestamp_regression';

/**
 * Verify a PLC operation chain. Returns `{ok: true, headCid,
 * opCount}` when every invariant holds, or a structured rejection
 * with the exact failing op index.
 *
 * The caller passes the chain in chronological order (genesis first).
 * The verifier does NOT reorder ops — it assumes `ops[0]` is the
 * genesis op and `ops[n-1]` is the current head.
 */
export async function verifyPlcChain(
  ops: ReadonlyArray<PlcOperation>,
  opts: VerifyPlcChainOptions,
): Promise<PlcChainVerifyResult> {
  if (typeof opts?.cidFn !== 'function') {
    throw new TypeError('verifyPlcChain: cidFn is required');
  }
  if (typeof opts.verifyFn !== 'function') {
    throw new TypeError('verifyPlcChain: verifyFn is required');
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, reason: 'empty_chain', opIndex: 0 };
  }
  const serialiseFn = opts.serialiseFn ?? defaultSerialise;
  const cidFn = opts.cidFn;
  const verifyFn = opts.verifyFn;

  // Validate shape for every op up-front — cheap + catches obviously
  // malformed chains before spending crypto cycles.
  for (let i = 0; i < ops.length; i++) {
    const shapeError = validateShape(ops[i]!);
    if (shapeError !== null) {
      return {
        ok: false,
        reason: 'malformed_op',
        opIndex: i,
        detail: shapeError,
      };
    }
  }

  // Genesis: prev must be null.
  const genesis = ops[0]!;
  if (genesis.prev !== null) {
    return {
      ok: false,
      reason: 'genesis_prev_not_null',
      opIndex: 0,
      detail: `genesis.prev must be null (got ${JSON.stringify(genesis.prev)})`,
    };
  }

  // Genesis is self-signed: one of its own rotationKeys must verify
  // the signature.
  const genesisBytes = serialiseFn(genesis);
  const genesisOk = await anyKeyVerifies(
    verifyFn,
    genesisBytes,
    genesis.sig,
    genesis.rotationKeys,
  );
  if (!genesisOk) {
    return {
      ok: false,
      reason: 'genesis_sig_invalid',
      opIndex: 0,
      detail: 'no rotationKey verified the genesis signature',
    };
  }

  // Walk the chain.
  let prevCid = await cidFn(genesis);
  let prevRotationKeys = genesis.rotationKeys;
  let prevTimestamp = genesis.createdAtMs;

  for (let i = 1; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.prev !== prevCid) {
      return {
        ok: false,
        reason: 'prev_mismatch',
        opIndex: i,
        detail: `op.prev "${String(op.prev)}" does not match previous CID "${prevCid}"`,
      };
    }
    if (op.createdAtMs < prevTimestamp) {
      return {
        ok: false,
        reason: 'timestamp_regression',
        opIndex: i,
        detail: `op.createdAtMs ${op.createdAtMs} < previous ${prevTimestamp}`,
      };
    }
    const messageBytes = serialiseFn(op);
    const signerOk = await anyKeyVerifies(
      verifyFn,
      messageBytes,
      op.sig,
      prevRotationKeys,
    );
    if (!signerOk) {
      return {
        ok: false,
        reason: 'signer_not_authorised',
        opIndex: i,
        detail: 'no previous rotation key verified this op',
      };
    }
    prevCid = await cidFn(op);
    prevRotationKeys = op.rotationKeys;
    prevTimestamp = op.createdAtMs;
  }

  return { ok: true, headCid: prevCid, opCount: ops.length };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateShape(op: unknown): string | null {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return 'op must be an object';
  }
  const o = op as Record<string, unknown>;
  if (typeof o.sig !== 'string' || o.sig === '') {
    return 'op.sig must be a non-empty string';
  }
  if (o.prev !== null && (typeof o.prev !== 'string' || o.prev === '')) {
    return 'op.prev must be null or a non-empty string';
  }
  if (!Array.isArray(o.rotationKeys) || o.rotationKeys.length === 0) {
    return 'op.rotationKeys must be a non-empty array';
  }
  for (const k of o.rotationKeys) {
    if (typeof k !== 'string' || k === '') {
      return 'op.rotationKeys entries must be non-empty strings';
    }
  }
  if (
    typeof o.createdAtMs !== 'number' ||
    !Number.isInteger(o.createdAtMs) ||
    o.createdAtMs < 0
  ) {
    return 'op.createdAtMs must be a non-negative integer';
  }
  return null;
}

async function anyKeyVerifies(
  verifyFn: VerifyFn,
  messageBytes: Uint8Array,
  signature: string,
  candidateKeys: readonly string[],
): Promise<boolean> {
  for (const key of candidateKeys) {
    try {
      if (await verifyFn({ messageBytes, signature, publicKey: key })) {
        return true;
      }
    } catch {
      // Key-specific verification errors (e.g. unsupported algorithm)
      // don't invalidate other candidates; just skip.
    }
  }
  return false;
}

/**
 * Default op-to-bytes serialiser: JSON-stringify the op without its
 * `sig` field. Production would use CBOR; injecting a custom
 * `serialiseFn` replaces this. Kept simple so this module works
 * end-to-end in tests that don't need true canonical CBOR.
 */
function defaultSerialise(op: PlcOperation): Uint8Array {
  const { sig: _sig, ...rest } = op;
  return new TextEncoder().encode(JSON.stringify(rest));
}
