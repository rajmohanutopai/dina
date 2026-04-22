/**
 * Contacts tab data hook — list, search, filter, add contacts.
 *
 * Provides:
 *   - Contact list with trust level badge and sharing tier
 *   - Search by name or alias
 *   - Filter by trust level
 *   - Add contact by DID
 *   - Contact count with trust breakdown
 *
 * Source: ARCHITECTURE.md Task 6.16
 */

import {
  listContacts,
  addContact,
  getContact,
  findByAlias,
  getContactsByTrust,
  deleteContact,
  resetContactDirectory,
  type Contact,
  type TrustLevel,
  type SharingTier,
} from '../../../core/src/contacts/directory';

export interface ContactUIItem {
  did: string;
  displayName: string;
  trustLevel: TrustLevel;
  trustBadge: string;
  sharingTier: SharingTier;
  aliases: string[];
  aliasLabel: string;
  initials: string;
}

/** Trust level display badges. */
const TRUST_BADGES: Record<TrustLevel, string> = {
  blocked: 'Blocked',
  unknown: 'Unknown',
  verified: 'Verified',
  trusted: 'Trusted',
};

/**
 * Get all contacts as UI items.
 */
export function getContactList(): ContactUIItem[] {
  return listContacts()
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(toUIItem);
}

/**
 * Search contacts by name or alias (case-insensitive substring match).
 */
export function searchContacts(query: string): ContactUIItem[] {
  if (!query.trim()) return getContactList();

  const q = query.toLowerCase();
  return listContacts()
    .filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q)) ||
        c.did.toLowerCase().includes(q),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(toUIItem);
}

/**
 * Filter contacts by trust level.
 */
export function filterByTrust(trustLevel: TrustLevel): ContactUIItem[] {
  return getContactsByTrust(trustLevel)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(toUIItem);
}

/**
 * Add a new contact by DID.
 * Returns null on success, error message on failure.
 */
export function addNewContact(
  did: string,
  displayName: string,
  trustLevel?: TrustLevel,
): string | null {
  if (!did.trim()) return 'DID is required';
  if (!displayName.trim()) return 'Display name is required';

  try {
    addContact(did.trim(), displayName.trim(), trustLevel);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) return 'Contact already exists';
    return msg;
  }
}

/**
 * Remove a contact.
 */
export function removeContact(did: string): boolean {
  return deleteContact(did);
}

/**
 * Get contact trust breakdown for the header summary.
 */
export function getTrustBreakdown(): Record<TrustLevel, number> {
  const all = listContacts();
  const breakdown: Record<TrustLevel, number> = { blocked: 0, unknown: 0, verified: 0, trusted: 0 };
  for (const c of all) {
    breakdown[c.trustLevel]++;
  }
  return breakdown;
}

/**
 * Get total contact count.
 */
export function getContactCount(): number {
  return listContacts().length;
}

/**
 * Get available trust level options for filter/create.
 */
export function getTrustLevelOptions(): Array<{ value: TrustLevel; label: string }> {
  return [
    { value: 'trusted', label: 'Trusted' },
    { value: 'verified', label: 'Verified' },
    { value: 'unknown', label: 'Unknown' },
    { value: 'blocked', label: 'Blocked' },
  ];
}

/**
 * Reset (for testing).
 */
export function resetContacts(): void {
  resetContactDirectory();
}

/** Map Contact to UI item. */
function toUIItem(c: Contact): ContactUIItem {
  return {
    did: c.did,
    displayName: c.displayName,
    trustLevel: c.trustLevel,
    trustBadge: TRUST_BADGES[c.trustLevel],
    sharingTier: c.sharingTier,
    aliases: c.aliases,
    aliasLabel: c.aliases.length > 0 ? c.aliases.join(', ') : '',
    initials: getInitials(c.displayName),
  };
}

/** Extract initials from a display name (for avatar). */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
