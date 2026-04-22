/**
 * Sharing tier enforcement — per-contact data category access control.
 *
 * Each contact has sharing tiers per data category:
 *   none          → no data shared
 *   summary       → L0/L1 summaries only (body stripped)
 *   full          → full content including body
 *   locked        → never shared (passphrase-protected persona)
 *   eta_only      → only ETA/arrival time (location-scoped)
 *   free_busy     → only free/busy status (calendar-scoped)
 *   exact_location → full location data (location-scoped)
 *
 * Default-deny: unknown contacts and unknown categories get 'none'.
 *
 * Source: core/internal/adapter/gatekeeper/sharing.go
 */

export type SharingTier =
  | 'none'
  | 'summary'
  | 'full'
  | 'locked'
  | 'eta_only'
  | 'free_busy'
  | 'exact_location';

/** Valid sharing tier values for validation. */
const VALID_SHARING_TIERS = new Set<string>([
  'none',
  'summary',
  'full',
  'locked',
  'eta_only',
  'free_busy',
  'exact_location',
]);

export interface SharingDecision {
  allowed: boolean;
  tier: SharingTier;
  filteredCategories: string[];
  reason?: string;
}

// ---------------------------------------------------------------
// In-memory policy store (populated by setSharingPolicy for testing,
// backed by contacts DB in production)
// ---------------------------------------------------------------

/** Per-contact, per-category sharing tiers. */
const policies = new Map<string, Map<string, SharingTier>>();

/**
 * Set sharing policy for a contact + category.
 *
 * Validates the tier value — rejects invalid tiers with an error.
 */
export function setSharingPolicy(contactDID: string, category: string, tier: SharingTier): void {
  if (!VALID_SHARING_TIERS.has(tier)) {
    throw new Error(
      `sharing: invalid tier "${tier}". Valid: ${[...VALID_SHARING_TIERS].join(', ')}`,
    );
  }

  let contactPolicy = policies.get(contactDID);
  if (!contactPolicy) {
    contactPolicy = new Map();
    policies.set(contactDID, contactPolicy);
  }
  contactPolicy.set(category, tier);
}

/** Validate a sharing tier value. Returns null if valid, error message otherwise. */
export function validateSharingTier(tier: string): string | null {
  if (!VALID_SHARING_TIERS.has(tier)) {
    return `invalid sharing tier: "${tier}". Valid: ${[...VALID_SHARING_TIERS].join(', ')}`;
  }
  return null;
}

/**
 * Set sharing policy for a category across ALL contacts at once.
 *
 * Used for global policy changes like "lock health data for everyone"
 * or "allow full sharing of presence for all contacts".
 * Matching Go's SetBulkPolicy.
 *
 * @returns count of contacts updated
 */
export function setBulkPolicy(category: string, tier: SharingTier): number {
  if (!VALID_SHARING_TIERS.has(tier)) {
    throw new Error(
      `sharing: invalid tier "${tier}". Valid: ${[...VALID_SHARING_TIERS].join(', ')}`,
    );
  }

  let updated = 0;
  for (const [, contactPolicy] of policies) {
    contactPolicy.set(category, tier);
    updated++;
  }
  return updated;
}

/** Clear all policies (for testing). */
export function clearSharingPolicies(): void {
  policies.clear();
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Check if data categories are shareable with a contact.
 * If ANY category is restricted (none/locked), the entire send is denied.
 */
export function checkSharingPolicy(contactDID: string, categories: string[]): SharingDecision {
  if (categories.length === 0) {
    return { allowed: true, tier: 'full', filteredCategories: [] };
  }

  const filtered: string[] = [];
  let lowestTier: SharingTier = 'full';

  for (const cat of categories) {
    const tier = getSharingTier(contactDID, cat);
    if (tier === 'none' || tier === 'locked') {
      filtered.push(cat);
      lowestTier = 'none';
    } else if (tier === 'summary' && lowestTier === 'full') {
      lowestTier = 'summary';
    } else if ((tier === 'eta_only' || tier === 'free_busy') && lowestTier === 'full') {
      lowestTier = tier;
    }
  }

  if (filtered.length > 0) {
    return {
      allowed: false,
      tier: 'none',
      filteredCategories: filtered,
      reason: `Categories restricted: ${filtered.join(', ')}`,
    };
  }

  return { allowed: true, tier: lowestTier, filteredCategories: [] };
}

/**
 * Get the sharing tier for a specific contact + category.
 * Returns 'none' if no policy exists (default-deny).
 */
export function getSharingTier(contactDID: string, category: string): SharingTier {
  const contactPolicy = policies.get(contactDID);
  if (!contactPolicy) return 'none';
  return contactPolicy.get(category) ?? 'none';
}

/**
 * Filter egress data based on sharing tier.
 *
 * Filtering rules:
 * - 'none' / 'locked' → remove entirely (returns null)
 * - 'summary'         → keep L0/L1 summaries, remove body
 * - 'full'            → keep everything
 * - 'eta_only'        → keep only eta/arrival fields
 * - 'free_busy'       → keep only free/busy status
 * - 'exact_location'  → keep location data
 */
export function filterByTier(
  data: Record<string, unknown>,
  tier: SharingTier,
): Record<string, unknown> | null {
  if (tier === 'none' || tier === 'locked') return null;

  if (tier === 'summary') {
    const { body, ...rest } = data;
    return rest;
  }

  if (tier === 'eta_only') {
    // Only ETA/arrival time fields
    return pickFields(data, ['eta', 'arrival_time', 'estimated_arrival', 'id', 'type']);
  }

  if (tier === 'free_busy') {
    // Only free/busy status fields
    return pickFields(data, ['status', 'free_busy', 'start_time', 'end_time', 'id', 'type']);
  }

  // 'full' and 'exact_location' — keep everything
  return { ...data };
}

/** Pick only the specified fields from a data object. */
function pickFields(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in data) {
      result[field] = data[field];
    }
  }
  return result;
}

// ---------------------------------------------------------------
// TieredPayload — Summary/Full pair for multi-tier egress
//
// Matching Go's TieredPayload: pre-computes both summary and full
// versions of data so the gatekeeper can serve the right tier to
// each recipient without re-filtering on every send.
// ---------------------------------------------------------------

/**
 * Pre-computed payload in both summary and full tiers.
 *
 * Used for multi-recipient egress: each recipient gets the data
 * tier their sharing policy allows, without re-computing per send.
 */
export interface TieredPayload {
  /** Full data with all fields. */
  full: Record<string, unknown>;
  /** Summary data with body stripped (L0/L1 only). */
  summary: Record<string, unknown>;
}

/**
 * Build a TieredPayload from vault item data.
 *
 * Pre-computes both summary (body stripped) and full versions.
 * The egress gate then selects the appropriate tier per recipient.
 *
 * @param data - Full vault item data
 * @returns { full, summary } pair
 */
export function buildTieredPayload(data: Record<string, unknown>): TieredPayload {
  const { body, ...summaryData } = data;
  return {
    full: { ...data },
    summary: summaryData,
  };
}

/**
 * Select the appropriate tier from a TieredPayload based on sharing policy.
 *
 * Returns null for none/locked (no data shared).
 * Returns the full or summary payload based on the tier.
 * For eta_only/free_busy, applies additional field filtering on the full payload.
 */
export function selectPayloadTier(
  payload: TieredPayload,
  tier: SharingTier,
): Record<string, unknown> | null {
  if (tier === 'none' || tier === 'locked') return null;
  if (tier === 'summary') return payload.summary;
  if (tier === 'eta_only')
    return pickFields(payload.full, ['eta', 'arrival_time', 'estimated_arrival', 'id', 'type']);
  if (tier === 'free_busy')
    return pickFields(payload.full, [
      'status',
      'free_busy',
      'start_time',
      'end_time',
      'id',
      'type',
    ]);
  return payload.full; // 'full' and 'exact_location'
}
