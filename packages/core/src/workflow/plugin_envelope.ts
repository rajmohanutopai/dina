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

export const PLUGIN_INVOCATION_PAYLOAD_TYPE = 'plugin_invocation';

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
  if (
    typeof p.install_id !== 'string' ||
    p.install_id === '' ||
    typeof p.capability_id !== 'string' ||
    p.capability_id === '' ||
    typeof p.manifest_cid !== 'string' ||
    p.manifest_cid === '' ||
    typeof p.approved_scope_hash !== 'string' ||
    p.approved_scope_hash === '' ||
    typeof p.config_revision !== 'number' ||
    !Number.isInteger(p.config_revision) ||
    typeof p.execution_id !== 'string' ||
    p.execution_id === '' ||
    typeof p.idempotency_key !== 'string' ||
    p.idempotency_key === '' ||
    typeof p.action_class !== 'string' ||
    (p.effects_idempotency !== 'supported' && p.effects_idempotency !== 'unsupported')
  ) {
    return null;
  }
  // Round-12 #2/#3/#6/#1: the optional authorization-provenance fields, when
  // present, must be well-formed — a malformed value must quarantine the whole
  // envelope (null), never be trusted as authority by the claim guard.
  if (
    (p.authorization_kind !== undefined &&
      p.authorization_kind !== 'grant' &&
      p.authorization_kind !== 'card') ||
    (p.grant_id !== undefined && (typeof p.grant_id !== 'string' || p.grant_id === '')) ||
    (p.invocation_digest !== undefined && typeof p.invocation_digest !== 'string')
  ) {
    return null;
  }
  // A 'grant'-authorized invocation MUST name its grant (the claim guard
  // validates that exact grant); a grant_id without kind:'grant' is incoherent.
  if (p.authorization_kind === 'grant' && (typeof p.grant_id !== 'string' || p.grant_id === '')) {
    return null;
  }
  // Round-16 #20: the REVERSE coherence too. grant_id / invocation_digest are
  // grant-authorization artifacts; the claim guard only validates them under
  // kind:'grant' (check 7 is gated on that). On a 'card' / absent envelope they
  // are unverifiable — quarantine rather than let forged/ambiguous provenance
  // ride into the receipt. (buildPluginEnvelope only emits these under a
  // supplied authorization.kind, so no legitimate producer path regresses.)
  if (
    p.authorization_kind !== 'grant' &&
    (p.grant_id !== undefined || p.invocation_digest !== undefined)
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
