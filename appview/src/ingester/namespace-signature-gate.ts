/**
 * Namespace-key signature gate (TN-ING-003 / Plan §3.5.1).
 *
 * Enforces the V1 namespace-publishing contract: a record carrying a
 * `namespace` fragment can only land in the AppView if the author's
 * DID document declares a `verificationMethod` with that exact
 * fragment id AND lists it as an `assertionMethod` (the W3C DID Core
 * key-purpose value for signing assertions / records).
 *
 * **Why this gate exists**: TN-DB-012 added the `namespace` column to
 * the `attestations` + `endorsements` tables. The Zod validator
 * (`record-validator.ts`) only bounds-checks the fragment length —
 * it can't reach the DID resolver without breaking the layering.
 * Without this gate, a hostile or buggy author could publish records
 * under arbitrary namespace strings, polluting the per-namespace
 * reviewer-stats table (TN-DB-002, TN-SCORE-001) and the search xRPC's
 * namespace-filtered ranking. The gate forces the namespace to be a
 * declared compartment of the author's identity — a record signed
 * under `#namespace_3` only counts when the author publicly declares
 * `#namespace_3` in their DID document.
 *
 * **Why we DON'T verify per-record commit signatures here**: Jetstream
 * events don't carry the AT Protocol commit-level signature. The
 * upstream PDS validates the commit signature when accepting the
 * record, and the resulting CID-anchored record is what flows
 * through Jetstream. The gate's V1 job is therefore "did the author
 * publicly declare this namespace as a signing compartment in their
 * DID doc?" — a necessary condition for namespace-bearing records to
 * be trusted. V2 (when AppView ingests raw commits via a sidecar
 * relay rather than Jetstream) extends this to per-commit signature
 * verification against the namespace's public key. The gate's
 * exported surface is forward-compatible — `verifyNamespaceSignature`
 * accepts a `commitSignature` parameter that V1 ignores and V2 will
 * use.
 *
 * **Two reject reasons** map cleanly onto the closed taxonomy from
 * `rejection-writer.ts`:
 *   - `namespace_disabled` — DID doc resolved cleanly, but the
 *     namespace fragment isn't declared (hostile / typo / revoked /
 *     never declared). Most common rejection path.
 *   - `signature_invalid` — DID doc fetch failed (transient PLC
 *     outage, network partition, malformed doc). The author's
 *     namespace COULD be valid; we fail closed because we can't
 *     prove it.
 *
 * **Records WITHOUT a namespace skip the gate** (V1 majority path):
 * root-identity records sign under the standard `signingKey` which
 * the upstream PDS already validates. The gate's only contract is
 * with namespace-bearing records.
 *
 * **The gate is observability-loud, hot-path-light**: a fresh DID
 * doc fetch is a network round-trip (~tens of milliseconds against
 * a healthy PLC); the cache (5-min TTL, 50k LRU bound — see
 * `did-doc-cache.ts`) makes the steady-state hit cost a Map lookup.
 * Per-call metrics fire on outcome (`pass`, `namespace_disabled`,
 * `signature_invalid`); fetch-tier latency is captured as a
 * histogram.
 *
 * **Side effects**: zero. Pure function over the inputs (after the
 * fetcher resolves). The gate decides; the dispatcher (in
 * `jetstream-consumer.ts`) is responsible for calling the rejection
 * writer + halting the pipeline. Keeping the decide / write
 * separation testable.
 */

import { logger as defaultLogger } from '@/shared/utils/logger.js'
import { metrics as defaultMetrics } from '@/shared/utils/metrics.js'
import type {
  DidDocCache,
  DIDDocument,
} from '@/shared/utils/did-doc-cache.js'

/**
 * The kind of fetcher the gate expects: a function that resolves a
 * DID to its current DID document. The actual implementation
 * (PLC HTTP client, did:web fetcher, etc.) is dependency-injected so
 * the gate can be unit-tested without HTTP, and so V2 can swap in a
 * different resolver without touching this module.
 */
export type DidDocFetcher = (did: string) => Promise<DIDDocument>

/**
 * Subset-of-HandlerContext shape — matches `RejectionContext` from
 * `rejection-writer.ts` so the dispatcher can hand the same context
 * object to the gate and to any downstream rejection writes. Logger
 * + metrics are required; the gate emits structured observability
 * regardless of pass/fail.
 */
export interface NamespaceGateContext {
  didDocCache: DidDocCache
  didResolver: DidDocFetcher
  logger?: typeof defaultLogger
  metrics?: typeof defaultMetrics
}

/**
 * Discriminated-union result. Callers that don't care about the
 * detail can branch on `ok`; callers that want to populate
 * `recordRejection`'s `detail` JSONB field reach into the failure
 * variant's `detail` object.
 */
export type NamespaceGateResult =
  | { ok: true }
  | {
      ok: false
      reason: 'namespace_disabled' | 'signature_invalid'
      detail: Record<string, unknown>
    }

/**
 * Sentinel for "no namespace was declared on this record". Records
 * without a namespace bypass the gate entirely (V1 root-identity
 * path). Callers SHOULD pass `null`/`undefined`/`""` for those rows;
 * the gate is forgiving and treats all three identically.
 */
function isNamespaceAbsent(namespace: string | null | undefined): boolean {
  return namespace == null || namespace.length === 0
}

/**
 * Build the canonical verificationMethod id for a (did, namespace)
 * pair. Per W3C DID Core §5.1.1 the id is the DID URL with the
 * fragment, e.g. `did:plc:abc#namespace_3`. The fragment in the
 * record is stored WITHOUT the `#` (see TN-DB-012's docstring) — the
 * gate adds the prefix on the fly.
 */
function expectedVerificationMethodId(did: string, namespace: string): string {
  return `${did}#${namespace}`
}

/**
 * Type guard for the verificationMethod entries in a DID document.
 * The cache stores DIDDocuments with `verificationMethod` as
 * `ReadonlyArray<unknown>` (intentionally loose at the cache layer
 * — see `did-doc-cache.ts`'s docstring) so we narrow here. A
 * malformed entry (missing `id`) is treated as "doesn't match"
 * rather than crashing the gate.
 */
function isVerificationMethodEntry(
  v: unknown,
): v is { id: string; type?: string; controller?: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    typeof (v as { id: unknown }).id === 'string'
  )
}

/**
 * Type guard for `assertionMethod` entries. Per DID Core §5.3.2 each
 * entry is EITHER a string (a reference to a verificationMethod id)
 * OR an embedded full verificationMethod object. The gate accepts
 * both forms — embedded VMs are equivalent to declared-then-referenced.
 */
function assertionMethodMatchesId(entry: unknown, vmId: string): boolean {
  if (typeof entry === 'string') return entry === vmId
  if (isVerificationMethodEntry(entry)) return entry.id === vmId
  return false
}

/**
 * Run the namespace-signature gate against a single record.
 *
 * The gate's contract:
 *   1. If the record has no namespace, return `{ok: true}` immediately
 *      — the V1 majority root-identity path doesn't go through this
 *      gate.
 *   2. Resolve the author's DID document via the cache. Cache misses
 *      hit the injected `didResolver`. Resolver errors translate to
 *      `signature_invalid` with the error message in `detail`.
 *   3. Look for a `verificationMethod` whose `id` is `did#namespace`.
 *      Missing → `namespace_disabled`.
 *   4. Verify the VM is referenced in `assertionMethod` (either as
 *      a bare string id OR an embedded VM object). Per W3C DID Core
 *      §5.3.2, only `assertionMethod` keys are valid for record
 *      signing. A VM declared without `assertionMethod` purpose is
 *      a key for some OTHER use (authentication, capability
 *      delegation, etc.) and must NOT be trusted as a record-signing
 *      key. Missing → `namespace_disabled`.
 *   5. Pass.
 *
 * **V2 extension**: when AppView starts ingesting raw commits via a
 * sidecar relay (rather than Jetstream's deserialized JSON), the
 * gate gains a `commitSignature: Uint8Array` parameter. V1 doesn't
 * declare the parameter — adding an unused parameter forces every
 * call site to pass `undefined`, paying readability cost for a
 * future shape that lives in a different code path. V2 adds the
 * parameter alongside the relay integration; V1 stays clean.
 */
export async function verifyNamespaceSignature(
  ctx: NamespaceGateContext,
  authorDid: string,
  namespace: string | null | undefined,
): Promise<NamespaceGateResult> {
  const log = ctx.logger ?? defaultLogger
  const m = ctx.metrics ?? defaultMetrics

  // Step 1: no namespace → instant pass. The vast majority of V1
  // records take this path; it's the hot-path optimisation.
  if (isNamespaceAbsent(namespace)) {
    m.incr('ingester.namespace_gate.skipped', { reason: 'no_namespace' })
    return { ok: true }
  }

  // After the absent-namespace short-circuit, `namespace` is
  // guaranteed non-empty string.
  const ns = namespace as string

  // Step 2: resolve the author's DID document. Cache hits are a Map
  // lookup; misses are network round-trips bounded by the resolver's
  // own timeout (typical PLC client: ~5s).
  let doc: DIDDocument
  try {
    doc = await ctx.didDocCache.getOrFetch(authorDid, ctx.didResolver)
  } catch (err) {
    // Resolver error is fail-CLOSED (signature_invalid). The author's
    // namespace MIGHT be valid; we fail because we can't prove it.
    // This is the right posture for a verification gate — accepting
    // unknown is worse than a false reject (which the upstream
    // outbox-watcher surfaces and the author can retry).
    const message = err instanceof Error ? err.message : String(err)
    log.warn(
      { did: authorDid, namespace: ns, err: message },
      'namespace-gate: DID doc resolution failed',
    )
    m.incr('ingester.namespace_gate.outcome', { outcome: 'signature_invalid' })
    return {
      ok: false,
      reason: 'signature_invalid',
      detail: { phase: 'did_resolution', did: authorDid, error: message },
    }
  }

  // Step 3: locate the verificationMethod by id. The doc's
  // `verificationMethod` array is intentionally loosely typed at the
  // cache layer (see `did-doc-cache.ts`); we narrow per-entry here.
  const vmId = expectedVerificationMethodId(authorDid, ns)
  const vmEntries = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : []
  const declaredVm = vmEntries.find(
    (v) => isVerificationMethodEntry(v) && v.id === vmId,
  )
  if (!declaredVm) {
    log.info(
      { did: authorDid, namespace: ns, vmId },
      'namespace-gate: namespace not declared in DID document',
    )
    m.incr('ingester.namespace_gate.outcome', { outcome: 'namespace_disabled' })
    return {
      ok: false,
      reason: 'namespace_disabled',
      detail: {
        phase: 'verification_method_missing',
        did: authorDid,
        namespace: ns,
        expected_vm_id: vmId,
      },
    }
  }

  // Step 4: confirm `assertionMethod` purpose. A VM declared without
  // `assertionMethod` is for some other key purpose (authentication,
  // capability delegation) and must NOT be trusted as a record-signing
  // key. Per DID Core §5.3.2 the entry can be a bare string id OR an
  // embedded VM object — both forms count.
  const assertionEntries = Array.isArray(doc.assertionMethod) ? doc.assertionMethod : []
  const isAssertion = assertionEntries.some((entry) =>
    assertionMethodMatchesId(entry, vmId),
  )
  if (!isAssertion) {
    log.info(
      { did: authorDid, namespace: ns, vmId },
      'namespace-gate: namespace VM not authorized for assertion',
    )
    m.incr('ingester.namespace_gate.outcome', { outcome: 'namespace_disabled' })
    return {
      ok: false,
      reason: 'namespace_disabled',
      detail: {
        phase: 'assertion_method_missing',
        did: authorDid,
        namespace: ns,
        expected_vm_id: vmId,
      },
    }
  }

  // Step 5: pass. V2 will perform signature-bytes verification here
  // against `declaredVm.publicKeyMultibase` (or whichever key
  // material the doc declares); V1 trusts the upstream PDS commit
  // signature and only verifies the namespace was declared.
  m.incr('ingester.namespace_gate.outcome', { outcome: 'pass' })
  return { ok: true }
}
