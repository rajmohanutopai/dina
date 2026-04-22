/**
 * Task 4.59 — PLC startup drift check.
 *
 * At boot the Home Node resolves its own DID from the PLC directory
 * and compares the resolved signing key against the key we'd derive
 * from the local master seed. If they don't match, ONE of these
 * three bad things happened:
 *
 *   1. Master seed corrupted or rotated locally without a PLC update.
 *   2. Someone executed a PLC update with a different rotation key
 *      and changed our signing key (attack OR admin mistake).
 *   3. The PLC directory returned a different record than we expect
 *      (wrong plcURL, proxy rewriting, transient inconsistency).
 *
 * In all three cases we must NOT boot — continuing would produce a
 * Home Node that signs requests with a key the wider network
 * considers invalid for our DID. The Go side `log.Fatalf`s at this
 * point; the Lite side throws a `PlcProbeError` that `boot.ts` turns
 * into a loud-crash exit.
 *
 * **This is NOT a general DID verifier** — it's specifically the
 * "the key I'm about to sign with matches the key the network
 * knows about" startup-invariance probe. Much narrower than
 * full DID-doc verification.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.59.
 */

import { publicKeyToMultibase } from '@dina/core';

export type PlcProbeRejection =
  | 'not_found'
  | 'network_error'
  | 'malformed_doc'
  | 'missing_verification_method'
  | 'key_mismatch';

export interface PlcProbeErrorDetail {
  reason: PlcProbeRejection;
  did: string;
  /** Human-readable rendering (never includes private key material). */
  message: string;
  /** Optional upstream cause text (HTTP status, exception message). */
  cause?: string;
  /** When `reason === 'key_mismatch'`, the local vs remote pubs as did:key. */
  local?: string;
  remote?: string;
}

export class PlcProbeError extends Error {
  readonly detail: PlcProbeErrorDetail;
  constructor(detail: PlcProbeErrorDetail) {
    super(detail.message);
    this.name = 'PlcProbeError';
    this.detail = detail;
  }
}

export interface PlcProbeInput {
  /** The DID to resolve (the Home Node's `did:plc:…`). */
  did: string;
  /**
   * The Ed25519 public key we're about to sign with. This is the
   * local-side source of truth; we assert the PLC directory's record
   * matches.
   */
  expectedSigningPub: Uint8Array;
  /**
   * Function that resolves a DID to its current doc. Production wires
   * `@dina/core.resolveDIDPLC`. Tests pass a scripted resolver.
   */
  resolveFn: (did: string) => Promise<unknown>;
  /**
   * Verification-method fragment id to inspect. Default `dina_signing`
   * (task 4.57's fragment). Callers that want to verify a distinct
   * messaging key can override.
   */
  verificationMethodId?: string;
}

export type PlcProbeResult = { ok: true } | { ok: false; detail: PlcProbeErrorDetail };

const DEFAULT_VM_ID = 'dina_signing';

/**
 * Run the startup drift check. Never throws on ok-or-rejection —
 * caller pattern-matches on `result.ok`. Reserved for wrapping in
 * `throw new PlcProbeError(...)` where loud-crash is desired.
 */
export async function plcProbe(input: PlcProbeInput): Promise<PlcProbeResult> {
  const { did, expectedSigningPub, resolveFn } = input;
  const vmId = input.verificationMethodId ?? DEFAULT_VM_ID;

  if (!did || !did.startsWith('did:')) {
    return {
      ok: false,
      detail: {
        reason: 'not_found',
        did,
        message: `plcProbe: invalid did ${JSON.stringify(did)}`,
      },
    };
  }
  if (!expectedSigningPub || expectedSigningPub.length !== 32) {
    return {
      ok: false,
      detail: {
        reason: 'key_mismatch',
        did,
        message: 'plcProbe: expectedSigningPub must be 32 bytes',
      },
    };
  }

  let resolved: unknown;
  try {
    resolved = await resolveFn(did);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "DID doesn't exist" (404) from real network problems.
    const reason: PlcProbeRejection = /404|not ?found/i.test(msg)
      ? 'not_found'
      : 'network_error';
    return {
      ok: false,
      detail: {
        reason,
        did,
        message: `plcProbe: ${reason} — ${msg}`,
        cause: msg,
      },
    };
  }

  if (resolved === null || typeof resolved !== 'object') {
    return {
      ok: false,
      detail: {
        reason: 'malformed_doc',
        did,
        message: 'plcProbe: resolved response is not a JSON object',
      },
    };
  }

  const remotePub = extractVerificationMethodPublicKey(
    resolved as Record<string, unknown>,
    did,
    vmId,
  );
  if (remotePub === null) {
    return {
      ok: false,
      detail: {
        reason: 'missing_verification_method',
        did,
        message: `plcProbe: DID doc has no verification method matching fragment ${JSON.stringify(vmId)}`,
      },
    };
  }

  // Compare via canonical multibase — byte-level compare works too,
  // but multibase strings are what humans see in error messages.
  const localMultibase = publicKeyToMultibase(expectedSigningPub);
  const remoteMultibase = publicKeyToMultibase(remotePub);
  if (localMultibase !== remoteMultibase) {
    return {
      ok: false,
      detail: {
        reason: 'key_mismatch',
        did,
        local: `did:key:${localMultibase}`,
        remote: `did:key:${remoteMultibase}`,
        message: `plcProbe: signing key mismatch — local ${localMultibase} vs remote ${remoteMultibase}`,
      },
    };
  }

  return { ok: true };
}

/**
 * Throwing variant — boot integration. Wraps `plcProbe` and converts
 * `{ok: false}` into a throw so `main.ts` can just `await plcProbeOrThrow(...)`
 * and let the error propagate to the crash-log + process-exit path.
 */
export async function plcProbeOrThrow(input: PlcProbeInput): Promise<void> {
  const result = await plcProbe(input);
  if (!result.ok) throw new PlcProbeError(result.detail);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the raw Ed25519 public key bytes from a DID doc's
 * verification method whose id ends with `#<vmId>`. Returns null if
 * not found or malformed.
 *
 * PLC directory responses nest verification methods differently from
 * the classic W3C shape; we handle BOTH:
 *   a) `verificationMethod: [{id, type: "Multikey", publicKeyMultibase}]`
 *   b) `verificationMethods: {dina_signing: "did:key:z..."}` (PLC flat form)
 */
function extractVerificationMethodPublicKey(
  doc: Record<string, unknown>,
  did: string,
  vmId: string,
): Uint8Array | null {
  const fullId = `${did}#${vmId}`;

  // Shape (a) — W3C classic array.
  const vms = doc['verificationMethod'];
  if (Array.isArray(vms)) {
    for (const vm of vms) {
      if (vm === null || typeof vm !== 'object') continue;
      const v = vm as Record<string, unknown>;
      if (v['id'] !== fullId && v['id'] !== `#${vmId}`) continue;
      const mb = v['publicKeyMultibase'];
      if (typeof mb !== 'string') continue;
      return multibaseToPublicKey(mb);
    }
  }

  // Shape (b) — PLC flat object map.
  const vmsFlat = doc['verificationMethods'];
  if (vmsFlat !== null && typeof vmsFlat === 'object') {
    const map = vmsFlat as Record<string, unknown>;
    const didKey = map[vmId];
    if (typeof didKey === 'string' && didKey.startsWith('did:key:')) {
      return multibaseToPublicKey(didKey.slice('did:key:'.length));
    }
  }

  return null;
}

/**
 * Decode an Ed25519 multibase did:key value to raw 32-byte bytes.
 * Returns null on any failure — callers treat as "missing VM".
 *
 * Ed25519 did:key: `z` + base58(0xed 0x01 + 32 raw bytes).
 */
function multibaseToPublicKey(mb: string): Uint8Array | null {
  if (!mb || mb[0] !== 'z') return null;
  // We don't have a base58 decoder imported — use the one in @dina/core's
  // transitive deps. `@scure/base` is already pulled in by directory.ts.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { base58 } = require('@scure/base') as typeof import('@scure/base');
    const decoded = base58.decode(mb.slice(1));
    // Ed25519 multicodec prefix: 0xed 0x01
    if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
      return null;
    }
    return decoded.slice(2);
  } catch {
    return null;
  }
}
