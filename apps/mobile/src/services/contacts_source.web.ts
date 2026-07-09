/**
 * Contact-list source — WEB.
 *
 * The thin-client's in-process contact directory is empty (Core runs
 * server-side), so fetch the directory from the brain's `/api/v1/contacts`
 * proxy — the F4 web-parity fix for the People/Talk screen ("No contacts
 * yet" despite Core having contacts).
 */

import type { Contact } from '@dina/core';

export async function loadContacts(): Promise<Contact[]> {
  const res = await fetch('/api/v1/contacts');
  if (!res.ok) {
    throw new Error(`contacts: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { contacts?: Contact[] };
  return body.contacts ?? [];
}

/**
 * Remove a contact. WEB: the thin-client's in-process directory is NOT
 * authoritative (Core runs server-side), so delete against the AUTHORITATIVE
 * Core store via the brain's `DELETE /api/v1/contacts/:did` proxy — a LOCAL
 * delete would be reverted by the next Core-backed `loadContacts` refresh.
 * Returns true only when Core confirms the removal, so the caller refreshes
 * only when it actually stuck.
 */
export async function deleteContact(did: string): Promise<boolean> {
  const res = await fetch(`/api/v1/contacts/${encodeURIComponent(did)}`, { method: 'DELETE' });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { deleted?: boolean };
  return body.deleted === true;
}
