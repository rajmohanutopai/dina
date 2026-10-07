/**
 * The names Brain hides from a cloud model (docs/PII_ARCHITECTURE_V2.md §5):
 * the people the owner talks about, grouped by person, built from the people
 * graph and the contact list. Brain gets only these strings and an opaque
 * group number per person — no person IDs, DIDs or relationships.
 */

import type { Contact } from '../contacts/directory';
import type { Person } from '../people/domain';

/** Surface types that name someone; `role_phrase` ("my doctor") names no one. */
const NAMING_SURFACE_TYPES: ReadonlySet<string> = new Set(['name', 'nickname', 'alias']);

/**
 * Words that name a relationship and are never anyone's given name, for a
 * person whose relationship the graph does not record. Short on purpose: a
 * word here is never hidden, so a real name on this list would leak; a
 * relationship word missing from it is only hidden when it need not be.
 * Each person's own `relationshipHint` (in the owner's words and language)
 * covers the rest.
 */
const RELATIONSHIP_WORDS: ReadonlySet<string> = new Set([
  'mom',
  'mum',
  'mother',
  'dad',
  'father',
  'wife',
  'husband',
  'son',
  'daughter',
  'brother',
  'sister',
  'grandmother',
  'grandfather',
  'grandma',
  'grandpa',
  'aunt',
  'uncle',
  'cousin',
  'nephew',
  'niece',
  'boss',
]);

/** One person's names: the strings Brain hides, under one group number. */
export interface PiiNameGroup {
  group: number;
  names: string[];
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The name as hidden, or null when it is not a name: under two letters, or
 * a relationship ("Mom", "my brother", or this person's own hint).
 */
function keep(name: string, hint: string): string | null {
  const trimmed = squeeze(name);
  if (trimmed.length < 2) return null;
  const lower = trimmed.toLowerCase();
  const bare = lower.replace(/^(my|our)\s+/, '');
  if (RELATIONSHIP_WORDS.has(bare)) return null;
  if (hint !== '' && bare === hint) return null;
  return trimmed;
}

/**
 * Build the name groups. A contact joins its person's group; a contact whose
 * person is not in the list forms its own group. Within the whole answer a
 * name appears once (first group wins), so no string maps to two people.
 */
export function buildPiiNameGroups(
  people: readonly Person[],
  contacts: readonly Contact[],
): PiiNameGroup[] {
  const byPerson = new Map<string, string[]>();
  const hints = new Map<string, string>();
  const order: string[] = [];
  const add = (key: string, name: string): void => {
    const kept = keep(name, hints.get(key) ?? '');
    if (kept === null) return;
    let names = byPerson.get(key);
    if (names === undefined) {
      names = [];
      byPerson.set(key, names);
      order.push(key);
    }
    names.push(kept);
  };

  for (const person of people) {
    if (person.status === 'rejected') continue;
    hints.set(person.personId, squeeze(person.relationshipHint).toLowerCase());
    add(person.personId, person.canonicalName);
    for (const surface of person.surfaces ?? []) {
      if (surface.status === 'rejected' || !NAMING_SURFACE_TYPES.has(surface.surfaceType)) continue;
      add(person.personId, surface.surface);
    }
  }
  for (const contact of contacts) {
    const key = contact.personId !== '' ? contact.personId : `contact:${contact.did}`;
    add(key, contact.displayName);
    for (const alias of contact.aliases) add(key, alias);
  }

  const seen = new Set<string>();
  const out: PiiNameGroup[] = [];
  for (const key of order) {
    const names: string[] = [];
    for (const name of byPerson.get(key) ?? []) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      names.push(name);
    }
    if (names.length > 0) out.push({ group: out.length + 1, names });
  }
  return out;
}

/**
 * Read name groups off the wire: anything not shaped as groups of strings is
 * dropped, never trusted.
 */
export function readPiiNameGroups(value: unknown): PiiNameGroup[] {
  if (!Array.isArray(value)) return [];
  const out: PiiNameGroup[] = [];
  for (const g of value as unknown[]) {
    if (g === null || typeof g !== 'object') continue;
    const { group, names } = g as { group?: unknown; names?: unknown };
    if (!Number.isSafeInteger(group) || !Array.isArray(names)) continue;
    const strings = (names as unknown[]).filter(
      (n): n is string => typeof n === 'string' && n.trim().length >= 2,
    );
    if (strings.length > 0) out.push({ group: group as number, names: strings });
  }
  return out;
}
