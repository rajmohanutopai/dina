/**
 * The pinned plugin task envelope — PLUGIN_ARCHITECTURE.md §9.1.
 *
 * A plugin invocation's payload carries the identity and consent fields
 * IMMUTABLY, set at enqueue: the six claim-time checks verify against
 * them, and without them persisted on the task the stale-authority
 * guard is unimplementable. `attempt` is the deliberate exception — it
 * lives as a COLUMN (advances per claim), never in the payload.
 *
 * `action_class` and `effects_idempotency` are pinned here too so the
 * lease-expiry sweeper and the cancellation path can classify a task
 * (effectful? retryable?) without a registry lookup — the payload is
 * the task's own frozen authority, exactly like `schema_snapshot` in
 * the service pipeline.
 *
 * Retry contract (§9.1): once a runner task has been CLAIMED it is
 * never automatically re-dispatched — any capability, any declared
 * class — unless the capability declared `effects.idempotency:
 * "supported"`. Even then the budget is bounded: ≤ MAX_ATTEMPTS inside
 * RETRY_WINDOW_MS from first dispatch, exponential backoff. Budget
 * exhaustion without a terminal report ends like any vanished
 * execution: `outcome_unknown` if declared-effectful, `failed`
 * otherwise.
 */

import { hasUnsafeText } from '@dina/protocol';

export const PLUGIN_INVOCATION_PAYLOAD_TYPE = 'plugin_invocation';

/**
 * PLG-29 #14: envelope identity / hash / key fields are pinned AUTHORITY — they
 * flow into SQL rows, owner-facing receipts, logs, and lane routing. The old
 * parser only tested "nonempty string", so a faulty producer could pin an
 * oversized or spoofing identifier and have it ride to the runner + receipt.
 * Bound the length and reject control/bidi/zero-width chars on every such field.
 */
const MAX_ENVELOPE_STRING_LENGTH = 256;

/** PLG-29 #14: `action_class` is a fixed catalog enum, not free text. */
const VALID_ACTION_CLASSES: ReadonlySet<string> = new Set([
  'read',
  'quote',
  'write',
  'booking',
  'payment',
  'agentic',
]);

/**
 * PLG-29 #13: cap `schema_snapshot` nesting + size. The claim guard canonicalizes
 * it (`canonicalJson(envelope.schema_snapshot)`) inside a catch-free loop, so a
 * deeply-nested or huge snapshot would throw there — leaving the task claimed
 * until lease recovery and repeatedly breaking claims. Bounding it here
 * quarantines the whole envelope at parse (→ a clean terminalize) instead.
 */
const MAX_SCHEMA_SNAPSHOT_DEPTH = 32;
const MAX_SCHEMA_SNAPSHOT_BYTES = 128 * 1024;

/** A bounded, non-empty, spoof-free identity/hash/key string (PLG-29 #14). */
function isBoundedIdentityString(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_ENVELOPE_STRING_LENGTH &&
    !hasUnsafeText(v)
  );
}

/** True if `value` nests deeper than `max` (PLG-29 #13 — bounded recursion). */
function exceedsDepth(value: unknown, max: number, depth = 0): boolean {
  if (depth > max) return true;
  if (value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    if (exceedsDepth(child, max, depth + 1)) return true;
  }
  return false;
}

/** Core-owned retry budget (§9.1; constants tunable, §21 decision 11). */
export const PLUGIN_RETRY = Object.freeze({
  /** Total claims a single logical execution may consume. */
  MAX_ATTEMPTS: 3,
  /** Window from FIRST dispatch inside which retries may run. */
  RETRY_WINDOW_MS: 24 * 60 * 60 * 1000,
  /** Exponential backoff base: delay = BACKOFF_BASE_MS * 2^(attempt-1). */
  BACKOFF_BASE_MS: 30_000,
} as const);

/** Declared-effectful classes — the outcome_unknown classification key
 * (§9.5). NOTE: classification only; retry safety trusts NO declared
 * class (§9.1). Round-9 #8: `payment` MUST be here — a lost/revoked payment
 * lease has to classify as outcome_unknown (money MAY have moved), never the
 * quietly-safe `failed`. Omitting it hid the possibility that funds moved. */
const EFFECTFUL_CLASSES = new Set(['booking', 'write', 'agentic', 'payment']);

export interface PluginTaskEnvelope {
  readonly type: typeof PLUGIN_INVOCATION_PAYLOAD_TYPE;
  readonly install_id: string;
  readonly capability_id: string;
  /** Owner-derived free text — egress-gated before enqueue (§11.5). */
  readonly params: unknown;
  /** Scrubbed, projected context (§11.3). */
  readonly context: unknown;
  readonly manifest_cid: string;
  /**
   * §9.13 — the protocol version the manifest at `manifest_cid` declared.
   *
   * OPTIONAL, and only set on a lifecycle CONTINUATION across a major. The
   * envelope already carried which CID authorized the work and said nothing
   * about which CONTRACT it speaks, so a runner answering a prior major's
   * order could not tell it was doing so — it saw the current lane and the
   * current adapter. A runner that understands one major can now refuse work
   * addressed to another rather than answering it wrongly.
   */
  readonly prior_version?: string;
  readonly approved_scope_hash: string;
  /** Pinned result schema — completion validates against THIS. */
  readonly schema_snapshot: unknown;
  /** Config revision the approval was granted under (claim check six). */
  readonly config_revision: number;
  /** Stable across attempts — the logical execution. */
  readonly execution_id: string;
  /** Stable across attempts — the provider dedup key. */
  readonly idempotency_key: string;
  /** Pinned classification inputs (see module doc). */
  readonly action_class: string;
  readonly effects_idempotency: 'supported' | 'unsupported';
  /**
   * Round-12 #2/#3/#6: the authorization PROVENANCE of this invocation, set by
   * the dispatch producer at enqueue. `'grant'` = authorized by a standing/once
   * grant (the claim guard then requires the EXACT `grant_id` to still be live
   * — a task authorized by grant A cannot ride a different live grant B for the
   * same scope, and an unavailable grant repo fails the claim CLOSED). `'card'`
   * = per-invocation owner approval (no grant to re-verify). Absent = legacy /
   * not-yet-stamped: the claim guard applies no grant check (no false-positive
   * terminalize on a scope with a tombstoned grant row). Optional so existing
   * envelopes and non-producer callers parse unchanged.
   */
  readonly authorization_kind?: 'grant' | 'card';
  /** The exact grant this invocation consumed (present iff authorization_kind
   *  === 'grant'). The claim guard validates THIS grant's liveness + scope. */
  readonly grant_id?: string;
  /**
   * Round-12 #1: a digest binding the FULL constraint-relevant invocation
   * (params + context + resource + value), so a lease-recovery retry replaying
   * the same execution_id must replay the same invocation — a retry that changes
   * recipient/date/body/SKU/account is a DISTINCT invocation, not a retry. The
   * producer pins the same digest it passed to `authorizeAndConsume`.
   */
  readonly invocation_digest?: string;
  /**
   * PLG-29 #4: the resource tag + declared value this invocation was authorized
   * for. Grant-authorization artifacts (present iff authorization_kind ===
   * 'grant'), pinned by the producer so the claim guard can RECOMPUTE the
   * invocation digest from the envelope's own Core-owned fields — rather than
   * trusting the producer-supplied `invocation_digest`. That binds the actual
   * dispatched invocation to the one charged against the grant, closing the
   * consume-A-dispatch-B gap.
   */
  readonly resource?: string;
  readonly value?: number;
  /**
   * Provider-ingress correlation (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md
   * §11.2a): present ONLY on tasks created from an inbound D2D service
   * query. Presence switches the claim guard's consented-kind check to
   * `provider` (a provider task can never ride a `tool` consent, nor the
   * reverse) and lets the response bridge answer the querying peer when
   * the runner completes. `schema_snapshot` here is the PUBLISHED service
   * schema the requester saw — distinct from the envelope-level
   * `schema_snapshot`, which pins the plugin capability's result schema.
   */
  readonly service_ingress?: {
    readonly from_did: string;
    readonly query_id: string;
    readonly capability: string;
    readonly service_rkey: string;
    readonly ttl_seconds?: number;
    readonly service_name?: string;
    readonly schema_snapshot?: {
      readonly params: Record<string, unknown>;
      readonly result: Record<string, unknown>;
      readonly schema_hash: string;
    };
  };
  /**
   * §3.4 — the VERIFIED result of a host operation this runner proposed.
   *
   * "the next claim for that workflow delivers the validated result ... a
   * runner cannot fabricate a result it was never handed". This block is how
   * that delivery happens, and it is a distinct field from `params` for two
   * reasons. It is not owner data, so it must not ride the field the egress
   * gate and the consented `params_schema` govern; and its provenance is
   * Core's own broker, so a runner reading it is reading something it could
   * not have written.
   *
   * `state` is the proposal's terminal state, carried verbatim: a runner that
   * saw only `result` could not tell a refusal from a failure from an effect
   * whose outcome nobody knows, and those three lead it to opposite next
   * steps.
   */
  readonly host_operation?: {
    readonly proposal_id: string;
    readonly operation_name: string;
    readonly state: 'completed' | 'failed' | 'refused' | 'outcome_unknown';
    /** Present only on `completed` — the schema-verified result. */
    readonly result?: unknown;
    /** Present on every non-completed state. */
    readonly detail?: string;
  };
}

/** Round-15 #7: the EXACT top-level key set a plugin envelope may carry. Any
 *  other top-level key quarantines the whole envelope (fail closed). */
const KNOWN_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'install_id',
  'capability_id',
  'params',
  'context',
  'manifest_cid',
  // §9.13 — optional, and only on a lifecycle continuation across a major.
  // The key set is EXACT and fails closed, so a field added to the interface
  // and not to this list quarantines every envelope carrying it.
  'prior_version',
  'approved_scope_hash',
  'schema_snapshot',
  'config_revision',
  'execution_id',
  'idempotency_key',
  'action_class',
  'effects_idempotency',
  'authorization_kind',
  'grant_id',
  'invocation_digest',
  // PLG-29 #4: grant-authorization artifacts for the claim-time digest recompute.
  'resource',
  'value',
  // §11.2a provider-ingress correlation block.
  'service_ingress',
  // §3.4 verified host-operation result, delivered to the next claim.
  'host_operation',
]);

/**
 * Parse a task payload as a plugin envelope. Returns null for
 * non-plugin payloads and for malformed plugin payloads — a malformed
 * envelope must never be treated as a plugin task with defaults; the
 * caller treats null-with-plugin-lane as a hard integrity error.
 */
export function parsePluginEnvelope(payload: string): PluginTaskEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.type !== PLUGIN_INVOCATION_PAYLOAD_TYPE) return null;
  // Round-15 #7: fail closed on UNKNOWN top-level keys. The delivered wire
  // artifact is the raw payload string, and the claim guard only inspects
  // `params`/`context` for scope/size — so a faulty producer that stamped an
  // extra top-level field (unbounded/sensitive data) would smuggle it past
  // inspection straight to the external runner. Every other pinned field is
  // re-derived defensively; this closes the one missing member of that set.
  for (const k of Object.keys(p)) {
    if (!KNOWN_ENVELOPE_FIELDS.has(k)) return null;
  }
  // PLG-29 #14: every pinned identity/hash/key field is bounded + spoof-free
  // (was: any nonempty string). `action_class` must be a catalog enum member.
  if (
    !isBoundedIdentityString(p.install_id) ||
    !isBoundedIdentityString(p.capability_id) ||
    !isBoundedIdentityString(p.manifest_cid) ||
    !isBoundedIdentityString(p.approved_scope_hash) ||
    typeof p.config_revision !== 'number' ||
    !Number.isInteger(p.config_revision) ||
    !isBoundedIdentityString(p.execution_id) ||
    !isBoundedIdentityString(p.idempotency_key) ||
    typeof p.action_class !== 'string' ||
    !VALID_ACTION_CLASSES.has(p.action_class) ||
    (p.effects_idempotency !== 'supported' && p.effects_idempotency !== 'unsupported')
  ) {
    return null;
  }
  // PLG-29 #13: reject a schema_snapshot too deep / large to canonicalize safely,
  // so the claim guard's catch-free `canonicalJson(schema_snapshot)` can never
  // overflow the stack mid-loop and strand the task claimed.
  if (p.schema_snapshot !== undefined && p.schema_snapshot !== null) {
    if (exceedsDepth(p.schema_snapshot, MAX_SCHEMA_SNAPSHOT_DEPTH)) return null;
    let snapshotBytes: number;
    try {
      // PLG-30 #16: count ENCODED UTF-8 bytes, not UTF-16 code units. `String
      // .length` under-counts non-ASCII (CJK = 1 unit / 3 bytes), so the 128 KB
      // cap could pass a ~384 KB snapshot. Match the params/context/result byte
      // bounds in dispatch.ts, which already use TextEncoder.
      snapshotBytes = new TextEncoder().encode(JSON.stringify(p.schema_snapshot) ?? '').length;
    } catch {
      return null; // non-serializable (cycle) → cannot canonicalize
    }
    if (snapshotBytes > MAX_SCHEMA_SNAPSHOT_BYTES) return null;
  }
  // Round-12 #2/#3/#6/#1: the optional authorization-provenance fields, when
  // present, must be well-formed — a malformed value must quarantine the whole
  // envelope (null), never be trusted as authority by the claim guard.
  // PLG-29 #14: grant_id / invocation_digest are bounded + spoof-free like every
  // other identity field. PLG-29 #4: resource (bounded string) + value (finite
  // number) are the recompute inputs the claim guard hashes.
  if (
    (p.authorization_kind !== undefined &&
      p.authorization_kind !== 'grant' &&
      p.authorization_kind !== 'card') ||
    (p.grant_id !== undefined && !isBoundedIdentityString(p.grant_id)) ||
    (p.invocation_digest !== undefined && !isBoundedIdentityString(p.invocation_digest)) ||
    (p.resource !== undefined && !isBoundedIdentityString(p.resource)) ||
    (p.value !== undefined && (typeof p.value !== 'number' || !Number.isFinite(p.value)))
  ) {
    return null;
  }
  // §11.2a service_ingress: when present, every identity field must be
  // well-formed — malformed correlation quarantines the whole envelope
  // (a task the bridge cannot answer must never dispatch).
  if (p.service_ingress !== undefined) {
    const si = p.service_ingress;
    if (si === null || typeof si !== 'object' || Array.isArray(si)) return null;
    const ingress = si as Record<string, unknown>;
    const KNOWN_INGRESS_FIELDS = new Set([
      'from_did',
      'query_id',
      'capability',
      'service_rkey',
      'ttl_seconds',
      'service_name',
      'schema_snapshot',
    ]);
    for (const k of Object.keys(ingress)) {
      if (!KNOWN_INGRESS_FIELDS.has(k)) return null;
    }
    if (
      !isBoundedIdentityString(ingress.from_did) ||
      !isBoundedIdentityString(ingress.query_id) ||
      !isBoundedIdentityString(ingress.capability) ||
      !isBoundedIdentityString(ingress.service_rkey) ||
      (ingress.ttl_seconds !== undefined &&
        (typeof ingress.ttl_seconds !== 'number' ||
          !Number.isInteger(ingress.ttl_seconds) ||
          ingress.ttl_seconds < 1 ||
          ingress.ttl_seconds > 86400)) ||
      (ingress.service_name !== undefined &&
        (typeof ingress.service_name !== 'string' || ingress.service_name.length > 256))
    ) {
      return null;
    }
    // The published-service schema snapshot is narrowed with the same
    // rigor as its envelope-level sibling: exact inner key set, plain
    // objects only, bounded hash string, and the shared depth/byte
    // caps — an over-wide block is a smuggling channel straight past
    // params/context inspection.
    if (ingress.schema_snapshot !== undefined) {
      const snap = ingress.schema_snapshot;
      if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) return null;
      const snapRecord = snap as Record<string, unknown>;
      const KNOWN_SNAPSHOT_FIELDS = new Set(['params', 'result', 'schema_hash']);
      for (const k of Object.keys(snapRecord)) {
        if (!KNOWN_SNAPSHOT_FIELDS.has(k)) return null;
      }
      if (
        snapRecord.params === null ||
        typeof snapRecord.params !== 'object' ||
        Array.isArray(snapRecord.params) ||
        snapRecord.result === null ||
        typeof snapRecord.result !== 'object' ||
        Array.isArray(snapRecord.result) ||
        typeof snapRecord.schema_hash !== 'string' ||
        snapRecord.schema_hash.length === 0 ||
        snapRecord.schema_hash.length > 128
      ) {
        return null;
      }
      if (exceedsDepth(snapRecord, MAX_SCHEMA_SNAPSHOT_DEPTH)) return null;
      let snapshotBytes: number;
      try {
        snapshotBytes = new TextEncoder().encode(JSON.stringify(snapRecord) ?? '').length;
      } catch {
        return null;
      }
      if (snapshotBytes > MAX_SCHEMA_SNAPSHOT_BYTES) return null;
    }
  }
  // A 'grant'-authorized invocation MUST name its grant (the claim guard
  // validates that exact grant); a grant_id without kind:'grant' is incoherent.
  if (p.authorization_kind === 'grant' && (typeof p.grant_id !== 'string' || p.grant_id === '')) {
    return null;
  }
  // Round-16 #20 + PLG-29 #4: the REVERSE coherence too. grant_id /
  // invocation_digest / resource / value are grant-authorization artifacts; the
  // claim guard only validates them under kind:'grant' (check 7 is gated on
  // that). On a 'card' / absent envelope they are unverifiable — quarantine
  // rather than let forged/ambiguous provenance ride into the receipt.
  // (buildPluginEnvelope only emits these under a supplied authorization.kind, so
  // no legitimate producer path regresses.)
  if (
    p.authorization_kind !== 'grant' &&
    (p.grant_id !== undefined ||
      p.invocation_digest !== undefined ||
      p.resource !== undefined ||
      p.value !== undefined)
  ) {
    return null;
  }
  return p as unknown as PluginTaskEnvelope;
}

/** Declared-effectful (§9.5 classification — never the retry decision). */
export function isDeclaredEffectful(envelope: PluginTaskEnvelope): boolean {
  return EFFECTFUL_CLASSES.has(envelope.action_class);
}

/**
 * May this CLAIMED task be automatically re-dispatched? Trusts nothing
 * but the consented idempotency contract (§9.1) plus the Core-owned
 * budget. `attempt` is the claims consumed so far; `firstClaimedAtMs`
 * anchors the retry window.
 */
export function mayAutoRetry(args: {
  envelope: PluginTaskEnvelope;
  attempt: number;
  firstClaimedAtMs: number | undefined;
  nowMs: number;
}): boolean {
  if (args.envelope.effects_idempotency !== 'supported') return false;
  if (args.attempt >= PLUGIN_RETRY.MAX_ATTEMPTS) return false;
  if (
    args.firstClaimedAtMs !== undefined &&
    args.nowMs - args.firstClaimedAtMs > PLUGIN_RETRY.RETRY_WINDOW_MS
  ) {
    return false;
  }
  return true;
}

/** Exponential-backoff eligibility time for the NEXT claim (unix seconds). */
export function nextRetryAtSec(attempt: number, nowMs: number): number {
  const delay = PLUGIN_RETRY.BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.floor((nowMs + delay) / 1000);
}
