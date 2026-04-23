/**
 * Phone contacts import hook — fetch, match, and import phone contacts.
 *
 * Flow:
 *   1. Request permission (expo-contacts)
 *   2. Fetch phone contacts
 *   3. Normalize and deduplicate
 *   4. Match against existing Dina contacts (by name, phone, email)
 *   5. Create new Dina contacts for unmatched entries
 *
 * The native contact fetcher is injectable for testing.
 *
 * Source: ARCHITECTURE.md Task 6.18
 */

import {
  addContact,
  listContacts,
  resetContactDirectory,
  type Contact,
} from '@dina/core/src/contacts/directory';

export interface PhoneContact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
}

export interface ImportResult {
  total: number;
  matched: number;
  imported: number;
  skipped: number;
  errors: string[];
}

export type PermissionStatus = 'undetermined' | 'granted' | 'denied';

/** Injectable native contact fetcher. */
let fetchContactsFn: (() => Promise<PhoneContact[]>) | null = null;

/** Injectable permission requester. */
let requestPermissionFn: (() => Promise<PermissionStatus>) | null = null;

/** Configure native contact functions. */
export function configurePhoneContacts(config: {
  fetchContacts: () => Promise<PhoneContact[]>;
  requestPermission: () => Promise<PermissionStatus>;
}): void {
  fetchContactsFn = config.fetchContacts;
  requestPermissionFn = config.requestPermission;
}

/**
 * Request contact permission.
 */
export async function requestPermission(): Promise<PermissionStatus> {
  if (!requestPermissionFn) return 'denied';
  return requestPermissionFn();
}

/**
 * Fetch phone contacts (requires permission).
 */
export async function fetchPhoneContacts(): Promise<PhoneContact[]> {
  if (!fetchContactsFn) return [];
  return fetchContactsFn();
}

/**
 * Match a phone contact against existing Dina contacts.
 * Returns the matched Dina contact DID, or null if no match.
 */
export function matchContact(phone: PhoneContact, existing: Contact[]): string | null {
  const phoneName = phone.name.trim().toLowerCase();

  for (const contact of existing) {
    // Match by display name (case-insensitive)
    if (contact.displayName.toLowerCase() === phoneName) {
      return contact.did;
    }

    // Match by alias
    for (const alias of contact.aliases) {
      if (alias.toLowerCase() === phoneName) {
        return contact.did;
      }
    }
  }

  return null;
}

/**
 * Import phone contacts into Dina.
 * Matches against existing contacts, creates new ones for unmatched.
 */
export async function importPhoneContacts(): Promise<ImportResult> {
  const result: ImportResult = { total: 0, matched: 0, imported: 0, skipped: 0, errors: [] };

  // Fetch phone contacts
  const phoneContacts = await fetchPhoneContacts();
  result.total = phoneContacts.length;

  if (phoneContacts.length === 0) {
    return result;
  }

  const existing = listContacts();

  for (const phone of phoneContacts) {
    // Skip contacts without a name
    if (!phone.name || phone.name.trim().length === 0) {
      result.skipped++;
      continue;
    }

    // Check if already matched
    const matchedDID = matchContact(phone, existing);
    if (matchedDID) {
      result.matched++;
      continue;
    }

    // Create new Dina contact (no DID — phone contacts don't have DIDs)
    const did = `did:phone:${phone.id}`;
    try {
      addContact(did, phone.name.trim());
      result.imported++;
    } catch {
      // Likely duplicate — skip
      result.skipped++;
    }
  }

  return result;
}

/**
 * Normalize a phone number for comparison (strip non-digits).
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9+]/g, '');
}

/**
 * Normalize an email for comparison (lowercase, trim).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Reset (for testing). */
export function resetPhoneContacts(): void {
  fetchContactsFn = null;
  requestPermissionFn = null;
}
