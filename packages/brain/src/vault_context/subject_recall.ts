/**
 * Structured subject-link recall for an inbound sender — runtime-agnostic.
 *
 * Given a sender DID, resolve it to a person and fetch the memories that
 * person is a *subject* of (`vault_item_subjects`). Used to seed the
 * agentic remember loop so a D2D arrival ("I'm coming over" from a DID,
 * no name) can be enriched with the sender's remembered preferences —
 * the structured `did → person_id → subjects` edge, not name/FTS guessing.
 *
 * In-process (mobile): reads the local people + vault repos directly.
 * Out-of-process (home-node-lite): resolves through the people + vault
 * read backends (Core HTTP). The caller doesn't need to know which.
 */

import { getContact, getPeopleRepository, getVaultRepository } from '@dina/core';

import { getContactReadBackend, getPeopleReadBackend, getVaultReadBackend } from './assembly';

/** Extract the recall-relevant text from a vault item / wire item. */
function itemText(item: { content_l0?: string; summary?: string }): string {
  return (item.content_l0 || item.summary || '').trim();
}

/**
 * Memories the sender is a subject of, newest-linked first, deduped and
 * capped at `limit`. Empty when there's no sender DID, no resolvable
 * person, or no linked memories.
 */
export async function recallSenderSubjectMemories(
  senderDid: string,
  personas: string[],
  limit: number,
): Promise<string[]> {
  if (senderDid === '' || personas.length === 0 || limit <= 0) return [];

  // 1. Resolve sender DID → person_id (in-process repo, else HTTP backend).
  let personId = getPeopleRepository()?.resolveByIdentity('did', senderDid)?.personId ?? '';
  if (personId === '') {
    const peopleBackend = getPeopleReadBackend();
    if (peopleBackend?.peopleResolveByDid !== undefined) {
      personId = (await peopleBackend.peopleResolveByDid(senderDid))?.personId ?? '';
    }
  }
  if (personId === '') return [];

  return fetchSubjectMemories(personId, personas, limit);
}

/** Inner step 2 of recall — split out only to keep the resolver readable. */
async function fetchSubjectMemories(
  personId: string,
  personas: string[],
  limit: number,
): Promise<string[]> {
  // 2. Fetch subject-linked memories across the candidate personas.
  const vaultBackend = getVaultReadBackend();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const persona of personas) {
    if (out.length >= limit) break;
    let texts: string[] = [];
    const repo = getVaultRepository(persona);
    if (repo !== null) {
      texts = repo.getItemsForPersonSync(personId, limit).map(itemText);
    } else if (vaultBackend?.vaultItemsForPerson !== undefined) {
      const items = await vaultBackend.vaultItemsForPerson(persona, personId, limit);
      texts = items.map((i) => itemText(i as { content_l0?: string; summary?: string }));
    }
    for (const t of texts) {
      if (t === '' || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Resolve an inbound sender DID → display name (+ relationship), for the
 * `Sender:` enrichment line on a D2D arrival. Dual-path like
 * `recallSenderSubjectMemories`:
 *   - out-of-process (home-node-lite): the contact directory lives in Core —
 *     resolve via the HTTP backend so we don't read Brain's empty in-process
 *     directory (the dual-identity trap the read-backends exist to avoid);
 *   - in-process (mobile): read Core's local contact directory directly.
 * Returns null for a non-DID, no resolvable contact, or a contact with no name.
 * The relationship is omitted when `unknown`/empty (→ a bare `Sender: <name>`).
 */
export async function resolveSenderIdentity(
  senderDid: string,
): Promise<{ name: string; relationship?: string } | null> {
  if (senderDid === '' || !senderDid.startsWith('did:')) return null;
  const backend = getContactReadBackend();
  const contact: unknown =
    backend !== null ? await backend.contactLookup(senderDid) : getContact(senderDid);
  const c = contact as { displayName?: unknown; relationship?: unknown } | null;
  const name = typeof c?.displayName === 'string' ? c.displayName.trim() : '';
  if (name === '') return null;
  const rel = typeof c?.relationship === 'string' ? c.relationship.trim() : '';
  return rel !== '' && rel !== 'unknown' ? { name, relationship: rel } : { name };
}
