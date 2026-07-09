/**
 * Contact-list source — NATIVE / default.
 *
 * On mobile the contact directory lives in-process, so read it directly.
 * The web variant (`contacts_source.web.ts`) fetches from the brain's
 * `/api/v1/contacts` proxy, because the thin-client's in-process directory
 * is empty (F4).
 */

import { deleteContact as directoryDeleteContact, listContacts, type Contact } from '@dina/core';

export function loadContacts(): Promise<Contact[]> {
  return Promise.resolve(listContacts());
}

/**
 * Remove a contact. NATIVE: the in-process directory IS the authoritative
 * store, so delete it directly. Returns true (removed). The web variant does
 * NOT write locally (Core is authoritative there) — see contacts_source.web.ts.
 */
export function deleteContact(did: string): Promise<boolean> {
  directoryDeleteContact(did);
  return Promise.resolve(true);
}
