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
  addContact as addEgressGateContact,
  removeContact as removeEgressGateContact,
  clearGateContacts as clearEgressGateContacts,
} from '../d2d/gates';
import {
  addKnownContact,
  removeKnownContact,
  clearKnownContacts as clearSourceTrustContacts,
} from '../peerlens/source_trust';
import { getPeopleRepository, type PeopleRepository } from '../people/repository';
import { getVaultRepository, listVaultPersonas } from '../vault/repository';

import { normalisePreferredForCategories, normalisePreferredForCategory } from './preferred_for';
import { getContactRepository } from './repository';
import {
  validateAlias,
  validateRelationship,
  validateDataResponsibility,
  defaultResponsibility,
} from './validation';

/**
 * Valid trust levels (runtime list = single source of truth; `TrustLevel`
 * is derived from it). Callers that accept a trust level off the wire must
 * validate against `isTrustLevel` before casting — the projection in
 * `syncProjections` treats anything !== 'blocked' as gate-eligible, so an
 * unvalidated bogus value becomes effectively trusted.
 */
export const TRUST_LEVELS = ['blocked', 'unknown', 'verified', 'trusted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export function isTrustLevel(v: unknown): v is TrustLevel {
  return typeof v === 'string' && (TRUST_LEVELS as readonly string[]).includes(v);
}
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

  // Validate a caller-supplied relationship up front (fail before any
  // write). When omitted we preserve the existing value, which is already
  // valid, so there's nothing to validate yet.
  if (opts?.relationship !== undefined) {
    const relError = validateRelationship(opts.relationship);
    if (relError) throw new Error(`contacts: ${relError}`);
  }

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

  // Preserve a richer existing relationship + its derived dataResponsibility
  // on a re-add that doesn't specify them. A cold-cache duplicate add must
  // NOT reset spouse→unknown / household→external just because opts omitted
  // them (matches how trustLevel/sharingTier already fall back to existing).
  const relationship: Relationship = opts?.relationship ?? existing?.relationship ?? 'unknown';
  const dataResponsibility: DataResponsibility =
    opts?.dataResponsibility ??
    (opts?.relationship !== undefined
      ? (defaultResponsibility(opts.relationship) as DataResponsibility) // caller changed relationship → re-derive
      : (existing?.dataResponsibility ?? // caller left it alone → keep what was stored
        (defaultResponsibility(relationship) as DataResponsibility))); // brand-new → derive from effective

  const contact: Contact = {
    personId,
    did,
    displayName: displayName.trim(),
    trustLevel: opts?.trustLevel ?? existing?.trustLevel ?? 'unknown',
    sharingTier: opts?.sharingTier ?? existing?.sharingTier ?? 'summary',
    relationship,
    dataResponsibility,
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

  // SQL first — drop the durable policy row before mutating memory + D2D
  // projections, so a failed delete throws here with caches/gates intact
  // (rather than leaving a contact pruned from the gate but live on disk).
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.remove(personId);

  for (const alias of contact.aliases) {
    aliasIndex.delete(alias.toLowerCase());
  }
  // Prune projections for every DID this person owns. (Order vs the SQL
  // drop is safe: listPersonDids reads the people graph, not the contact
  // row we just removed.)
  for (const did of listPersonDids(personId)) {
    removeEgressGateContact(did);
    removeKnownContact(did);
    didIndex.delete(did);
  }
  contactsByPerson.delete(personId);
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

  // Compute the resolved next state on a copy — validate + derive BEFORE
  // touching either store, so a validation throw mutates nothing. `next`
  // carries the FULL effective field set (incl. relationship-derived
  // dataResponsibility), which is what gets persisted: `update()` writes
  // exactly the fields handed to it, so passing the raw `updates` partial
  // would silently drop a derived dataResponsibility from SQL.
  const next: Contact = { ...contact };
  const trustChanged =
    updates.trustLevel !== undefined && updates.trustLevel !== contact.trustLevel;
  if (updates.displayName !== undefined) next.displayName = updates.displayName.trim();
  if (updates.trustLevel !== undefined) next.trustLevel = updates.trustLevel;
  if (updates.sharingTier !== undefined) next.sharingTier = updates.sharingTier;
  if (updates.notes !== undefined) next.notes = updates.notes;

  // Relationship update → auto-derive dataResponsibility
  if (updates.relationship !== undefined) {
    const relError = validateRelationship(updates.relationship);
    if (relError) throw new Error(`contacts: ${relError}`);
    next.relationship = updates.relationship;
    if (updates.dataResponsibility === undefined) {
      next.dataResponsibility = defaultResponsibility(
        updates.relationship,
      ) as DataResponsibility;
    }
  }

  // Explicit dataResponsibility override (user-set vs auto-derived)
  if (updates.dataResponsibility !== undefined) {
    const drError = validateDataResponsibility(updates.dataResponsibility);
    if (drError) throw new Error(`contacts: ${drError}`);
    next.dataResponsibility = updates.dataResponsibility;
  }

  next.updatedAt = Date.now();

  // SQL FIRST, memory second: a failed durable write throws here and the
  // cached contact is left untouched, so memory never runs ahead of disk.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.update(personId, next);
  Object.assign(contact, next);

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

  // SQL is authoritative for alias ownership. The in-memory `aliasIndex`
  // can be cold/un-hydrated, so checking it alone would let a new contact
  // "claim" an alias a persisted contact already owns — and the repo's
  // idempotent INSERT OR IGNORE would then silently drop the write while
  // memory recorded the wrong owner. Resolve the durable owner first.
  const sqlRepo = getContactRepository();
  const owner = sqlRepo ? sqlRepo.resolveAlias(normalized) : (aliasIndex.get(normalized) ?? null);
  if (owner !== null && owner !== undefined) {
    if (owner === personId) {
      // Already ours — make the in-memory view consistent + no-op.
      aliasIndex.set(normalized, personId);
      if (!contact.aliases.some((a) => a.toLowerCase() === normalized)) {
        contact.aliases.push(alias.trim());
      }
      return;
    }
    throw new Error(`contacts: alias "${alias}" already taken by ${owner}`);
  }

  // Unowned everywhere — claim it. SQL first, then memory, so a failed
  // durable write throws before the in-memory index diverges from disk.
  if (sqlRepo) sqlRepo.addAlias(personId, normalized);
  aliasIndex.set(normalized, personId);
  contact.aliases.push(alias.trim());
  contact.updatedAt = Date.now();
}

/** Remove an alias from a contact. */
export function removeAlias(did: string, alias: string): void {
  const contact = getContact(did);
  if (!contact) throw new Error(`contacts: "${did}" not found`);

  const normalized = alias.trim().toLowerCase();

  // SQL first — keep the in-memory index/alias list consistent with disk
  // even if the durable delete throws.
  const sqlRepo = getContactRepository();
  if (sqlRepo) sqlRepo.removeAlias(normalized);
  aliasIndex.delete(normalized);
  contact.aliases = contact.aliases.filter((a) => a.toLowerCase() !== normalized);
  contact.updatedAt = Date.now();
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

/**
 * Re-derive the D2D egress-gate + inbound source-trust projections from
 * the current in-memory contacts (doc §4.1). The projection sets are
 * in-memory caches, so they can drift from the durable state when an
 * update is missed — e.g. a person rejected/merged through the people
 * repository without a directory-level removal leaves a now-orphaned DID
 * in the gate. Calling this clears both contact-derived sets and rebuilds
 * them from the (non-blocked) contacts, so the drift self-heals. Cheap;
 * safe to call at boot and after any out-of-band identity mutation.
 * (Only the contact allowlist is touched — the blocked/trusted egress
 * destination lists are independent.)
 */
export function rebuildContactProjections(): void {
  clearEgressGateContacts();
  clearSourceTrustContacts();
  for (const [personId, contact] of contactsByPerson) {
    if (contact.trustLevel === 'blocked') continue;
    for (const did of listPersonDids(personId)) {
      addEgressGateContact(did);
      addKnownContact(did);
    }
  }
}

/**
 * Complete cross-layer merge of two people: fold `mergePersonId` into
 * `keepPersonId` across ALL the layers a bare `PeopleRepository.mergePeople`
 * can't reach. This is the safe entry point a people-curation UI should
 * call (the repo's `mergePeople` handles only surfaces + identities).
 *
 * Order matters: re-point subject links + merge the contact policy
 * BEFORE the people-graph merge tombstones the loser, then rebuild the
 * derived projections from the survivor's now-combined identity set.
 *
 * ⚠️ NOT ATOMIC across stores — DO NOT EXPOSE via a route/UI as-is.
 * The merge spans three independent persistence stores: contact policy +
 * people graph (both in `identity.sqlite`) and the per-persona vault files
 * (`vault/<persona>.sqlite`, one SQLite DB EACH). No single transaction can
 * span separate DB files, so a failure mid-merge can leave partially-merged
 * state — and the loser's contact row is dropped before the survivor write
 * (required: alias rows are globally-unique, so the loser's must be deleted
 * before `addAlias` can re-home them), so a crash in that window loses the
 * unioned policy rather than being safely retryable. Implementing this
 * honestly needs either a unified cross-store transaction layer or a durable
 * merge-job queue that drives the steps to convergence with compensation —
 * a deliberate project, not a patch. Until that lands, `mergeContactPersons`
 * is an internal, run-to-completion primitive only; no caller wires it to a
 * user-triggered surface today, and none should.
 *
 * Caveat (separate from the above): subject links are re-pointed only in
 * personas with a currently wired vault repo (`listVaultPersonas()`). A
 * persona whose vault isn't loaded keeps the loser's links until it's next
 * opened + merged again.
 */
export function mergeContactPersons(keepPersonId: string, mergePersonId: string): void {
  if (keepPersonId === '' || mergePersonId === '' || keepPersonId === mergePersonId) return;
  const peopleRepo = requirePeopleRepo();
  const sqlRepo = getContactRepository();

  // 1. Merge contact policy. The survivor's fields win; the loser's
  //    preferred_for + aliases are unioned in. If only the loser had a
  //    policy, the survivor adopts it.
  const keep = contactsByPerson.get(keepPersonId);
  const merge = contactsByPerson.get(mergePersonId);
  if (merge !== undefined) {
    const now = Date.now();
    const primaryDid =
      peopleRepo.getPerson(keepPersonId)?.contactDid || keep?.did || merge.did;
    const mergedPreferred = [
      ...new Set([...(keep?.preferredFor ?? []), ...(merge.preferredFor ?? [])]),
    ];
    const mergedAliases = [...new Set([...(keep?.aliases ?? []), ...merge.aliases])];
    const merged: Contact = {
      personId: keepPersonId,
      did: primaryDid,
      displayName: keep?.displayName || merge.displayName,
      trustLevel: keep?.trustLevel ?? merge.trustLevel,
      sharingTier: keep?.sharingTier ?? merge.sharingTier,
      relationship: keep?.relationship ?? merge.relationship,
      dataResponsibility: keep?.dataResponsibility ?? merge.dataResponsibility,
      aliases: mergedAliases,
      notes: keep?.notes || merge.notes,
      preferredFor: mergedPreferred.length > 0 ? mergedPreferred : undefined,
      createdAt: keep?.createdAt ?? merge.createdAt,
      updatedAt: now,
    };
    // Drop the loser's policy row + its alias rows + projections first.
    removeContact(mergePersonId);
    // Write the merged survivor policy (add if the survivor had none).
    const hadKeep = contactsByPerson.has(keepPersonId);
    if (sqlRepo) {
      if (hadKeep) sqlRepo.update(keepPersonId, merged);
      else sqlRepo.add(merged);
      // `update()` does NOT touch preferred_for (it has a dedicated
      // normalising setter); without this the categories folded in from
      // the merged-away contact would live only in the in-memory map and
      // vanish on the next hydrate. `add()` already persists them, but
      // call it unconditionally (idempotent) so persistence never depends
      // on which branch ran.
      sqlRepo.setPreferredFor(keepPersonId, merged.preferredFor ?? []);
      for (const alias of mergedAliases) sqlRepo.addAlias(keepPersonId, alias.toLowerCase());
    }
    contactsByPerson.set(keepPersonId, merged);
    for (const alias of mergedAliases) aliasIndex.set(alias.trim().toLowerCase(), keepPersonId);
  }

  // 2. Re-point subject links to the survivor across every wired persona.
  for (const persona of listVaultPersonas()) {
    getVaultRepository(persona)?.repointSubjectsSync(mergePersonId, keepPersonId);
  }

  // 3. People-graph merge — surfaces + identities move to the survivor,
  //    the loser is tombstoned.
  peopleRepo.mergePeople(keepPersonId, mergePersonId);

  // 4. The survivor's DID set just grew (+ the loser's are gone) — rebuild
  //    the derived projections so the gate reflects reality.
  rebuildContactProjections();
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
