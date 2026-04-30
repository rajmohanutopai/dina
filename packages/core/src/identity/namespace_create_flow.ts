/**
 * Namespace creation orchestrator (TN-IDENT-007).
 *
 * Plan §3.5.3 lays out a 7-step user flow:
 *   1. User taps "+ Add namespace" in the UI                  ← UI
 *   2. Mobile derives the next `m/9999'/4'/N'` keypair        ← here
 *   3. Mobile composes the PLC `assertionMethod` update       ← here
 *   4. Mobile signs the op with the rotation key              ← here
 *   5. Mobile POSTs the signed op to the PLC directory        ← here
 *   6. Mobile publishes `com.dina.trust.namespaceProfile`     ← caller
 *   7. UI confirms once AppView surfaces the profile record   ← caller
 *
 * This module owns steps 2–5 — the deterministic, runtime-agnostic
 * core. Steps 6–7 are caller responsibility: profile publish needs a
 * PDS client (out-of-scope wiring), and AppView polling is a UI
 * concern that consumes the result returned here.
 *
 * Why a thin orchestrator instead of letting callers compose the
 * pieces directly: the four lower-level primitives (`deriveNamespaceKey`,
 * `composeAndSignNamespaceUpdate`, `submitPlcOperation`) each have
 * their own input contracts, and a mistake at the seam (e.g. passing
 * the wrong slice of the 64-byte seed, swapping rotation public for
 * private key, or dropping the namespace public key on the floor)
 * silently breaks the audit chain. Wrapping the seam in one tested
 * call removes that hazard at every site that adds a namespace.
 *
 * Failure semantics:
 *   - Validation errors (bad seed, bad index, missing rotation key)
 *     surface synchronously as `Error`. Caller hasn't done any
 *     network I/O yet, no rollback needed.
 *   - PLC submission failures surface as `PLCSubmitError` (kind
 *     `client` for permanent rejection, `exhausted` for retry-budget
 *     burn-through, `invalid_input` for shape errors). Caller should
 *     NOT publish the namespaceProfile record on failure — per plan
 *     §3.5.3 the rollback is "no profile record published, no key
 *     exposed in the DID doc".
 */

import { deriveNamespaceKey } from '../crypto/slip0010';

import {
  composeAndSignNamespaceUpdate,
  type SignedNamespaceUpdate,
} from './plc_namespace_update';
import {
  submitPlcOperation,
  type SubmitPlcOperationConfig,
  type SubmitPlcOperationResult,
} from './plc_submit';

export interface CreateNamespaceFlowParams {
  /**
   * The user's `did:plc:xxxx` — used as the path on the PLC submit
   * endpoint. This is the same DID that signs everything in the
   * caller's identity tree.
   */
  did: string;

  /**
   * Master seed (64-byte BIP-39 PBKDF2 output OR 32-byte BIP-39
   * entropy — both work; matches whichever path the caller's
   * recovery uses, see TN-IDENT-010). The seed never leaves this
   * function; only the derived public key is exposed in the result.
   */
  masterSeed: Uint8Array;

  /**
   * Namespace index — the `N` in `namespace_<N>`. Caller picks based
   * on the lowest-unused index in their current PLC `verificationMethods`
   * map (e.g. if `namespace_0` and `namespace_2` exist, pass 1 or 3).
   * The composer rejects collisions, so racing UI taps fail loudly.
   */
  namespaceIndex: number;

  /**
   * 32-byte secp256k1 rotation private key (derived at `m/9999'/2'/<gen>'`).
   * Required because PLC update ops must be signed by a key listed in
   * the prior op's `rotationKeys` — no other key can mutate the
   * identity. Stays in the caller's hot memory only as long as the
   * orchestrator runs.
   */
  rotationPrivateKey: Uint8Array;

  /**
   * The full prior signed PLC operation, fetched from the PLC
   * directory's audit log. The composer reads `rotationKeys`,
   * `services`, `alsoKnownAs`, and `verificationMethods` from this
   * envelope and chains the update via its CID.
   */
  priorSignedOperation: Record<string, unknown>;

  /**
   * PLC submitter config — fetch + sleep injection + plcURL +
   * maxAttempts + backoffBaseMs. Pass-through to `submitPlcOperation`
   * so tests can drive both layers from one entry point.
   */
  submitConfig?: SubmitPlcOperationConfig;
}

export interface CreateNamespaceFlowResult {
  /** Index of the namespace just created. Echo of the input. */
  namespaceIndex: number;

  /** 32-byte Ed25519 public key of the new namespace. The caller
   *  publishes the namespaceProfile record signed by the matching
   *  private key — re-derive from the master seed at sign time,
   *  don't cache. */
  namespacePublicKey: Uint8Array;

  /** Verification-method fragment — `namespace_<N>`. The published
   *  DID document exposes this as `did:plc:xxxx#namespace_<N>`. */
  fragment: string;

  /** The full composer + signer return — caller passes this to an
   *  audit log, debug overlay, or UI state. */
  composed: SignedNamespaceUpdate;

  /** The PLC directory's response — status, body (or null), attempts. */
  submitted: SubmitPlcOperationResult;
}

/**
 * Run the creation flow's deterministic core (steps 2–5 of plan
 * §3.5.3). On success, the namespace is live in the user's DID
 * document and the caller may proceed to publish the profile
 * record + poll AppView.
 */
export async function createNamespace(
  params: CreateNamespaceFlowParams,
): Promise<CreateNamespaceFlowResult> {
  // Step 2 — derive the namespace keypair.
  // (`deriveNamespaceKey` validates the seed shape + rejects all-zero;
  // negative/non-integer index is rejected by the path parser.)
  const namespaceKey = deriveNamespaceKey(params.masterSeed, params.namespaceIndex);

  // Steps 3–4 — compose + sign the PLC update.
  // (`composeAndSignNamespaceUpdate` validates the pubkey shape +
  // fragment collision + prior-op shape; signs with the rotation key.)
  const composed = composeAndSignNamespaceUpdate({
    priorSignedOperation: params.priorSignedOperation,
    namespaceIndex: params.namespaceIndex,
    namespacePublicKey: namespaceKey.publicKey,
    rotationPrivateKey: params.rotationPrivateKey,
  });

  // Step 5 — submit to the PLC directory with bounded retry.
  // 4xx → permanent (caller fixes the input). 5xx + network → retried.
  const submitted = await submitPlcOperation(
    {
      did: params.did,
      signedOperation: composed.signedOperation,
    },
    params.submitConfig,
  );

  return {
    namespaceIndex: params.namespaceIndex,
    namespacePublicKey: namespaceKey.publicKey,
    fragment: composed.fragment,
    composed,
    submitted,
  };
}

/**
 * Determine the lowest-unused namespace index in a prior PLC op.
 *
 * Useful for "+ Add namespace" UX — the user taps a button and
 * doesn't pick the index. Returns 0 when no namespaces exist yet.
 *
 * Pure function — looks at `verificationMethods` keys matching the
 * `namespace_<N>` pattern and returns the smallest non-negative
 * integer not already taken. Treats malformed `namespace_xxx` keys
 * (e.g. `namespace_abc`) as if absent — they can't collide with a
 * numeric slot, so they don't affect index selection.
 */
export function nextAvailableNamespaceIndex(
  priorSignedOperation: Record<string, unknown>,
): number {
  const vms = priorSignedOperation.verificationMethods;
  if (!vms || typeof vms !== 'object') {
    // Malformed prior op — surface a 0 so the caller can decide what
    // to do. The composer will reject the malformed op anyway when
    // they try to use this index.
    return 0;
  }

  const taken = new Set<number>();
  for (const k of Object.keys(vms as Record<string, unknown>)) {
    const m = /^namespace_(\d+)$/.exec(k);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 0) taken.add(n);
    }
  }

  for (let i = 0; ; i++) {
    if (!taken.has(i)) return i;
  }
}
