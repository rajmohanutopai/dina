/**
 * Vault item type → tier classification.
 *
 * Tier 1: high-value, personally authored or curated items.
 *   Items the user created, events, contacts, health records, financial
 *   decisions, relationship notes, trust attestations.
 *
 * Tier 2: lower-value, automated or ingested items.
 *   Emails, messages, notifications, bookmarks, drafts, generic documents.
 *
 * The two sets are disjoint and exhaustive — every known vault_items.type
 * maps to exactly one tier. Unknown types default to Tier 2.
 *
 * Source: brain/tests/test_tier_classifier.py
 */

export type ItemTier = 1 | 2;

/**
 * Tier 1: personally authored, curated, or high-value items.
 * These get priority in search results and fuller context loading.
 */
const TIER_1_TYPES = new Set([
  'note', // user-authored
  'event', // calendar event
  'contact_card', // personal contact info
  'voice_memo', // user-recorded
  'photo', // personal media
  'health_context', // health decisions
  'work_context', // work projects/goals
  'finance_context', // financial decisions
  'family_context', // family context
  'trust_review', // user trust evaluation
  'purchase_decision', // shopping research verdict
  'relationship_note', // relationship context (from social.update)
  'medical_record', // health records
  'medical_note', // health notes
  'trust_attestation', // identity vouching
]);

/**
 * Tier 2: automated, ingested, or lower-value items.
 * These are summarized and ranked below Tier 1 in search.
 */
const TIER_2_TYPES = new Set([
  'email', // ingested email
  'message', // chat message
  'email_draft', // draft (not yet sent)
  'cart_handover', // shopping cart data
  'document', // generic document
  'bookmark', // saved link
  'kv', // key-value data
  'contact', // address book entry (less curated than contact_card)
]);

/**
 * Classify a vault item type into Tier 1 or Tier 2.
 * Unknown types default to Tier 2 (conservative — treat as lower-value).
 */
export function classifyTier(itemType: string): ItemTier {
  if (TIER_1_TYPES.has(itemType)) return 1;
  return 2;
}

/** Get all Tier 1 item types. */
export function getTier1Types(): string[] {
  return Array.from(TIER_1_TYPES);
}

/** Get all Tier 2 item types. */
export function getTier2Types(): string[] {
  return Array.from(TIER_2_TYPES);
}

/** Check that Tier 1 and Tier 2 are disjoint (no overlap). */
export function areTiersDisjoint(): boolean {
  for (const type of TIER_1_TYPES) {
    if (TIER_2_TYPES.has(type)) return false;
  }
  return true;
}
