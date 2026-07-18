/**
 * Push-service protocol layer (PUSH_SERVICES_ARCHITECTURE.md §7). Zero-dep. The
 * `push_notify` capability id, the `push.*` D2D family ids, the frozen
 * `push.event`/`push.subscribe`/`push.ack` body shapes + validators, and the
 * signed `push.event` projection.
 *
 * "A push is a deferred pull" (§1): no `push.event` is admitted without a
 * matching, active, subscriber-authored authorization; the provider's
 * `claimed_priority` is untrusted input the classifier caps at the ceiling.
 */

/** The official, flat, snake_case service-capability id (§7.1). Dotted
 *  `com.dinakernel.push.*` identifiers are reserved for public ATProto records
 *  (accountability, §12), NOT the capability id. */
export const PUSH_NOTIFY_CAPABILITY = 'push_notify';

/** The four V1 D2D families (§7.2). */
export const PUSH_SUBSCRIBE = 'push.subscribe';
export const PUSH_ACK = 'push.ack';
export const PUSH_EVENT = 'push.event';
export const PUSH_UNSUBSCRIBE = 'push.unsubscribe';

export const PUSH_FAMILIES = [PUSH_SUBSCRIBE, PUSH_ACK, PUSH_EVENT, PUSH_UNSUBSCRIBE] as const;

/** Accountability-only public NSIDs (§7.1/§12), NOT the capability id. */
export const PUSH_DECLARATION_NSID = 'com.dinakernel.push.declaration';
export const PUSH_OUTCOME_NSID = 'com.dinakernel.push.outcome';
export const PUSH_SCORE_SNAPSHOT_NSID = 'com.dinakernel.push.scoreSnapshot';

/** Provider-claimed urgency — a request, never a grant (§5). Dina's classifier
 *  re-derives the tier and caps it at the authorization ceiling. */
export type ClaimedPriority = 'engagement' | 'solicited' | 'fiduciary';

/** Fulfilment mode of a subscription (§6). */
export type PushFulfilment = 'push' | 'poll' | 'push_with_poll_fallback';

/** The push authorization (subscription) — subscriber-authored, standing,
 *  revocable (§6). Held in the persona the topic belongs to. */
export interface PushSubscription {
  subscription_id: string;
  provider_did: string;
  service_uri: string;
  push_capability: string;
  persona: string;
  topic_id: string;
  condition: unknown; // bounded, schema-validated per the push scope
  /** ceiling, not floor: caps how loud a provider may ever be (§5/§6). */
  priority_ceiling: ClaimedPriority;
  /** token bucket: e.g. { tokens: 3, window_seconds: 86400 }. */
  rate_budget: { tokens: number; window_seconds: number };
  quiet_hours_policy: 'inherit_global' | 'topic_override';
  fulfilment: PushFulfilment;
  poll_interval_seconds?: number;
  delivery_evidence: 'none' | 'trigger_evidence_required';
  expires_at: number;
  created_at: number;
}

/** A `push.subscribe` request body (§7.4). */
export interface PushSubscribeBody {
  subscription_id: string;
  topic_id: string;
  condition: unknown;
  fulfilment: PushFulfilment;
  ttl_seconds: number;
}

/** A `push.ack` response body (§7.4). */
export interface PushAckBody {
  subscription_id: string;
  decision: 'accepted' | 'rejected';
  runtime_issuer_did?: string;
  runtime_key_id?: string;
  min_interval_seconds?: number;
  reason?: string;
}

/** A signed `push.event` body (§7.3). */
export interface PushEventBody {
  event_id: string;
  subscription_ref: string;
  provider_did: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
  service_uri: string;
  topic_id: string;
  condition_ref: string;
  trigger_evidence?: unknown;
  claimed_priority: ClaimedPriority;
  card: unknown; // a bounded, validated CardSpec
  dedup_key: string;
  sequence: number;
  issued_at: number;
  expires_at: number;
  signature: string;
}

const CLAIMED: ReadonlySet<string> = new Set(['engagement', 'solicited', 'fiduciary']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a `push.event` body's REQUIRED scalar fields (the CardSpec + the
 *  runtime signature are validated separately by Core). Returns null on any
 *  missing/ill-typed required field (fail-closed). */
export function validatePushEventBody(value: unknown): PushEventBody | null {
  if (!isRecord(value)) return null;
  const s = (k: string): string | null => (typeof value[k] === 'string' && value[k] !== '' ? (value[k] as string) : null);
  const n = (k: string): number | null => (typeof value[k] === 'number' && Number.isFinite(value[k]) ? (value[k] as number) : null);

  const event_id = s('event_id');
  const subscription_ref = s('subscription_ref');
  const provider_did = s('provider_did');
  const runtime_issuer_did = s('runtime_issuer_did');
  const runtime_key_id = s('runtime_key_id');
  const service_uri = s('service_uri');
  const topic_id = s('topic_id');
  const condition_ref = s('condition_ref');
  const dedup_key = s('dedup_key');
  const signature = s('signature');
  const sequence = n('sequence');
  const issued_at = n('issued_at');
  const expires_at = n('expires_at');
  const claimed = typeof value.claimed_priority === 'string' && CLAIMED.has(value.claimed_priority)
    ? (value.claimed_priority as ClaimedPriority)
    : null;

  if (
    event_id === null || subscription_ref === null || provider_did === null ||
    runtime_issuer_did === null || runtime_key_id === null || service_uri === null ||
    topic_id === null || condition_ref === null || dedup_key === null || signature === null ||
    sequence === null || issued_at === null || expires_at === null || claimed === null ||
    !('card' in value)
  ) {
    return null;
  }
  return {
    event_id, subscription_ref, provider_did, runtime_issuer_did, runtime_key_id, service_uri,
    topic_id, condition_ref, claimed_priority: claimed, card: value.card, dedup_key, sequence,
    issued_at, expires_at, signature,
    ...(value.trigger_evidence !== undefined ? { trigger_evidence: value.trigger_evidence } : {}),
  };
}

export const PUSH_EVENT_DOMAIN = 'dina:push:event:v1';

export interface PushEventProjectionInput {
  event_id: string;
  subscription_ref: string;
  provider_did: string;
  service_uri: string;
  topic_id: string;
  condition_ref: string;
  claimed_priority: ClaimedPriority;
  /** SHA-256 hex of the card. */
  card_digest: string;
  /** SHA-256 hex of the trigger_evidence, or '' when absent. */
  trigger_evidence_digest: string;
  dedup_key: string;
  sequence: number;
  issued_at: number;
  expires_at: number;
  runtime_issuer_did: string;
  runtime_key_id: string;
}

/** Build the canonical signed string for a `push.event` (§7.3). Domain-separated
 *  so it can never be replayed as an interactive-run projection. */
export function buildPushEventProjection(i: PushEventProjectionInput): string {
  return [
    PUSH_EVENT_DOMAIN,
    i.event_id,
    i.subscription_ref,
    i.provider_did,
    i.service_uri,
    i.topic_id,
    i.condition_ref,
    i.claimed_priority,
    i.card_digest,
    i.trigger_evidence_digest,
    i.dedup_key,
    String(i.sequence),
    String(i.issued_at),
    String(i.expires_at),
    i.runtime_issuer_did,
    i.runtime_key_id,
  ].join('\n');
}
