/**
 * Vault domain validation — enum sets for data integrity at ingest.
 *
 * Ported from Go: core/internal/domain/vault_limits.go
 *
 * These validation sets ensure only known values are stored in vault
 * item fields. Without them, any arbitrary string is accepted.
 */

/**
 * Valid vault item types — 22 values matching Go's CHECK constraint,
 * plus `user_memory` for items the user types via /remember (the
 * staging pipeline uses this to tag direct user-authored memories
 * so they can be distinguished from ingested mail/events/etc. in
 * later retrieval + density analysis).
 *
 * Declared as a `const` tuple so {@link VaultItemType} is a strict
 * union of literals — callers building a vault row, or registering
 * a D2D-type → vault-type mapping, get a compile-time error for any
 * value not in this list. The runtime Set is derived from the same
 * tuple so the two cannot drift.
 */
export const VAULT_ITEM_TYPES = [
  'email',
  'message',
  'event',
  'note',
  'photo',
  'email_draft',
  'cart_handover',
  'contact_card',
  'document',
  'bookmark',
  'voice_memo',
  'kv',
  'contact',
  'health_context',
  'work_context',
  'finance_context',
  'family_context',
  'trust_review',
  'purchase_decision',
  'relationship_note',
  'medical_record',
  'medical_note',
  'trust_attestation',
  'user_memory',
] as const;

/** Strict union type for vault item type values. */
export type VaultItemType = (typeof VAULT_ITEM_TYPES)[number];

/**
 * Runtime-checkable Set of valid vault item types.
 *
 * Typed `Set<string>` so the validator can call `.has(unknownString)`
 * on untrusted input from the wire. The single source of truth for the
 * *allowed values* is the {@link VAULT_ITEM_TYPES} tuple — `Set<string>`
 * just makes the query side ergonomic.
 */
export const VALID_VAULT_ITEM_TYPES = new Set<string>(VAULT_ITEM_TYPES);

/**
 * Runtime guard for arbitrary value → {@link VaultItemType}.
 *
 * Use at row→domain boundaries (SQL rows come back as `string`, but
 * the validator already accepted them on write — this is the narrowing
 * point that lets downstream code use the strict union without an
 * unchecked cast).
 */
export function isVaultItemType(value: unknown): value is VaultItemType {
  return typeof value === 'string' && VALID_VAULT_ITEM_TYPES.has(value);
}

// ─── Vault enum tuples → union types ──────────────────────────────────
// All vault validation enums follow the same pattern as VAULT_ITEM_TYPES:
// const tuple is the source of truth → union type for builders →
// runtime Set<string> for validators that take untrusted input.

export const SENDER_TRUST_VALUES = [
  'self',
  'contact_ring1',
  'contact_ring2',
  'service',
  'unknown',
  'marketing',
  '',
] as const;
export type SenderTrust = (typeof SENDER_TRUST_VALUES)[number];
/** Valid sender_trust values — 7 values from Go. */
export const VALID_SENDER_TRUST = new Set<string>(SENDER_TRUST_VALUES);

export const SOURCE_TYPE_VALUES = [
  'self',
  'contact',
  'service',
  'unknown',
  'marketing',
  '',
] as const;
export type SourceType = (typeof SOURCE_TYPE_VALUES)[number];
/** Valid source_type values — 6 values from Go. */
export const VALID_SOURCE_TYPE = new Set<string>(SOURCE_TYPE_VALUES);

export const CONFIDENCE_VALUES = ['high', 'medium', 'low', 'unverified', ''] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];
/** Valid confidence levels — 5 values from Go. */
export const VALID_CONFIDENCE = new Set<string>(CONFIDENCE_VALUES);

export const RETRIEVAL_POLICY_VALUES = [
  'normal',
  'caveated',
  'quarantine',
  'briefing_only',
  '',
] as const;
export type RetrievalPolicy = (typeof RETRIEVAL_POLICY_VALUES)[number];
/** Valid retrieval policies — 5 values from Go. */
export const VALID_RETRIEVAL_POLICY = new Set<string>(RETRIEVAL_POLICY_VALUES);

export const ENRICHMENT_STATUS_VALUES = [
  'pending',
  'processing',
  'l0_complete',
  'ready',
  'failed',
  '',
] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUS_VALUES)[number];
/** Valid enrichment statuses — matching Go + mobile enrichment pipeline. */
export const VALID_ENRICHMENT_STATUS = new Set<string>(ENRICHMENT_STATUS_VALUES);

/** Retrieval policies included in default search results. */
export const SEARCHABLE_RETRIEVAL_POLICIES = new Set<string>([
  'normal',
  'caveated',
  '',
]);

/** Maximum vault item body size in bytes (10 MiB). */
export const MAX_VAULT_ITEM_SIZE = 10 * 1024 * 1024;

/**
 * Validate a vault item's enum fields before storage.
 *
 * Returns null if valid, or an error message describing the first invalid field.
 */
export function validateVaultItem(item: {
  type?: string;
  sender_trust?: string;
  source_type?: string;
  confidence?: string;
  retrieval_policy?: string;
  enrichment_status?: string;
  body?: string;
}): string | null {
  if (item.type !== undefined && !VALID_VAULT_ITEM_TYPES.has(item.type)) {
    return `invalid item type: "${item.type}"`;
  }
  if (item.sender_trust !== undefined && !VALID_SENDER_TRUST.has(item.sender_trust)) {
    return `invalid sender_trust: "${item.sender_trust}"`;
  }
  if (item.source_type !== undefined && !VALID_SOURCE_TYPE.has(item.source_type)) {
    return `invalid source_type: "${item.source_type}"`;
  }
  if (item.confidence !== undefined && !VALID_CONFIDENCE.has(item.confidence)) {
    return `invalid confidence: "${item.confidence}"`;
  }
  if (item.retrieval_policy !== undefined && !VALID_RETRIEVAL_POLICY.has(item.retrieval_policy)) {
    return `invalid retrieval_policy: "${item.retrieval_policy}"`;
  }
  if (
    item.enrichment_status !== undefined &&
    !VALID_ENRICHMENT_STATUS.has(item.enrichment_status)
  ) {
    return `invalid enrichment_status: "${item.enrichment_status}"`;
  }
  if (
    item.body !== undefined &&
    new TextEncoder().encode(item.body).byteLength > MAX_VAULT_ITEM_SIZE
  ) {
    return `body exceeds maximum size of ${MAX_VAULT_ITEM_SIZE} bytes`;
  }
  return null;
}
