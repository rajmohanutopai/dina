/**
 * Contact directory — CRUD for contacts with trust levels and aliases.
 *
 * **Person-keyed (people graph is the hub).** Contact *policy* (trust
 * level, sharing tier, preferred-for, …) is stored once per
 * `person_id`, shared across that person's devices/identities. The
 * public API stays DID-facing — `getContact(did)`, `isContact(did)`,
 * etc. — and resolves `did → person_id` through the people graph
 * (`person_identities`). `establishContact()` is the single mutation
 * path: it ensures the person + DID identity + confirmed name surface
 * exist, then writes the contact policy and syncs the D2D projections.
 * See docs/IDENTITY_HUB_REDESIGN.md §3.4 / §4.
 *
 * Each contact has:
 *   - person_id (canonical key) + a primary DID (display/back-compat)
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
import {
  addContact as addEgressGateContact,
  removeContact as removeEgressGateContact,
} from '../d2d/gates';
import { getPeopleRepository, type PeopleRepository } from '../people/repository';
import { addKnownContact, removeKnownContact } from '../peerlens/source_trust';

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
  /** Canonical key — the people-graph person this contact policy is for. */
  personId: string;
  /**
   * The contact's primary DID (back-compat + display). Contacts have
   * exactly one DID today; when a person carries multiple DIDs this is
   * the primary one. Resolved from `person_identities`.
   */
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

/** In-memory contact policy store, keyed by person_id (source of truth). */
const contactsByPerson = new Map<string, Contact>();

/** did → person_id index for O(1) DID-facing lookups (ingress fast-path). */
const didIndex = new Map<string, string>();

/** Global normalized-alias → person_id index for uniqueness enforcement. */
const aliasIndex = new Map<string, string>();

// ---------------------------------------------------------------
// People-graph resolution helpers
// ---------------------------------------------------------------

/**
 * The people repo is a required dependency of contact policy: a
 * contact is policy *for a person*, so we must resolve/create the
 * person before storing policy. Throws (rather than silently using
 * the DID as a pseudo person_id) so a missing wiring is loud, not a
 * data-shape footgun.
 */
function requirePeopleRepo(): PeopleRepository {
  const repo = getPeopleRepository();
  if (repo === null) {
    throw new Error('contacts: people repository is not wired (required for contact policy)');
  }
  return repo;
}

/** did → person_id via the people graph, or null when unknown / no repo. */
function resolvePersonId(did: string): string | null {
  const repo = getPeopleRepository();
  if (repo === null) return null;
  return repo.resolveByIdentity('did', did)?.personId ?? null;
}

/** Every DID identity bound to a person, primary first. */
function listPersonDids(personId: string): string[] {
  const repo = getPeopleRepository();
  if (repo === null) return [];
  return repo
    .listIdentities(personId)
    .filter((i) => i.identityType === 'did')
    .map((i) => i.identityValue);
}

/**
 * Sync the D2D egress gate + inbound source-trust projections for a
 * person from its current contact policy. A person's DIDs are gate-
 * eligible iff a non-blocked contact policy exists; otherwise they're
 * pruned. This is the removal path block/delete were missing. Blocked
 * contacts (and persons with no policy) are removed from both sets.
 */
function syncProjections(personId: string): void {
  const contact = contactsByPerson.get(personId);
  const eligible = contact !== undefined && contact.trustLevel !== 'blocked';
  for (const did of listPersonDids(personId)) {
    if (eligible) {
      addEgressGateContact(did);
      addKnownContact(did);
    } else {
      removeEgressGateContact(did);
      removeKnownContact(did);
    }
  }
}

// ---------------------------------------------------------------
// establishContact — the single contact-mutation path
// ---------------------------------------------------------------

export interface EstablishContactOptions {
  trustLevel?: TrustLevel;
  sharingTier?: SharingTier;
  relationship?: Relationship;
  dataResponsibility?: DataResponsibility;
}

/**
 * Add-or-update a trusted person. The ONE way contact policy is
 * mutated. Atomically (per layer): ensures the person + DID identity +
 * confirmed name surface (people graph), writes the contact policy
 * (SQL, by person_id), updates the in-memory caches, and syncs the
 * D2D projections. Idempotent — calling again for the same DID updates
 * in place. Requires a wired people repo.
 */
export function establishContact(
  did: string,
  displayName: string,
  opts?: EstablishContactOptions,
): Contact {
  if (!did || did.trim().length === 0) throw new Error('contacts: DID is required');

  const rel = opts?.relationship ?? 'unknown';
  const relError = validateRelationship(rel);
  if (relError) throw new Error(`contacts: ${relError}`);

  const peopleRepo = requirePeopleRepo();
  // People graph is the hub: this creates (or reuses) the person, the
  // DID identity, and a confirmed display-name surface. Returns the
  // canonical person_id the contact policy is keyed by.
  const personId = peopleRepo.upsertContactPerson(did, displayName);

  const now = Date.now();
  const sqlRepo = getContactRepository();
  // Decide INSERT-vs-UPDATE from the DURABLE store, not just the
  // in-memory cache: on a cold cache (e.g. before hydration) the
  // policy row may already exist in SQL, and an INSERT would violate
  // the person_id PK. Fall back to the repo when the cache misses.
  const existing = contactsByPerson.get(personId) ?? sqlRepo?.get(personId) ?? undefined;
  const contact: Contact = {
    personId,
    did,
    displayName: displayName.trim(),
    trustLevel: opts?.trustLevel ?? existing?.trustLevel ?? 'unknown',
    sharingTier: opts?.sharingTier ?? existing?.sharingTier ?? 'summary',
    relationship: rel,
    dataResponsibility:
      opts?.dataResponsibility ?? (defaultResponsibility(rel) as DataResponsibility),
    aliases: existing?.aliases ?? [],
    notes: existing?.notes ?? '',
    // Leave undefined for a brand-new contact (the domain treats
    // undefined and [] as the same "no preferences" state); only carry
    // an existing list forward. Matches the pre-redesign behaviour.
    preferredFor: existing?.preferredFor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // GAP-PERSIST-01: write-through SQL FIRST, memory second.
  if (sqlRepo) {
    if (existing) sqlRepo.update(personId, contact);
    else sqlRepo.add(contact);
  }
  contactsByPerson.set(personId, contact);
  didIndex.set(did, personId);
  syncProjections(personId);
  return contact;
}

/**
 * Remove a contact's policy + prune its projections, but PRESERVE the
 * person + history (surfaces, notes) in the people graph. Returns
 * false when no policy existed. The DID→person mapping is preserved
 * too (the person still exists), so a later re-add re-establishes
 * policy without losing identity.
 */
export function removeContact(personId: string): boolean {
  const contact = contactsByPerson.get(personId);
  if (!contact) return false;

  for (const alias of contact.aliases) {
    aliasIndex.delete(alias.toLowerCase());
  }
  // Prune projections for every DID this person owns BEFORE dropping
  // the policy row (syncProjections reads the policy to decide).
  for (const did of listPersonDids(personId)) {
    removeEgressGateContact(did);
    removeKnownContact(did);
    didIndex.delete(did);
  }
  contactsByPerson.delete(personId);

  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.remove(personId);
  return true;
}

// ---------------------------------------------------------------
// DID-facing public API (resolves did -> person internally)
// ---------------------------------------------------------------

/**
 * Add a new contact. Throws if a contact policy already exists for the
 * resolved person, or if the alias conflicts.
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
  const existingPersonId = resolvePersonId(did);
  if (existingPersonId !== null && contactsByPerson.has(existingPersonId)) {
    throw new Error(`contacts: "${did}" already exists`);
  }
  return establishContact(did, displayName, { trustLevel, sharingTier, relationship });
}

/**
 * Add a contact if it doesn't already exist (INSERT OR IGNORE semantics).
 *
 * Returns { contact, created: true } for new contacts, or
 * { contact, created: false } for existing contacts (no throw). On an
 * existing contact the stored data is returned unchanged (no update).
 */
export function addContactIfNotExists(
  did: string,
  displayName: string,
  trustLevel?: TrustLevel,
  sharingTier?: SharingTier,
  relationship?: Relationship,
): { contact: Contact; created: boolean } {
  const existing = getContact(did);
  if (existing) {
    return { contact: existing, created: false };
  }
  const contact = addContact(did, displayName, trustLevel, sharingTier, relationship);
  return { contact, created: true };
}

/** Get a contact by DID. Returns null if not found. */
export function getContact(did: string): Contact | null {
  const cachedPersonId = didIndex.get(did);
  if (cachedPersonId !== undefined) {
    const cached = contactsByPerson.get(cachedPersonId);
    if (cached !== undefined) return cached;
  }
  // Cache miss: resolve did→person→policy from durable stores. Closes
  // the JS-bundle reload race (Expo fast-refresh clears the in-memory
  // Maps while SQLite survives at the native layer). The people graph
  // (person_identities) gives us did→person_id; the contact repo gives
  // the policy. Without this, an inbound D2D before the next unlock
  // sees no contact and the receive pipeline quarantines a verified
  // sender.
  const personId = resolvePersonId(did);
  if (personId === null) return null;
  const repo = getContactRepository();
  if (repo === null) return null;
  const fromSql = repo.get(personId);
  if (fromSql === null) return null;

  // The SQL row is person-keyed and carries no DID — fill it with the
  // person's primary DID (fall back to the looked-up DID).
  const dids = listPersonDids(personId);
  fromSql.did = dids[0] ?? did;
  contactsByPerson.set(personId, fromSql);
  for (const d of dids.length > 0 ? dids : [did]) {
    didIndex.set(d, personId);
  }
  for (const alias of fromSql.aliases ?? []) {
    const key = alias.trim().toLowerCase();
    if (key !== '') aliasIndex.set(key, personId);
  }
  // Single source of truth for projection state — adds the DIDs when
  // non-blocked, prunes them when blocked.
  syncProjections(personId);
  return fromSql;
}

/** List all contacts. */
export function listContacts(): Contact[] {
  return [...contactsByPerson.values()];
}

/**
 * Update contact fields. Throws if not found.
 *
 * When relationship is updated, dataResponsibility is auto-re-derived
 * unless an explicit dataResponsibility override is provided. A
 * trust-level change re-syncs the D2D projections (e.g. flipping to
 * `blocked` prunes the sender from the gate + source-trust sets).
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
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  const personId = contact.personId;

  if (updates.displayName !== undefined) contact.displayName = updates.displayName.trim();
  const trustChanged =
    updates.trustLevel !== undefined && updates.trustLevel !== contact.trustLevel;
  if (updates.trustLevel !== undefined) contact.trustLevel = updates.trustLevel;
  if (updates.sharingTier !== undefined) contact.sharingTier = updates.sharingTier;
  if (updates.notes !== undefined) contact.notes = updates.notes;

  // Relationship update → auto-derive dataResponsibility
  if (updates.relationship !== undefined) {
    const relError = validateRelationship(updates.relationship);
    if (relError) throw new Error(`contacts: ${relError}`);
    contact.relationship = updates.relationship;
    if (updates.dataResponsibility === undefined) {
      contact.dataResponsibility = defaultResponsibility(
        updates.relationship,
      ) as DataResponsibility;
    }
  }

  // Explicit dataResponsibility override (user-set vs auto-derived)
  if (updates.dataResponsibility !== undefined) {
    const drError = validateDataResponsibility(updates.dataResponsibility);
    if (drError) throw new Error(`contacts: ${drError}`);
    contact.dataResponsibility = updates.dataResponsibility;
  }

  contact.updatedAt = Date.now();

  // GAP-PERSIST-01 write-through (by person_id).
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.update(personId, updates);

  // A trust change flips gate eligibility (block prunes, unblock restores).
  if (trustChanged) syncProjections(personId);

  return contact;
}

/** Delete a contact by DID. Returns true if found. Preserves the person. */
export function deleteContact(did: string): boolean {
  const personId = didIndex.get(did) ?? resolvePersonId(did);
  if (personId === null) return false;
  if (!contactsByPerson.has(personId)) {
    // Cache may be cold (post-reload) — try to hydrate so removeContact
    // has the policy + aliases to prune.
    if (getContact(did) === null) return false;
  }
  return removeContact(personId);
}

/**
 * Add an alias to a contact. Throws if alias already taken.
 *
 * Aliases are globally unique (case-insensitive) across all contacts.
 */
export function addAlias(did: string, alias: string): void {
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  const personId = contact.personId;

  const validationError = validateAlias(alias);
  if (validationError) throw new Error(`contacts: ${validationError}`);

  const normalized = alias.trim().toLowerCase();

  const existingOwner = aliasIndex.get(normalized);
  if (existingOwner !== undefined) {
    if (existingOwner === personId) return; // already assigned to this contact
    throw new Error(`contacts: alias "${alias}" already taken by ${existingOwner}`);
  }

  aliasIndex.set(normalized, personId);
  contact.aliases.push(alias.trim());
  contact.updatedAt = Date.now();

  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.addAlias(personId, normalized);
}

/** Remove an alias from a contact. */
export function removeAlias(did: string, alias: string): void {
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);

  const normalized = alias.trim().toLowerCase();
  aliasIndex.delete(normalized);
  contact.aliases = contact.aliases.filter((a) => a.toLowerCase() !== normalized);
  contact.updatedAt = Date.now();

  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.removeAlias(normalized);
}

/** Resolve a DID from an alias. Returns the contact's primary DID, or null. */
export function resolveAlias(alias: string): string | null {
  const personId = aliasIndex.get(alias.trim().toLowerCase());
  if (personId === undefined) return null;
  return contactsByPerson.get(personId)?.did ?? null;
}

/** Lookup contact by alias. Returns null if not found. */
export function findByAlias(alias: string): Contact | null {
  const personId = aliasIndex.get(alias.trim().toLowerCase());
  return personId !== undefined ? (contactsByPerson.get(personId) ?? null) : null;
}

/** Get contacts filtered by trust level. */
export function getContactsByTrust(trustLevel: TrustLevel): Contact[] {
  return [...contactsByPerson.values()].filter((c) => c.trustLevel === trustLevel);
}

// ---------------------------------------------------------------
// Fast-path ingress interfaces (matching Go contact.go)
// ---------------------------------------------------------------

/**
 * Check if a DID belongs to a known contact. Resolves did→person and
 * checks for a policy (hydrating from SQL on a cold cache).
 */
export function isContact(did: string): boolean {
  return getContact(did) !== null;
}

/**
 * Get the trust level for a DID. Returns null if not a contact.
 */
export function getTrustLevel(did: string): TrustLevel | null {
  return getContact(did)?.trustLevel ?? null;
}

/**
 * Resolve a contact by display name or alias (case-insensitive).
 *
 * GAP-PERSIST-04: main-dina's staging processor builds a lowercase
 * `name_or_alias → contact` map for preference binding so texts like
 * "my dentist Dr Carl" match a contact stored as "Dr Carl Jones"
 * with alias "Dr Carl".
 *
 * Strategy: direct `aliasIndex` lookup first (O(1)), then displayName
 * sweep. Returns the first match; aliases are unique by `addAlias`.
 */
export function resolveByName(name: string): Contact | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (lower === '') return null;
  const aliasPerson = aliasIndex.get(lower);
  if (aliasPerson !== undefined) {
    const byAlias = contactsByPerson.get(aliasPerson);
    if (byAlias !== undefined) return byAlias;
  }
  for (const contact of contactsByPerson.values()) {
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
 * decide whether to proceed with an empty directory (risky) or abort.
 *
 * Resolves each person's DIDs from the people graph to rebuild the
 * did→person index and the D2D projections. Returns the number of
 * contacts loaded.
 */
export function hydrateContactDirectory(): number {
  const sqlRepo = getContactRepository();
  if (sqlRepo === null) return 0;
  const peopleRepo = getPeopleRepository();
  const rows = sqlRepo.list();
  let loaded = 0;
  for (const row of rows) {
    const personId = row.personId;
    const dids =
      peopleRepo === null
        ? []
        : peopleRepo
            .listIdentities(personId)
            .filter((i) => i.identityType === 'did')
            .map((i) => i.identityValue);
    row.did = dids[0] ?? '';
    contactsByPerson.set(personId, row);
    for (const alias of row.aliases ?? []) {
      const key = alias.trim().toLowerCase();
      if (key !== '') aliasIndex.set(key, personId);
    }
    for (const did of dids) didIndex.set(did, personId);
    // Single projection-sync path (same as establishContact / getContact):
    // adds non-blocked contacts to the D2D gate + inbound trust set,
    // prunes blocked ones.
    syncProjections(personId);
    loaded++;
  }
  return loaded;
}

/** Reset all contact state (for testing). */
export function resetContactDirectory(): void {
  contactsByPerson.clear();
  didIndex.clear();
  aliasIndex.clear();
}

// ---------------------------------------------------------------
// PC-CORE-03 — preferredFor surface (in-memory + SQL write-through)
// ---------------------------------------------------------------

/**
 * Replace a contact's preferred_for category list. Input is normalised
 * (lowercased + trimmed + deduped + empties dropped). Empty input is a
 * valid "clear all preferences" operation. Throws when the contact
 * doesn't exist.
 */
export function setPreferredFor(did: string, categories: readonly string[]): void {
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  const normalised = normalisePreferredForCategories(categories);
  // GAP-PERSIST-01: SQL write-through must succeed before in-memory mutation.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.setPreferredFor(contact.personId, normalised);
  contact.preferredFor = normalised;
  contact.updatedAt = Date.now();
}

/**
 * Read a contact's preferred_for list. Returns `[]` when the contact
 * has no preferences set (never undefined). Throws when the contact
 * doesn't exist.
 */
export function getPreferredFor(did: string): string[] {
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);
  return [...(contact.preferredFor ?? [])];
}

/**
 * Return contacts whose preferred_for list contains `category`
 * (case-insensitive). Empty / whitespace-only category → `[]`.
 */
export function findByPreferredFor(category: string): Contact[] {
  const needle = normalisePreferredForCategory(category);
  if (needle === '') return [];
  const matches: Contact[] = [];
  for (const contact of contactsByPerson.values()) {
    if ((contact.preferredFor ?? []).includes(needle)) {
      matches.push(contact);
    }
  }
  return matches;
}
