/**
 * Contact SQL repository — backs contact CRUD with SQLite.
 *
 * Keyed by `person_id` (people-graph hub), not DID: contact policy is
 * stored once per person, shared across that person's devices/
 * identities. The DID↔person mapping lives in `person_identities`;
 * callers that hold a DID resolve it to a `person_id` first (the
 * `contacts/directory.ts` layer does this via the people repo). See
 * docs/IDENTITY_HUB_REDESIGN.md §3.4.
 *
 * Uses the identity DB's `contacts` + `contact_aliases` tables.
 * Handles camelCase ↔ snake_case mapping.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 *
 * **Sync-by-design — exempt from the async-port rule.** This repository
 * is a thin wrapper over the already-exempt sync `DatabaseAdapter`
 * (op-sqlite via JSI / better-sqlite3 native — both expose synchronous
 * native calls, no I/O wait). On top of that, the in-memory contact
 * directory in `directory.ts` enforces GAP-PERSIST-01: SQL write
 * MUST happen before in-memory mutation, so a failed write leaves
 * memory consistent with disk. That contract requires sync semantics
 * — promoting it to async would break the write-then-memory ordering
 * (the in-memory state would have to either lag the resolved promise
 * or commit before the disk write succeeds, neither of which is
 * acceptable). Pinned in `__tests__/port_async_gate.test.ts` EXEMPTED list.
 */

import { normalisePreferredForCategories, normalisePreferredForCategory } from './preferred_for';

import type {
  Contact,
  TrustLevel,
  SharingTier,
  Relationship,
  DataResponsibility,
} from './directory';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface ContactRepository {
  /** Insert a contact policy row. `contact.personId` is the key. */
  add(contact: Contact): void;
  /** Read a contact policy by person_id. `did` is left '' for the directory to fill. */
  get(personId: string): Contact | null;
  list(): Contact[];
  update(personId: string, updates: Partial<Contact>): void;
  remove(personId: string): boolean;
  addAlias(personId: string, aliasNormalized: string): void;
  removeAlias(aliasNormalized: string): void;
  /** Resolve an alias to the owning person_id, or null. */
  resolveAlias(aliasNormalized: string): string | null;
  getAliases(personId: string): string[];

  // ---- PC-CORE-03: preferredFor surface ---------------------------------
  /**
   * Replace a contact's preferred_for category list. `categories` is
   * normalised (lowercased + trimmed + deduped + empties dropped)
   * before storage — callers may pass raw input. Empty input is a
   * valid "clear all" operation.
   *
   * Throws when the contact doesn't exist.
   */
  setPreferredFor(personId: string, categories: readonly string[]): void;

  /**
   * Read a contact's preferred_for list. Returns an empty array when
   * the contact has no preferences set (never returns undefined).
   * Throws when the contact doesn't exist.
   */
  getPreferredFor(personId: string): string[];

  /**
   * Return contacts whose preferred_for list contains `category`
   * (case-insensitive). Empty / whitespace-only category → `[]` (no
   * "match anything" semantics; the resolver always passes a
   * concrete intent). Returned contacts carry `personId`; `did` is ''.
   */
  findByPreferredFor(category: string): Contact[];
}

/** Singleton repository (null = in-memory). */
let repo: ContactRepository | null = null;
export function setContactRepository(r: ContactRepository | null): void {
  repo = r;
}
export function getContactRepository(): ContactRepository | null {
  return repo;
}

export class SQLiteContactRepository implements ContactRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  add(contact: Contact): void {
    if (contact.personId === '') {
      throw new Error('contacts.repository: personId is required');
    }
    const preferredForJson = JSON.stringify(
      normalisePreferredForCategories(contact.preferredFor ?? []),
    );
    this.db.execute(
      `INSERT INTO contacts (person_id, display_name, trust_level, sharing_tier, relationship, data_responsibility, notes, created_at, updated_at, preferred_for)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contact.personId,
        contact.displayName,
        contact.trustLevel,
        contact.sharingTier,
        contact.relationship,
        contact.dataResponsibility,
        contact.notes,
        contact.createdAt,
        contact.updatedAt,
        preferredForJson,
      ],
    );
    for (const alias of contact.aliases) {
      this.addAlias(contact.personId, alias.toLowerCase());
    }
  }

  get(personId: string): Contact | null {
    const rows = this.db.query('SELECT * FROM contacts WHERE person_id = ?', [personId]);
    if (rows.length === 0) return null;
    const aliases = this.getAliases(personId);
    return rowToContact(rows[0], aliases);
  }

  list(): Contact[] {
    const rows = this.db.query('SELECT * FROM contacts ORDER BY display_name');
    return rows.map((r) => {
      const aliases = this.getAliases(String(r.person_id));
      return rowToContact(r, aliases);
    });
  }

  update(personId: string, updates: Partial<Contact>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(updates.displayName);
    }
    if (updates.trustLevel !== undefined) {
      sets.push('trust_level = ?');
      params.push(updates.trustLevel);
    }
    if (updates.sharingTier !== undefined) {
      sets.push('sharing_tier = ?');
      params.push(updates.sharingTier);
    }
    if (updates.relationship !== undefined) {
      sets.push('relationship = ?');
      params.push(updates.relationship);
    }
    if (updates.dataResponsibility !== undefined) {
      sets.push('data_responsibility = ?');
      params.push(updates.dataResponsibility);
    }
    if (updates.notes !== undefined) {
      sets.push('notes = ?');
      params.push(updates.notes);
    }
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(personId);
    this.db.execute(`UPDATE contacts SET ${sets.join(', ')} WHERE person_id = ?`, params);
  }

  remove(personId: string): boolean {
    const existing = this.db.query('SELECT 1 FROM contacts WHERE person_id = ?', [personId]);
    if (existing.length === 0) return false;
    // Remove aliases explicitly — we don't rely on the FK ON DELETE
    // CASCADE firing (PRAGMA foreign_keys may be off on some adapters).
    this.db.execute('DELETE FROM contact_aliases WHERE person_id = ?', [personId]);
    this.db.execute('DELETE FROM contacts WHERE person_id = ?', [personId]);
    return true;
  }

  addAlias(personId: string, aliasNormalized: string): void {
    this.db.execute(
      'INSERT OR IGNORE INTO contact_aliases (alias_normalized, person_id) VALUES (?, ?)',
      [aliasNormalized, personId],
    );
  }

  removeAlias(aliasNormalized: string): void {
    this.db.execute('DELETE FROM contact_aliases WHERE alias_normalized = ?', [aliasNormalized]);
  }

  resolveAlias(aliasNormalized: string): string | null {
    const rows = this.db.query(
      'SELECT person_id FROM contact_aliases WHERE alias_normalized = ?',
      [aliasNormalized],
    );
    return rows.length > 0 ? String(rows[0].person_id) : null;
  }

  getAliases(personId: string): string[] {
    const rows = this.db.query(
      'SELECT alias_normalized FROM contact_aliases WHERE person_id = ?',
      [personId],
    );
    return rows.map((r) => String(r.alias_normalized));
  }

  // ---- PC-CORE-03: preferredFor surface ---------------------------------

  setPreferredFor(personId: string, categories: readonly string[]): void {
    const existing = this.db.query('SELECT 1 FROM contacts WHERE person_id = ?', [personId]);
    if (existing.length === 0) {
      throw new Error(`contacts.repository: "${personId}" not found`);
    }
    const normalised = normalisePreferredForCategories(categories);
    this.db.execute('UPDATE contacts SET preferred_for = ?, updated_at = ? WHERE person_id = ?', [
      JSON.stringify(normalised),
      Date.now(),
      personId,
    ]);
  }

  getPreferredFor(personId: string): string[] {
    const rows = this.db.query('SELECT preferred_for FROM contacts WHERE person_id = ?', [
      personId,
    ]);
    if (rows.length === 0) {
      throw new Error(`contacts.repository: "${personId}" not found`);
    }
    return decodePreferredFor(String(rows[0].preferred_for ?? '[]'));
  }

  findByPreferredFor(category: string): Contact[] {
    const needle = normalisePreferredForCategory(category);
    if (needle === '') return [];
    // Filter the JSON containment test in memory rather than via
    // SQLite JSON1 — keeps us off the JSON1 extension (may or may
    // not be built into op-sqlite) and matches main-dina's
    // in-process approach. The `!= '[]'` prefilter still runs in
    // SQL so a fully-empty fleet of contacts doesn't fan out.
    const rows = this.db.query(
      `SELECT * FROM contacts
       WHERE preferred_for IS NOT NULL
         AND preferred_for != '[]'
       ORDER BY display_name`,
    );
    const matches: Contact[] = [];
    for (const row of rows) {
      const prefs = decodePreferredFor(String(row.preferred_for ?? '[]'));
      if (!prefs.includes(needle)) continue;
      const aliases = this.getAliases(String(row.person_id));
      matches.push(rowToContact(row, aliases));
    }
    return matches;
  }
}

/**
 * Map a `contacts` row to a `Contact`. `did` is intentionally left
 * empty — the table is person-keyed and carries no DID. The
 * `contacts/directory.ts` layer fills `did` with the person's primary
 * DID (or the looked-up DID) after resolving through the people graph.
 */
function rowToContact(row: DBRow, aliases: string[]): Contact {
  return {
    personId: String(row.person_id ?? ''),
    did: '',
    displayName: String(row.display_name ?? ''),
    trustLevel: String(row.trust_level ?? 'unknown') as TrustLevel,
    sharingTier: String(row.sharing_tier ?? 'summary') as SharingTier,
    relationship: String(row.relationship ?? 'unknown') as Relationship,
    dataResponsibility: String(row.data_responsibility ?? 'external') as DataResponsibility,
    aliases,
    notes: String(row.notes ?? ''),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    preferredFor: decodePreferredFor(String(row.preferred_for ?? '[]')),
  };
}

/**
 * Parse the stored JSON text into a normalised string list. Accepts
 * NULL / empty / malformed payloads by returning `[]` — the column
 * defaults to '[]' in the schema, but guarding against hand-edited
 * rows costs almost nothing and keeps the read path panic-free.
 */
function decodePreferredFor(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null') return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalisePreferredForCategories(parsed as string[]);
  } catch {
    return [];
  }
}
