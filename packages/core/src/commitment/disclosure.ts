/**
 * The disclosure rules for a deal's fields (COMMITMENT_KERNEL §11). Each
 * field a deal may reveal names its data category in the vocabulary (a
 * pincode is location; a dietary need is health). A field goes out only if
 * the recipient's sharing tier admits it; no tier set admits nothing, and
 * the owner's card asks.
 *
 *   - general, health, financial, professional, social: `summary` and `full`
 *     admit a bounded field, as group coordination reads them today;
 *   - location: `full` and `exact_location` admit any location field;
 *     `pincode_only` admits a pincode and nothing finer; `eta_only` keeps its
 *     meaning (arrival times only) and admits no place at all.
 *
 * PURE: the tier is resolved by the caller (`coordination/disclosure_policy`).
 */

import type { SharingTier } from '../gatekeeper/sharing';

/** How fine a location field is. */
export type LocationGrain = 'pincode' | 'address' | 'position';

export type DisclosedField =
  | { category: 'general' | 'health' | 'financial' | 'professional' | 'social' }
  | { category: 'location'; grain: LocationGrain };

export function fieldAdmitted(tier: SharingTier | undefined, field: DisclosedField): boolean {
  if (tier === undefined || tier === 'none' || tier === 'locked') return false;
  if (field.category === 'location') {
    if (tier === 'full' || tier === 'exact_location') return true;
    return tier === 'pincode_only' && field.grain === 'pincode';
  }
  return tier === 'summary' || tier === 'full';
}
