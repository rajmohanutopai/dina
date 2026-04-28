/**
 * Contact directory — CRUD for contacts with trust levels and aliases.
 *
 * Each contact has:
 *   - DID (unique identifier)
 *   - Display name
 *   - Trust level: blocked, unknown, verified, trusted
 *   - Sharing tier: none, summary, full, locked
 *   - Aliases (unique across all contacts)
 *   - Notes (free-text relationship context)
 *
 * Alias uniqueness is enforced globally — no two contacts can share
 * the same alias. This prevents ambiguous person resolution.
 *
 * Source: ARCHITECTURE.md Section 2.50, Task 2.50
 */

import {
  validateAlias,
  validateRelationship,
  validateDataResponsibility,
  defaultResponsibility,
} from './validation';
import { getContactRepository } from './repository';
import { normalisePreferredForCategories, normalisePreferredForCategory } from './preferred_for';
import { addContact as addEgressGateContact } from '../d2d/gates';
import { getPeopleRepository } from '../people/repository';
import { addKnownContact } from '../trust/source_trust';

export type TrustLevel = 'blocked' | 'unknown' | 'verified' | 'trusted';
export type SharingTier = 'none' | 'summary' | 'full' | 'locked';
export type Relationship =
  | 'spouse'
  | 'child'
  | 'parent'
  | 'sibling'
  | 'friend'
  | 'colleague'
  | 'acquaintance'
  | 'unknown';
export type DataResponsibility = 'household' | 'care' | 'financial' | 'external';

export interface Contact {
  did: string;
  displayName: string;
  trustLevel: TrustLevel;
  sharingTier: SharingTier;
  relationship: Relationship;
  dataResponsibility: DataResponsibility;
  aliases: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
  /**
   * User-asserted "this is my go-to contact for X" category bindings
   * (PC-CORE-01). Values are normalised by
   * `normalisePreferredForCategories` (lowercase, trimmed, deduped,
   * empties dropped, first-seen order preserved) — callers should
   * never see mixed case or whitespace on reads.
   *
   * Absent / `undefined` means "no preferences set yet" and is
   * indistinguishable from `[]` for query purposes; the domain layer
   * does not distinguish the two states. Drives
   * `ContactRepository.findByPreferredFor(category)` for the
   * provider-services resolver (see design doc §6.1 and
   * PREFERRED_CONTACTS_PORT_TASKS.md).
   *
   * Replaces the auto-enriched `live_capability` annotation that used
   * to live on topic memories — capability bindings now belong to the
   * contact, not the topic. AppView remains the source of truth for
   * what a DID actually publishes; `preferredFor` captures the user's
   * choice of whom to route through.
   */
  preferredFor?: string[];
}

/** In-memory contact store keyed by DID. */
const contacts = new Map<string, Contact>();

/** Global alias → DID index for uniqueness enforcement. */
const aliasIndex = new Map<string, string>();

/**
 * Add a new contact. Throws if DID already exists or alias conflicts.
 *
 * If relationship is provided, dataResponsibility is auto-derived
 * via defaultResponsibility() (matching Go domain/contact.go):
 *   spouse/child → "household"
 *   all others → "external"
 */
export function addContact(
  did: string,
  displayName: string,
  trustLevel?: TrustLevel,
  sharingTier?: SharingTier,
  relationship?: Relationship,
): Contact {
  if (!did || did.trim().length === 0) throw new Error('contacts: DID is required');
  if (contacts.has(did)) throw new Error(`contacts: "${did}" already exists`);

  // Validate relationship if provided
  const rel = relationship ?? 'unknown';
  const relError = validateRelationship(rel);
  if (relError) throw new Error(`contacts: ${relError}`);

  const now = Date.now();
  const contact: Contact = {
    did,
    displayName: displayName.trim(),
    trustLevel: trustLevel ?? 'unknown',
    sharingTier: sharingTier ?? 'summary',
    relationship: rel,
    dataResponsibility: defaultResponsibility(rel) as DataResponsibility,
    aliases: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  };

  // GAP-PERSIST-01: write-through SQL FIRST, memory second. Previously
  // the SQL write was try/swallow — callers got "success" for a
  // contact that never landed in durable storage and silently
  // disappeared on next boot. Now a repo failure bubbles up and the
  // in-memory state stays consistent with disk.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.add(contact);
  contacts.set(did, contact);

  // Propagate to the D2D egress gate + inbound-trust classifier.
  // `d2d/gates.knownContacts` and `trust/source_trust.knownContacts`
  // are parallel sets that Core checks on every outbound send and
  // every inbound pipeline decision; without this sync, a user-added
  // contact would be visible in the People UI but rejected at the
  // egress gate ("Recipient is not a known contact") and classified
  // as "unknown" trust on inbound. `blocked` is intentionally NOT
  // added to the egress gate — the gate's allowlist semantics mean
  // only non-blocked contacts should be there; the destination block-
  // list handles blocked peers separately.
  if (contact.trustLevel !== 'blocked') {
    addEgressGateContact(did);
    addKnownContact(did);
  }

  // Mirror this contact into the people graph so the reminder
  // planner's `resolveSenderHint` can find a Person via
  // `findByContactDid` on inbound D2D, and so vault facts saved
  // under the contact's display name surface in FTS expansion.
  // Fail-soft: when the people repo isn't wired (test harness, or
  // a host that hasn't called `setPeopleRepository`) this is a
  // no-op rather than blocking the contact-add. Blocked contacts
  // are intentionally NOT mirrored — same rationale as the
  // egress-gate skip above (the people graph is for resolution,
  // and a blocked DID has nothing to resolve).
  if (contact.trustLevel !== 'blocked') {
    const peopleRepo = getPeopleRepository();
    if (peopleRepo !== null) {
      try {
        peopleRepo.upsertContactPerson(did, contact.displayName);
      } catch {
        // People-graph mirror is enrichment, not load-bearing for
        // contact creation — drop the error rather than fail the
        // user-visible "save contact" action. The next D2D from
        // this DID will still be quarantine-correct via the
        // contacts table; only the FTS surface expansion is missed.
      }
    }
  }

  return contact;
}

/**
 * Add a contact if it doesn't already exist (INSERT OR IGNORE semantics).
 *
 * Returns { contact, created: true } for new contacts, or
 * { contact, created: false } for existing contacts (no throw).
 * Matching Go's INSERT OR IGNORE behavior.
 */
export function addContactIfNotExists(
  did: string,
  displayName: string,
  trustLevel?: TrustLevel,
  sharingTier?: SharingTier,
  relationship?: Relationship,
): { contact: Contact; created: boolean } {
  const existing = contacts.get(did);
  if (existing) {
    return { contact: existing, created: false };
  }
  const contact = addContact(did, displayName, trustLevel, sharingTier, relationship);
  return { contact, created: true };
}

/** Get a contact by DID. Returns null if not found. */
export function getContact(did: string): Contact | null {
  const cached = contacts.get(did);
  if (cached !== undefined) return cached;
  // Cache miss: fall back to the SQL repo when wired. Closes the race
  // where a JS bundle reload (Expo fast-refresh / Cmd+R) clears the
  // in-memory Map while the underlying SQLite database — opened at
  // the native layer — survives. Without this, an inbound D2D
  // arriving before the next manual unlock sees `contactFound=false`,
  // resolves to `senderTrust='unknown'`, and the receive pipeline
  // quarantines the message even though the user has the sender as
  // a verified contact in the People tab. The SQL fetch hydrates the
  // single row; subsequent calls hit the cache.
  const repo = getContactRepository();
  if (repo === null) return null;
  const fromSql = repo.get(did);
  if (fromSql !== null) {
    contacts.set(did, fromSql);
    for (const alias of fromSql.aliases ?? []) {
      const key = alias.trim().toLowerCase();
      if (key !== '') aliasIndex.set(key, fromSql.did);
    }
    if (fromSql.trustLevel !== 'blocked') {
      addEgressGateContact(fromSql.did);
      addKnownContact(fromSql.did);
    }
  }
  return fromSql;
}

/** List all contacts. */
export function listContacts(): Contact[] {
  return [...contacts.values()];
}

/**
 * Update contact fields. Throws if not found.
 *
 * When relationship is updated, dataResponsibility is auto-re-derived
 * unless an explicit dataResponsibility override is provided.
 */
export function updateContact(
  did: string,
  updates: Partial<
    Pick<
      Contact,
      'displayName' | 'trustLevel' | 'sharingTier' | 'notes' | 'relationship' | 'dataResponsibility'
    >
  >,
): Contact {
  const contact = contacts.get(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);

  if (updates.displayName !== undefined) contact.displayName = updates.displayName.trim();
  if (updates.trustLevel !== undefined) contact.trustLevel = updates.trustLevel;
  if (updates.sharingTier !== undefined) contact.sharingTier = updates.sharingTier;
  if (updates.notes !== undefined) contact.notes = updates.notes;

  // Relationship update → auto-derive dataResponsibility
  if (updates.relationship !== undefined) {
    const relError = validateRelationship(updates.relationship);
    if (relError) throw new Error(`contacts: ${relError}`);
    contact.relationship = updates.relationship;
    // Auto-derive unless explicit override provided
    if (updates.dataResponsibility === undefined) {
      contact.dataResponsibility = defaultResponsibility(
        updates.relationship,
      ) as DataResponsibility;
    }
  }

  // Explicit dataResponsibility override (user-set vs auto-derived)
  // Fix: Codex #20 — validate the override value
  if (updates.dataResponsibility !== undefined) {
    const drError = validateDataResponsibility(updates.dataResponsibility);
    if (drError) throw new Error(`contacts: ${drError}`);
    contact.dataResponsibility = updates.dataResponsibility;
  }

  contact.updatedAt = Date.now();

  // GAP-PERSIST-01 write-through (same contract as add/delete): the
  // mutated row must reach SQL, otherwise renames + trust changes
  // disappear on next boot. Bug #2-class — caught by the cache↔SQL
  // parity contract test in `__tests__/contacts/directory.test.ts`.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.update(did, updates);

  return contact;
}

/** Delete a contact by DID. Returns true if found. */
export function deleteContact(did: string): boolean {
  const contact = contacts.get(did);
  if (!contact) return false;

  // Remove all aliases from the global index
  for (const alias of contact.aliases) {
    aliasIndex.delete(alias.toLowerCase());
  }

  contacts.delete(did);

  // Mirror of the addContact write-through (line 124): the in-memory
  // delete is not enough — without removing the SQL row, a subsequent
  // re-add of the same DID hits "UNIQUE constraint failed: contacts.did"
  // because hydrateContactDirectory replays the row on next boot too.
  // Caught on the simulator: removed contacts came back after reload,
  // and re-adding the same DID failed with the unique-constraint error.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.remove(did);

  return true;
}

/**
 * Add an alias to a contact. Throws if alias already taken.
 *
 * Aliases are globally unique (case-insensitive) across all contacts.
 */
export function addAlias(did: string, alias: string): void {
  const contact = contacts.get(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);

  // Validate alias: min 2 chars, not a reserved pronoun
  const validationError = validateAlias(alias);
  if (validationError) throw new Error(`contacts: ${validationError}`);

  const normalized = alias.trim().toLowerCase();

  const existingOwner = aliasIndex.get(normalized);
  if (existingOwner !== undefined) {
    if (existingOwner === did) return; // already assigned to this contact
    throw new Error(`contacts: alias "${alias}" already taken by ${existingOwner}`);
  }

  aliasIndex.set(normalized, did);
  contact.aliases.push(alias.trim());
  contact.updatedAt = Date.now();

  // GAP-PERSIST-01 write-through: aliases live in their own SQL table
  // (`contact_aliases`) — without this call the alias survives the
  // current process but vanishes on hydration after restart.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.addAlias(did, normalized);
}

/** Remove an alias from a contact. */
export function removeAlias(did: string, alias: string): void {
  const contact = contacts.get(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);

  const normalized = alias.trim().toLowerCase();
  aliasIndex.delete(normalized);
  contact.aliases = contact.aliases.filter((a) => a.toLowerCase() !== normalized);
  contact.updatedAt = Date.now();

  // GAP-PERSIST-01 write-through: same risk as addAlias — without the
  // SQL delete, removed aliases reappear on next boot via hydration.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.removeAlias(normalized);
}

/** Resolve a DID from an alias. Returns null if not found. */
export function resolveAlias(alias: string): string | null {
  return aliasIndex.get(alias.trim().toLowerCase()) ?? null;
}

/** Lookup contact by alias. Returns null if not found. */
export function findByAlias(alias: string): Contact | null {
  const did = resolveAlias(alias);
  return did ? (contacts.get(did) ?? null) : null;
}

/** Get contacts filtered by trust level. */
export function getContactsByTrust(trustLevel: TrustLevel): Contact[] {
  return [...contacts.values()].filter((c) => c.trustLevel === trustLevel);
}

// ---------------------------------------------------------------
// Fast-path ingress interfaces (matching Go contact.go)
// ---------------------------------------------------------------

/**
 * Check if a DID belongs to a known contact. O(1) lookup.
 *
 * Used by D2D receive pipeline for fast trust evaluation
 * without loading the full Contact object.
 */
export function isContact(did: string): boolean {
  return contacts.has(did);
}

/**
 * Get the trust level for a DID. Returns null if not a contact.
 *
 * Fast-path for ingress trust evaluation — avoids full contact
 * deserialization when only the trust level is needed.
 */
export function getTrustLevel(did: string): TrustLevel | null {
  const contact = contacts.get(did);
  return contact ? contact.trustLevel : null;
}

/**
 * Resolve a contact by display name or alias (case-insensitive).
 *
 * GAP-PERSIST-04: main-dina's staging processor builds a lowercase
 * `name_or_alias → contact` map for preference binding so texts like
 * "my dentist Dr Carl" match a contact stored as "Dr Carl Jones"
 * with alias "Dr Carl". Previously this function only compared
 * `displayName`, so the mobile preference binder would miss any
 * contact not stored under the exact form the text uses.
 *
 * Strategy: direct `aliasIndex` lookup first (O(1)), then
 * displayName sweep. Returns the first match; aliases are
 * guaranteed unique by `addAlias`.
 */
export function resolveByName(name: string): Contact | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (lower === '') return null;
  const aliasMatch = aliasIndex.get(lower);
  if (aliasMatch !== undefined) {
    const byAlias = contacts.get(aliasMatch);
    if (byAlias !== undefined) return byAlias;
  }
  for (const contact of contacts.values()) {
    if (contact.displayName.toLowerCase() === lower) {
      return contact;
    }
  }
  return null;
}

/**
 * GAP-PERSIST-02: Hydrate the in-memory directory from the SQL
 * contact repository. Called at boot (after storage init) so a
 * restart doesn't drop every persisted contact. A no-op when no
 * repository is wired; a SQL read failure throws so the caller can
 * decide whether to proceed with an empty directory (risky) or
 * abort boot.
 *
 * Returns the number of contacts loaded so the boot sequence can
 * log it.
 */
export function hydrateContactDirectory(): number {
  const sqlRepo = getContactRepository();
  if (sqlRepo === null) return 0;
  const rows = sqlRepo.list();
  // Pull the people repo once — `upsertContactPerson` is idempotent,
  // so backfilling on every boot is safe and self-healing for users
  // who created contacts before the people-graph mirror existed.
  const peopleRepo = getPeopleRepository();
  let loaded = 0;
  for (const row of rows) {
    contacts.set(row.did, row);
    for (const alias of row.aliases ?? []) {
      const key = alias.trim().toLowerCase();
      if (key !== '') aliasIndex.set(key, row.did);
    }
    // Mirror into the D2D egress gate + inbound trust classifier
    // (same sync we do on addContact). Without this, persisted
    // contacts load into `contacts` / `aliasIndex` but the egress
    // gate stays empty across a restart, so /chat/[did].send bounces
    // with "denied at contact" until the user re-adds them.
    if (row.trustLevel !== 'blocked') {
      addEgressGateContact(row.did);
      addKnownContact(row.did);
      // Backfill into the people graph on every boot. Idempotent —
      // re-runs on already-mirrored contacts just refresh the row.
      // Fail-soft: a missing people repo or a transient SQL error
      // shouldn't break contact hydration (the egress gate above is
      // the load-bearing piece).
      if (peopleRepo !== null) {
        try {
          peopleRepo.upsertContactPerson(row.did, row.displayName);
        } catch {
          /* enrichment only — see comment in addContact */
        }
      }
    }
    loaded++;
  }
  return loaded;
}

/** Reset all contact state (for testing). */
export function resetContactDirectory(): void {
  contacts.clear();
  aliasIndex.clear();
}

// ---------------------------------------------------------------
// PC-CORE-03 — preferredFor surface (in-memory + SQL write-through)
// ---------------------------------------------------------------

/**
 * Replace a contact's preferred_for category list. Input is
 * normalised (lowercased + trimmed + deduped + empties dropped) via
 * `normalisePreferredForCategories`. Empty input is a valid
 * "clear all preferences" operation.
 *
 * Throws when the contact doesn't exist.
 */
export function setPreferredFor(did: string, categories: readonly string[]): void {
  const contact = contacts.get(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  const normalised = normalisePreferredForCategories(categories);
  // GAP-PERSIST-01: SQL write-through must succeed before we mutate
  // in-memory state. A failed SQL write previously left memory and
  // disk diverged.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.setPreferredFor(did, normalised);
  contact.preferredFor = normalised;
  contact.updatedAt = Date.now();
}

/**
 * Read a contact's preferred_for list. Returns `[]` when the contact
 * has no preferences set (never returns undefined). Throws when the
 * contact doesn't exist.
 */
export function getPreferredFor(did: string): string[] {
  const contact = contacts.get(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  // Return a fresh array — the in-memory Contact's `preferredFor` is
  // a mutable reference; callers must not be able to append through it
  // and surprise other readers.
  return [...(contact.preferredFor ?? [])];
}

/**
 * Return contacts whose preferred_for list contains `category`
 * (case-insensitive). Empty / whitespace-only category → `[]` (no
 * "match anything" semantics; the resolver always passes a concrete
 * intent).
 */
export function findByPreferredFor(category: string): Contact[] {
  const needle = normalisePreferredForCategory(category);
  if (needle === '') return [];
  const matches: Contact[] = [];
  for (const contact of contacts.values()) {
    if ((contact.preferredFor ?? []).includes(needle)) {
      matches.push(contact);
    }
  }
  return matches;
}
