/**
 * The names Brain hides from a cloud model (docs/PII_ARCHITECTURE_V2.md §5):
 * the people the owner talks about, grouped by person, built from the people
 * graph and the contact list. Brain gets only these strings and an opaque
 * group number per person — no person IDs, DIDs or relationships.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isRelationshipPhrase } from '../people/relationship_words';

import type { Contact } from '../contacts/directory';
import type { Person } from '../people/domain';

/** Surface types that name someone; `role_phrase` ("my doctor") names no one. */
const NAMING_SURFACE_TYPES: ReadonlySet<string> = new Set(['name', 'nickname', 'alias']);

// Relationship words are read by the shared helper (people/relationship_words.ts).


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
  if (isRelationshipPhrase(trimmed)) return null;
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
 * Version of a names list: a hash of its content (REAL_LIFE_FIXES §4.3).
 * Core builds the list from the people graph and contacts on every read, so
 * a content hash changes whenever any write changes the list, with no
 * counter to bump at each write site, and it survives restarts.
 */
export function piiNamesVersion(groups: readonly PiiNameGroup[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(groups)))).slice(0, 32);
}

/** One read of the names list: the list, or "unchanged" when the caller's copy is current. */
export interface PiiNamesResult {
  version: string;
  /** Present unless `unchanged`. */
  groups?: PiiNameGroup[];
  /** The caller's `known` version is current; no list sent. */
  unchanged?: boolean;
}

/** Read a names result off the wire; malformed input reads as no answer. */
export function readPiiNamesResult(value: unknown): PiiNamesResult {
  const raw = (value ?? {}) as { version?: unknown; groups?: unknown; unchanged?: unknown };
  if (typeof raw.version !== 'string' || raw.version === '') {
    throw new Error('piiNames: answer has no version');
  }
  if (raw.unchanged === true) return { version: raw.version, unchanged: true };
  return { version: raw.version, groups: readPiiNameGroups(raw.groups) };
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
