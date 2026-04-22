/**
 * Contact detail data hook — edit sharing/scenario policies, aliases, trust.
 *
 * Provides:
 *   - Full contact info with all editable fields
 *   - Sharing policy: per-category tier (none/summary/full/locked)
 *   - Scenario policy: deny list for D2D message types
 *   - Alias management: add, remove, list (globally unique)
 *   - Trust level update
 *   - Contact notes editing
 *
 * Source: ARCHITECTURE.md Task 6.17
 */

import {
  getContact,
  updateContact,
  addAlias,
  removeAlias,
  type Contact,
  type TrustLevel,
  type SharingTier,
} from '../../../core/src/contacts/directory';
import {
  setSharingPolicy,
  getSharingTier,
  type SharingTier as PolicyTier,
} from '../../../core/src/gatekeeper/sharing';

export interface ContactDetailState {
  did: string;
  displayName: string;
  trustLevel: TrustLevel;
  sharingTier: SharingTier;
  aliases: string[];
  notes: string;
  sharingPolicy: Record<string, string>;
  scenarioDeny: string[];
}

import { DATA_CATEGORIES } from '../../../core/src/persona/names';

/** Standard data categories for sharing policy editor (from canonical names). */
const CATEGORIES = [...DATA_CATEGORIES];

/** Scenario deny list state (per contact). */
const scenarioDenyLists = new Map<string, string[]>();

/**
 * Load contact detail for the detail screen.
 */
export function loadContactDetail(did: string): ContactDetailState | null {
  const contact = getContact(did);
  if (!contact) return null;

  const policy: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    policy[cat] = getSharingTier(did, cat);
  }

  return {
    did: contact.did,
    displayName: contact.displayName,
    trustLevel: contact.trustLevel,
    sharingTier: contact.sharingTier,
    aliases: contact.aliases,
    notes: contact.notes,
    sharingPolicy: policy,
    scenarioDeny: scenarioDenyLists.get(did) ?? [],
  };
}

/**
 * Update sharing policy for a category.
 */
export function updateSharingPolicy(
  did: string,
  category: string,
  tier: PolicyTier,
): string | null {
  const contact = getContact(did);
  if (!contact) return 'Contact not found';

  setSharingPolicy(did, category, tier);
  return null;
}

/**
 * Update scenario deny list — set which D2D message types are blocked.
 */
export function updateScenarioDeny(did: string, denied: string[]): string | null {
  const contact = getContact(did);
  if (!contact) return 'Contact not found';

  scenarioDenyLists.set(did, [...denied]);
  return null;
}

/**
 * Add an alias to the contact.
 */
export function addContactAlias(did: string, alias: string): string | null {
  if (!alias.trim()) return 'Alias cannot be empty';

  try {
    addAlias(did, alias.trim());
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already taken')) return 'Alias already used by another contact';
    if (msg.includes('not found')) return 'Contact not found';
    return msg;
  }
}

/**
 * Remove an alias from the contact.
 */
export function removeContactAlias(did: string, alias: string): string | null {
  try {
    removeAlias(did, alias);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Update the contact's trust level.
 */
export function updateTrustLevel(did: string, trustLevel: TrustLevel): string | null {
  try {
    updateContact(did, { trustLevel });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Update the contact's notes.
 */
export function updateNotes(did: string, notes: string): string | null {
  try {
    updateContact(did, { notes });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Get the sharing policy categories for the editor.
 */
export function getSharingCategories(): string[] {
  return [...CATEGORIES];
}

/**
 * Get sharing tier options for the picker.
 */
export function getSharingTierOptions(): Array<{ value: PolicyTier; label: string }> {
  return [
    { value: 'none', label: 'None — no data shared' },
    { value: 'summary', label: 'Summary — headlines only' },
    { value: 'full', label: 'Full — complete content' },
    { value: 'locked', label: 'Locked — never shared' },
  ];
}

/**
 * Reset (for testing).
 */
export function resetContactDetail(): void {
  scenarioDenyLists.clear();
}
