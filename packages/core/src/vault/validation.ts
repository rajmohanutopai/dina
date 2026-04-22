/**
 * Vault domain validation — enum sets for data integrity at ingest.
 *
 * Ported from Go: core/internal/domain/vault_limits.go
 *
 * These validation sets ensure only known values are stored in vault
 * item fields. Without them, any arbitrary string is accepted.
 */

/** Valid vault item types — 22 values matching Go's CHECK constraint. */
export const VALID_VAULT_ITEM_TYPES = new Set([
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
]);

/** Valid sender_trust values — 6 values from Go. */
export const VALID_SENDER_TRUST = new Set([
  'self',
  'contact_ring1',
  'contact_ring2',
  'service',
  'unknown',
  'marketing',
  '',
]);

/** Valid source_type values — 6 values from Go. */
export const VALID_SOURCE_TYPE = new Set([
  'self',
  'contact',
  'service',
  'unknown',
  'marketing',
  '',
]);

/** Valid confidence levels — 5 values from Go. */
export const VALID_CONFIDENCE = new Set(['high', 'medium', 'low', 'unverified', '']);

/** Valid retrieval policies — 5 values from Go. */
export const VALID_RETRIEVAL_POLICY = new Set([
  'normal',
  'caveated',
  'quarantine',
  'briefing_only',
  '',
]);

/** Valid enrichment statuses — matching Go + mobile enrichment pipeline. */
export const VALID_ENRICHMENT_STATUS = new Set([
  'pending',
  'processing',
  'l0_complete',
  'ready',
  'failed',
  '',
]);

/** Retrieval policies included in default search results. */
export const SEARCHABLE_RETRIEVAL_POLICIES = new Set(['normal', 'caveated', '']);

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
