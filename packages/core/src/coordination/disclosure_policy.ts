/**
 * The disclosure policy both ends of a spoke apply
 * (docs/GROUP_COORDINATION_ARCHITECTURE.md §6, §13): which data category a
 * disclosure kind belongs to, which sharing tier admits one, and which tier
 * answers for a contact. Pure, so the guest-side egress gate and the
 * organizer-side receipt read the same rule from the same place.
 */

import { getContact } from '../contacts/directory';
import { getSharingPolicy, type SharingTier } from '../gatekeeper/sharing';

import type { DisclosureKind } from './group_plan';

/** The one capability a spoke carries (CONTACT_SERVICES §6.1). */
export const GROUP_COORDINATION_CAPABILITY = 'availability_coordination';

export type DisclosureCategory = 'health' | 'general';

/** The data category a disclosure kind belongs to (`DATA_CATEGORIES`). */
export function disclosureCategory(kind: DisclosureKind): DisclosureCategory {
  return kind === 'dietary' || kind === 'accessibility' ? 'health' : 'general';
}

/** A tier's word on whether one bounded line of a category may leave, or be held. */
export function tierAdmitsDisclosure(tier: SharingTier | undefined): boolean {
  return tier === 'summary' || tier === 'full';
}

export type DisclosureTierResolver = (contactDID: string, category: DisclosureCategory) => SharingTier | undefined;

/**
 * The tier that answers for a contact and a category: the per-category
 * policy when one was set, else the contact's own tier, else nothing (which
 * admits nothing). The same resolver serves the guest deciding what to say
 * and the organizer deciding what to hold.
 */
export const contactDisclosureTier: DisclosureTierResolver = (contactDID, category) =>
  getSharingPolicy(contactDID, category) ?? getContact(contactDID)?.sharingTier;
