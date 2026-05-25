/**
 * T2.50 — Contact directory: CRUD, trust levels, aliases, uniqueness.
 *
 * Source: ARCHITECTURE.md Section 2.50
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations, IDENTITY_MIGRATIONS } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  addContact,
  getContact,
  listContacts,
  updateContact,
  deleteContact,
  addAlias,
  removeAlias,
  resolveAlias,
  findByAlias,
  getContactsByTrust,
  resetContactDirectory,
  isContact,
  getTrustLevel,
  resolveByName,
  addContactIfNotExists,
  hydrateContactDirectory,
  setPreferredFor,
  type Contact,
} from '../../src/contacts/directory';
import {
  setContactRepository,
  SQLiteContactRepository,
  type ContactRepository,
} from '../../src/contacts/repository';
import {
  setPeopleRepository,
  getPeopleRepository,
  SQLitePeopleRepository,
  type PeopleRepository,
} from '../../src/people/repository';
import {
  checkContactGate,
  clearGatesState,
  addContact as addEgressGateContact,
} from '../../src/d2d/gates';
import { isContactRing1, clearKnownContacts } from '../../src/peerlens/source_trust';
import { rebuildContactProjections, mergeContactPersons } from '../../src/contacts/directory';
import {
  InMemoryVaultRepository,
  setVaultRepository,
  getVaultRepository,
  resetVaultRepositories,
} from '../../src/vault/repository';

describe('Contact Directory', () => {
  // Contact policy is person-keyed; the directory resolves did→person
  // through the people graph. So these tests run against a real
  // identity SQLite DB (people + contact repos on one adapter) — the
  // same engine production uses — rather than a pure in-memory stub.
  // Individual tests still override the contact/people repos with
  // spies/stubs where they assert call-through behaviour.
  // ONE SQLCipher DB per file — opening one derives the key via PBKDF2
  // (intentionally slow). Doing that per-test (×60) made the suite take
  // minutes; opening once in beforeAll and clearing tables in beforeEach
  // keeps real-SQL fidelity at a fraction of the cost.
  let adapter: NodeSQLiteAdapter;
  let dbDir = '';
  const IDENTITY_TABLES = [
    'contact_aliases',
    'contacts',
    'person_surfaces',
    'person_identities',
    'person_extraction_log',
    'people',
  ];

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-directory-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dbDir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterAll(() => {
    try {
      adapter.close();
    } catch {
      /* idempotent */
    }
    if (dbDir !== '') {
      try {
        fs.rmSync(dbDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  beforeEach(() => {
    for (const t of IDENTITY_TABLES) adapter.execute(`DELETE FROM ${t}`);
    setPeopleRepository(new SQLitePeopleRepository(adapter));
    setContactRepository(new SQLiteContactRepository(adapter));
    resetContactDirectory();
    // The D2D gate + source-trust sets are module-global and NOT cleared
    // by resetContactDirectory — reset them so projection assertions
    // don't see stale entries from a prior test.
    clearGatesState();
    clearKnownContacts();
  });

  afterEach(() => {
    resetContactDirectory();
    setContactRepository(null);
    setPeopleRepository(null);
  });

  describe('addContact', () => {
    it('adds a contact with default trust/sharing', () => {
      const c = addContact('did:plc:alice', 'Alice');
      expect(c.did).toBe('did:plc:alice');
      expect(c.displayName).toBe('Alice');
      expect(c.trustLevel).toBe('unknown');
      expect(c.sharingTier).toBe('summary');
    });

    it('accepts custom trust level and sharing tier', () => {
      const c = addContact('did:plc:bob', 'Bob', 'trusted', 'full');
      expect(c.trustLevel).toBe('trusted');
      expect(c.sharingTier).toBe('full');
    });

    it('rejects duplicate DID', () => {
      addContact('did:plc:alice', 'Alice');
      expect(() => addContact('did:plc:alice', 'Alice 2')).toThrow('already exists');
    });

    it('rejects empty DID', () => {
      expect(() => addContact('', 'Nobody')).toThrow('DID is required');
    });

    it('re-adding an existing contact on a cold cache updates (no UNIQUE crash)', () => {
      // The policy row + person persist in SQL; clearing the in-memory
      // caches simulates a pre-hydration cold start. establishContact
      // must decide UPDATE (not INSERT) from the durable store, or the
      // person_id PK would collide.
      addContact('did:plc:alice', 'Alice', 'verified');
      resetContactDirectory();
      expect(() => addContact('did:plc:alice', 'Alice Renamed', 'trusted')).not.toThrow();
      const c = getContact('did:plc:alice');
      expect(c!.displayName).toBe('Alice Renamed');
      expect(c!.trustLevel).toBe('trusted');
    });

    it('addContactIfNotExists creates new contact', () => {
      const { contact, created } = addContactIfNotExists('did:plc:new', 'New Contact');
      expect(created).toBe(true);
      expect(contact.did).toBe('did:plc:new');
      expect(contact.displayName).toBe('New Contact');
    });

    it('addContactIfNotExists returns existing on duplicate (no throw)', () => {
      addContact('did:plc:alice', 'Alice', 'trusted');
      const { contact, created } = addContactIfNotExists('did:plc:alice', 'Alice Copy');
      expect(created).toBe(false);
      expect(contact.displayName).toBe('Alice'); // original, not "Alice Copy"
      expect(contact.trustLevel).toBe('trusted');
    });

    it('addContactIfNotExists preserves existing contact data', () => {
      addContact('did:plc:bob', 'Bob', 'verified', 'full');
      const { contact } = addContactIfNotExists('did:plc:bob', 'Bobby', 'unknown', 'none');
      // Original data preserved, not overwritten
      expect(contact.displayName).toBe('Bob');
      expect(contact.trustLevel).toBe('verified');
      expect(contact.sharingTier).toBe('full');
    });

    it('has timestamps', () => {
      const before = Date.now();
      const c = addContact('did:plc:alice', 'Alice');
      expect(c.createdAt).toBeGreaterThanOrEqual(before);
      expect(c.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getContact / listContacts', () => {
    it('retrieves contact by DID', () => {
      addContact('did:plc:alice', 'Alice');
      expect(getContact('did:plc:alice')!.displayName).toBe('Alice');
    });

    it('returns null for unknown DID', () => {
      expect(getContact('did:plc:unknown')).toBeNull();
    });

    it('lists all contacts', () => {
      addContact('did:plc:alice', 'Alice');
      addContact('did:plc:bob', 'Bob');
      expect(listContacts()).toHaveLength(2);
    });

    it('lazy-hydrates from SQL when in-memory cache misses', () => {
      // Simulates the JS-bundle reload race on mobile: the in-memory
      // Maps are empty (Cmd+R cleared them), but the durable identity
      // DB (person_identities + contacts) survives at the native layer.
      // `getContact` must resolve did→person→policy from SQL, hydrate
      // the cache, and return the contact — not return null and let the
      // receive pipeline classify a verified sender as 'unknown'.
      addContact('did:plc:carol', 'Carol', 'verified');
      // Clear ONLY the in-memory directory caches; the real SQLite rows
      // (person, identity, contact policy) persist on the adapter.
      resetContactDirectory();

      const first = getContact('did:plc:carol');
      expect(first).not.toBeNull();
      expect(first!.trustLevel).toBe('verified');
      expect(first!.did).toBe('did:plc:carol');
      // Unknown DID resolves to null without poisoning the cache.
      expect(getContact('did:plc:nobody')).toBeNull();
      expect(getContact('did:plc:nobody')).toBeNull();
    });

    it('returns null without throwing when the person is unknown', () => {
      expect(getContact('did:plc:nowhere')).toBeNull();
    });
  });

  describe('updateContact', () => {
    it('updates trust level', () => {
      addContact('did:plc:alice', 'Alice');
      const updated = updateContact('did:plc:alice', { trustLevel: 'trusted' });
      expect(updated.trustLevel).toBe('trusted');
    });

    it('updates sharing tier', () => {
      addContact('did:plc:alice', 'Alice');
      updateContact('did:plc:alice', { sharingTier: 'full' });
      expect(getContact('did:plc:alice')!.sharingTier).toBe('full');
    });

    it('updates notes', () => {
      addContact('did:plc:alice', 'Alice');
      updateContact('did:plc:alice', { notes: 'Met at conference 2025' });
      expect(getContact('did:plc:alice')!.notes).toBe('Met at conference 2025');
    });

    it('updates updatedAt timestamp', () => {
      addContact('did:plc:alice', 'Alice');
      const before = Date.now();
      updateContact('did:plc:alice', { trustLevel: 'verified' });
      expect(getContact('did:plc:alice')!.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('throws for unknown DID', () => {
      expect(() => updateContact('did:plc:unknown', { trustLevel: 'trusted' })).toThrow(
        'not found',
      );
    });
  });

  describe('deleteContact', () => {
    it('removes contact', () => {
      addContact('did:plc:alice', 'Alice');
      expect(deleteContact('did:plc:alice')).toBe(true);
      expect(getContact('did:plc:alice')).toBeNull();
    });

    it('returns false for unknown DID', () => {
      expect(deleteContact('did:plc:unknown')).toBe(false);
    });

    it('removes associated aliases', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      deleteContact('did:plc:alice');
      expect(resolveAlias('Ali')).toBeNull();
    });

    it('write-throughs the delete to durable storage (re-add works after)', () => {
      // Without the SQL delete, on-device the policy row stayed behind
      // and a re-add of the same DID hit the UNIQUE constraint —
      // observed live on the simulator before this fix landed. With
      // real repos, prove the row is gone by re-adding cleanly and by
      // a cold re-hydrate returning nothing.
      addContact('did:plc:alice', 'Alice');
      deleteContact('did:plc:alice');
      // Re-add must not throw (the policy row was actually removed).
      expect(() => addContact('did:plc:alice', 'Alice Again')).not.toThrow();
      // And a cold cache re-hydrate sees the re-added contact, not a ghost.
      resetContactDirectory();
      expect(getContact('did:plc:alice')!.displayName).toBe('Alice Again');
    });
  });

  describe('alias management', () => {
    it('adds alias to contact', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      expect(getContact('did:plc:alice')!.aliases).toContain('Ali');
    });

    it('resolves DID from alias', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      expect(resolveAlias('Ali')).toBe('did:plc:alice');
    });

    it('alias is case-insensitive', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      expect(resolveAlias('ALI')).toBe('did:plc:alice');
      expect(resolveAlias('ali')).toBe('did:plc:alice');
    });

    it('rejects duplicate alias across contacts', () => {
      addContact('did:plc:alice', 'Alice');
      addContact('did:plc:bob', 'Bob');
      addAlias('did:plc:alice', 'Ali');
      expect(() => addAlias('did:plc:bob', 'Ali')).toThrow('already taken');
    });

    it('is SQL-authoritative on a cold cache — alias owned in SQL still blocks (#3)', () => {
      addContact('did:plc:alice', 'Alice');
      addContact('did:plc:bob', 'Bob');
      addAlias('did:plc:alice', 'ace'); // Alice owns "ace" in SQL + memory

      // Cold cache: drop the in-memory aliasIndex (post-reload, pre-hydrate)
      // but keep SQL. The old check trusted only the empty in-memory index.
      resetContactDirectory();

      // Bob tries to claim "ace" — SQL still says Alice owns it, so it must
      // be rejected (not silently mis-assigned to Bob in memory while the
      // repo's INSERT OR IGNORE drops the write).
      expect(() => addAlias('did:plc:bob', 'ace')).toThrow('already taken');
      // And re-claiming by the true owner is still idempotent.
      expect(() => addAlias('did:plc:alice', 'ace')).not.toThrow();
    });

    it('allows adding same alias to same contact (idempotent)', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      addAlias('did:plc:alice', 'Ali'); // no throw
      expect(getContact('did:plc:alice')!.aliases.filter((a) => a === 'Ali')).toHaveLength(1);
    });

    it('rejects empty alias', () => {
      addContact('did:plc:alice', 'Alice');
      expect(() => addAlias('did:plc:alice', '')).toThrow('cannot be empty');
    });

    it('removes alias', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      removeAlias('did:plc:alice', 'Ali');
      expect(resolveAlias('Ali')).toBeNull();
      expect(getContact('did:plc:alice')!.aliases).toHaveLength(0);
    });

    it('findByAlias returns contact', () => {
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      const c = findByAlias('Ali');
      expect(c).not.toBeNull();
      expect(c!.did).toBe('did:plc:alice');
    });

    it('findByAlias returns null for unknown alias', () => {
      expect(findByAlias('nobody')).toBeNull();
    });
  });

  describe('relationship + data_responsibility', () => {
    it('defaults to relationship=unknown, dataResponsibility=external', () => {
      const c = addContact('did:plc:alice', 'Alice');
      expect(c.relationship).toBe('unknown');
      expect(c.dataResponsibility).toBe('external');
    });

    it('accepts relationship parameter on creation', () => {
      const c = addContact('did:plc:alice', 'Alice', undefined, undefined, 'spouse');
      expect(c.relationship).toBe('spouse');
    });

    it('auto-derives household for spouse', () => {
      const c = addContact('did:plc:alice', 'Alice', undefined, undefined, 'spouse');
      expect(c.dataResponsibility).toBe('household');
    });

    it('auto-derives household for child', () => {
      const c = addContact('did:plc:kid', 'Emma', undefined, undefined, 'child');
      expect(c.dataResponsibility).toBe('household');
    });

    it('auto-derives external for friend', () => {
      const c = addContact('did:plc:bob', 'Bob', undefined, undefined, 'friend');
      expect(c.dataResponsibility).toBe('external');
    });

    it('auto-derives external for colleague', () => {
      const c = addContact('did:plc:carol', 'Carol', undefined, undefined, 'colleague');
      expect(c.dataResponsibility).toBe('external');
    });

    it('rejects invalid relationship on creation', () => {
      expect(() => addContact('did:plc:x', 'X', undefined, undefined, 'bestie' as any)).toThrow(
        'invalid relationship',
      );
    });

    it('updateContact with relationship auto-derives dataResponsibility', () => {
      addContact('did:plc:alice', 'Alice');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('external');

      updateContact('did:plc:alice', { relationship: 'spouse' });
      expect(getContact('did:plc:alice')!.relationship).toBe('spouse');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');
    });

    it('persists the relationship-derived dataResponsibility across a hydrate round-trip', () => {
      addContact('did:plc:alice', 'Alice'); // unknown → external
      updateContact('did:plc:alice', { relationship: 'spouse' }); // derives household
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');

      // The DERIVED field must reach SQL, not just the live map: update()
      // writes exactly the fields handed to it, so persisting the raw
      // `updates` partial (no dataResponsibility) would leave SQL on the
      // old 'external'. Hydrate (restart proxy) proves the derived value
      // survived.
      resetContactDirectory();
      hydrateContactDirectory();
      expect(getContact('did:plc:alice')!.relationship).toBe('spouse');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');
    });

    it('updateContact is SQL-first: a failed durable write leaves memory unchanged', () => {
      addContact('did:plc:alice', 'Alice', 'unknown');
      // A repo whose update() throws (e.g. disk full), delegating
      // everything else to the real one.
      const real = new SQLiteContactRepository(adapter);
      const failing: ContactRepository = {
        add: (c) => real.add(c),
        get: (id) => real.get(id),
        list: () => real.list(),
        update: () => {
          throw new Error('disk full');
        },
        remove: (id) => real.remove(id),
        addAlias: (p, a) => real.addAlias(p, a),
        removeAlias: (a) => real.removeAlias(a),
        resolveAlias: (a) => real.resolveAlias(a),
        getAliases: (p) => real.getAliases(p),
        setPreferredFor: (p, c) => real.setPreferredFor(p, c),
        getPreferredFor: (p) => real.getPreferredFor(p),
        findByPreferredFor: (c) => real.findByPreferredFor(c),
      };
      setContactRepository(failing);
      try {
        expect(() => updateContact('did:plc:alice', { trustLevel: 'trusted' })).toThrow(
          'disk full',
        );
        // SQL-first: the durable write threw BEFORE the cache was touched,
        // so the in-memory contact still reads the pre-update trust level
        // (no divergence between memory and disk).
        expect(getContact('did:plc:alice')!.trustLevel).toBe('unknown');
      } finally {
        setContactRepository(real);
      }
    });

    it('re-add on a cold cache preserves the existing relationship + dataResponsibility (#4)', () => {
      addContact('did:plc:alice', 'Alice', 'verified', 'summary', 'spouse');
      expect(getContact('did:plc:alice')!.relationship).toBe('spouse');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');

      // Simulate a cold cache (e.g. a phone-contact re-sync after restart,
      // before hydration): drop the in-memory directory but keep SQL.
      resetContactDirectory();

      // Re-add WITHOUT a relationship — must NOT reset spouse→unknown /
      // household→external just because opts omitted them.
      addContact('did:plc:alice', 'Alice');
      expect(getContact('did:plc:alice')!.relationship).toBe('spouse');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');
    });

    it('an explicit relationship on re-add still re-derives dataResponsibility', () => {
      addContact('did:plc:alice', 'Alice', 'verified', 'summary', 'spouse'); // household
      resetContactDirectory();
      addContact('did:plc:alice', 'Alice', 'verified', 'summary', 'friend'); // → external
      expect(getContact('did:plc:alice')!.relationship).toBe('friend');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('external');
    });

    it('updateContact rejects invalid relationship', () => {
      addContact('did:plc:alice', 'Alice');
      expect(() => updateContact('did:plc:alice', { relationship: 'enemy' as any })).toThrow(
        'invalid relationship',
      );
    });

    it('explicit dataResponsibility override on update', () => {
      addContact('did:plc:alice', 'Alice', undefined, undefined, 'friend');
      // Default: friend → external
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('external');

      // Override: friend → care (e.g., user manages friend's medical decisions)
      updateContact('did:plc:alice', { dataResponsibility: 'care' });
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('care');
    });

    it('relationship change re-derives unless explicit override', () => {
      addContact('did:plc:alice', 'Alice', undefined, undefined, 'friend');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('external');

      // Change to child → auto-derive to household
      updateContact('did:plc:alice', { relationship: 'child' });
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('household');

      // Change to colleague with explicit financial override
      updateContact('did:plc:alice', {
        relationship: 'colleague',
        dataResponsibility: 'financial',
      });
      expect(getContact('did:plc:alice')!.relationship).toBe('colleague');
      expect(getContact('did:plc:alice')!.dataResponsibility).toBe('financial');
    });
  });

  describe('trust filtering', () => {
    it('getContactsByTrust filters correctly', () => {
      addContact('did:plc:alice', 'Alice', 'trusted');
      addContact('did:plc:bob', 'Bob', 'unknown');
      addContact('did:plc:charlie', 'Charlie', 'trusted');
      const trusted = getContactsByTrust('trusted');
      expect(trusted).toHaveLength(2);
      expect(trusted.map((c) => c.displayName).sort()).toEqual(['Alice', 'Charlie']);
    });

    it('returns empty for no matches', () => {
      addContact('did:plc:alice', 'Alice', 'unknown');
      expect(getContactsByTrust('blocked')).toHaveLength(0);
    });
  });

  describe('fast-path ingress APIs', () => {
    describe('isContact', () => {
      it('returns true for known DID', () => {
        addContact('did:plc:alice', 'Alice');
        expect(isContact('did:plc:alice')).toBe(true);
      });

      it('returns false for unknown DID', () => {
        expect(isContact('did:plc:stranger')).toBe(false);
      });

      it('O(1) lookup — does not iterate contacts', () => {
        // Add many contacts to verify performance doesn't degrade
        for (let i = 0; i < 100; i++) addContact(`did:plc:c${i}`, `Contact ${i}`);
        expect(isContact('did:plc:c50')).toBe(true);
        expect(isContact('did:plc:missing')).toBe(false);
      });
    });

    describe('getTrustLevel', () => {
      it('returns trust level for known DID', () => {
        addContact('did:plc:alice', 'Alice', 'trusted');
        expect(getTrustLevel('did:plc:alice')).toBe('trusted');
      });

      it('returns null for unknown DID', () => {
        expect(getTrustLevel('did:plc:stranger')).toBeNull();
      });

      it('reflects updated trust level', () => {
        addContact('did:plc:alice', 'Alice', 'unknown');
        expect(getTrustLevel('did:plc:alice')).toBe('unknown');
        updateContact('did:plc:alice', { trustLevel: 'verified' });
        expect(getTrustLevel('did:plc:alice')).toBe('verified');
      });
    });

    describe('resolveByName', () => {
      it('resolves contact by exact display name', () => {
        addContact('did:plc:alice', 'Alice');
        const contact = resolveByName('Alice');
        expect(contact).not.toBeNull();
        expect(contact!.did).toBe('did:plc:alice');
      });

      it('case-insensitive match', () => {
        addContact('did:plc:alice', 'Alice');
        expect(resolveByName('alice')).not.toBeNull();
        expect(resolveByName('ALICE')).not.toBeNull();
      });

      it('returns null for unknown name', () => {
        expect(resolveByName('Nobody')).toBeNull();
      });

      it('returns null for empty name', () => {
        expect(resolveByName('')).toBeNull();
      });

      it('trims whitespace', () => {
        addContact('did:plc:bob', 'Bob');
        expect(resolveByName('  Bob  ')).not.toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------
  // PC-CORE-01 — Contact.preferredFor field
  // -------------------------------------------------------------------

  describe('PC-CORE-01: Contact.preferredFor field', () => {
    it('type accepts an optional preferredFor: string[] field', () => {
      // Compile-time check: the type allows the field both set and
      // unset. If the interface change regresses, this test file
      // fails to typecheck (which is exactly the acceptance criterion
      // for PC-CORE-01 — "type-check passes").
      const withField: Contact = {
        personId: 'person-alice',
        did: 'did:plc:alice',
        displayName: 'Alice',
        trustLevel: 'trusted',
        sharingTier: 'full',
        relationship: 'friend',
        dataResponsibility: 'external',
        aliases: [],
        notes: '',
        createdAt: 0,
        updatedAt: 0,
        preferredFor: ['dental', 'tax'],
      };
      const withoutField: Contact = {
        personId: 'person-bob',
        did: 'did:plc:bob',
        displayName: 'Bob',
        trustLevel: 'unknown',
        sharingTier: 'summary',
        relationship: 'unknown',
        dataResponsibility: 'external',
        aliases: [],
        notes: '',
        createdAt: 0,
        updatedAt: 0,
      };
      expect(withField.preferredFor).toEqual(['dental', 'tax']);
      expect(withoutField.preferredFor).toBeUndefined();
    });

    it('round-trips through JSON without losing the field', () => {
      const c: Contact = {
        personId: 'person-carol',
        did: 'did:plc:carol',
        displayName: 'Carol',
        trustLevel: 'trusted',
        sharingTier: 'full',
        relationship: 'colleague',
        dataResponsibility: 'external',
        aliases: [],
        notes: '',
        createdAt: 100,
        updatedAt: 200,
        preferredFor: ['legal'],
      };
      const round = JSON.parse(JSON.stringify(c)) as Contact;
      expect(round.preferredFor).toEqual(['legal']);
    });

    it('undefined and [] are both valid absent states for domain consumers', () => {
      // The field is optional — both undefined and an empty array
      // mean "no preferences set". Domain consumers must not
      // distinguish them (the repository layer normalises on write).
      const a: Contact = {
        personId: 'person-x',
        did: 'did:plc:x',
        displayName: 'x',
        trustLevel: 'unknown',
        sharingTier: 'summary',
        relationship: 'unknown',
        dataResponsibility: 'external',
        aliases: [],
        notes: '',
        createdAt: 0,
        updatedAt: 0,
      };
      const b: Contact = { ...a, personId: 'person-y', did: 'did:plc:y', preferredFor: [] };
      const nonEmpty = (c: Contact) => (c.preferredFor?.length ?? 0) > 0;
      expect(nonEmpty(a)).toBe(false);
      expect(nonEmpty(b)).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // GAP-PERSIST-02 / GAP-PERSIST-04 — hydration + alias-aware lookup
  // ----------------------------------------------------------------

  describe('hydrateContactDirectory + resolveByName (GAP-PERSIST-02/04)', () => {
    it('loads every persisted contact (+ aliases) into memory at boot', () => {
      // Persist a contact through the real path, then simulate a cold
      // boot: clear the in-memory caches and re-hydrate from durable
      // storage. Display name + every alias must resolve back to the DID.
      addContact('did:plc:drcarl', 'Dr Carl Jones', 'trusted', 'summary', 'acquaintance');
      addAlias('did:plc:drcarl', 'Dr Carl');
      addAlias('did:plc:drcarl', 'Carl J');
      setPreferredFor('did:plc:drcarl', ['dental']);

      resetContactDirectory();
      const loaded = hydrateContactDirectory();
      expect(loaded).toBe(1);

      expect(resolveByName('Dr Carl Jones')?.did).toBe('did:plc:drcarl');
      expect(resolveByName('dr carl')?.did).toBe('did:plc:drcarl');
      expect(resolveByName('Carl J')?.did).toBe('did:plc:drcarl');
      // preferredFor survives the hydration round-trip.
      expect(getContact('did:plc:drcarl')?.preferredFor).toEqual(['dental']);
    });

    it('is a no-op when no repository is wired', () => {
      setContactRepository(null);
      expect(hydrateContactDirectory()).toBe(0);
    });

    it('GAP-PERSIST-04: resolveByName matches on alias as well as displayName', () => {
      addContact('did:plc:drcarl', 'Dr Carl Jones', 'trusted', 'summary', 'acquaintance');
      addAlias('did:plc:drcarl', 'Dr Carl');
      expect(resolveByName('dr carl')?.did).toBe('did:plc:drcarl');
      expect(resolveByName('Dr Carl Jones')?.did).toBe('did:plc:drcarl');
      expect(resolveByName('somebody else')).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // GAP-PERSIST-01 — SQL write-through failures surface, never swallow
  // ----------------------------------------------------------------

  describe('addContact / setPreferredFor surface SQL failures (GAP-PERSIST-01)', () => {
    afterEach(() => {
      setContactRepository(null);
      resetContactDirectory();
    });

    it('addContact throws when the repo rejects the insert', () => {
      setContactRepository({
        add: () => {
          throw new Error('UNIQUE constraint failed');
        },
        list: () => [],
        get: () => null,
        update: () => {
          /* unused */
        },
        remove: () => false,
        addAlias: () => {
          /* unused */
        },
        removeAlias: () => {
          /* unused */
        },
        resolveAlias: () => null,
        getAliases: () => [],
        setPreferredFor: () => {
          /* unused */
        },
        getPreferredFor: () => [],
        findByPreferredFor: () => [],
      } as unknown as ContactRepository);
      expect(() => addContact('did:plc:x', 'X', 'unknown', 'summary', 'acquaintance')).toThrow(
        /UNIQUE/,
      );
      // In-memory state MUST stay consistent — nothing landed.
      expect(getContact('did:plc:x')).toBeNull();
    });

    it('setPreferredFor throws when the repo rejects the write', () => {
      // Seed without a repo wired (so addContact doesn't throw).
      setContactRepository(null);
      addContact('did:plc:x', 'X', 'unknown', 'summary', 'acquaintance');

      setContactRepository({
        setPreferredFor: () => {
          throw new Error('disk full');
        },
        add: () => {
          /* unused */
        },
        list: () => [],
        get: () => null,
        update: () => {
          /* unused */
        },
        remove: () => false,
        addAlias: () => {
          /* unused */
        },
        removeAlias: () => {
          /* unused */
        },
        resolveAlias: () => null,
        getAliases: () => [],
        getPreferredFor: () => [],
        findByPreferredFor: () => [],
      } as unknown as ContactRepository);

      expect(() => setPreferredFor('did:plc:x', ['dental'])).toThrow(/disk full/);
      // In-memory preferredFor didn't move either — no divergence.
      expect(getContact('did:plc:x')?.preferredFor).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // Contract: cache ↔ SQL parity for every mutation.
  // ----------------------------------------------------------------
  //
  // The directory keeps an in-memory Map fronting a SQL repo
  // (op-sqlite via JSI — sync, microseconds). The Map is a read
  // cache; SQL is the durable store. Bug #2 (`deleteContact` skipped
  // the SQL write) lived in the gap between these two structures.
  //
  // This block enumerates every mutating operation on the directory
  // and asserts each one calls through to the repo. Adding a NEW
  // mutation without a corresponding write-through will fail this
  // contract — closing the bug class, not just the deleteContact
  // instance.
  describe('contract: every mutation writes through to SQL repo', () => {
    interface RepoSpy {
      add: string[]; // dids added
      update: string[]; // dids updated
      remove: string[]; // dids removed
      addAlias: Array<{ did: string; alias: string }>;
      removeAlias: string[]; // aliases removed
      setPreferredFor: Array<{ did: string; categories: readonly string[] }>;
    }

    /**
     * Build a stubbed PeopleRepository for tests that exercise the
     * contact↔person mirror path. Default impls throw on any
     * unexpected call so a regression that grows the contract gets
     * caught by an obviously-wrong test failure rather than a silent
     * pass; callers override the methods they care about.
     */
    function makeStubPeopleRepo(overrides: Partial<PeopleRepository>): PeopleRepository {
      const stub = (name: string) => () => {
        throw new Error(`unexpected PeopleRepository.${name} call in this test`);
      };
      return {
        applyExtraction: stub('applyExtraction'),
        getPerson: () => null,
        listPeople: () => [],
        findByContactDid: () => null,
        resolveByIdentity: () => null,
        upsertIdentity: stub('upsertIdentity'),
        listIdentities: () => [],
        confirmPerson: stub('confirmPerson'),
        rejectPerson: stub('rejectPerson'),
        confirmSurface: stub('confirmSurface'),
        rejectSurface: stub('rejectSurface'),
        detachSurface: stub('detachSurface'),
        mergePeople: stub('mergePeople'),
        deletePerson: stub('deletePerson'),
        linkContact: stub('linkContact'),
        upsertContactPerson: stub('upsertContactPerson'),
        resolveConfirmedSurfaces: () => new Map(),
        clearExcerptsForItem: () => 0,
        garbageCollect: () => 0,
        ...overrides,
      };
    }

    function makeSpyPeopleRepo(
      sink: Array<{ did: string; displayName: string }>,
    ): PeopleRepository {
      return makeStubPeopleRepo({
        upsertContactPerson: (did: string, displayName: string) => {
          sink.push({ did, displayName });
          return `person-${did}`;
        },
      });
    }

    function makeSpyRepo(): { repo: ContactRepository; spy: RepoSpy } {
      const spy: RepoSpy = {
        add: [],
        update: [],
        remove: [],
        addAlias: [],
        removeAlias: [],
        setPreferredFor: [],
      };
      const repo: ContactRepository = {
        list: () => [],
        add: (c) => {
          spy.add.push(c.did);
        },
        get: () => null,
        update: (did) => {
          spy.update.push(did);
        },
        remove: (did) => {
          spy.remove.push(did);
          return true;
        },
        addAlias: (did, alias) => {
          spy.addAlias.push({ did, alias });
        },
        removeAlias: (alias) => {
          spy.removeAlias.push(alias);
        },
        resolveAlias: () => null,
        getAliases: () => [],
        setPreferredFor: (did, categories) => {
          spy.setPreferredFor.push({ did, categories });
        },
        getPreferredFor: () => [],
        findByPreferredFor: () => [],
      };
      return { repo, spy };
    }

    afterEach(() => {
      setContactRepository(null);
      resetContactDirectory();
    });

    it('addContact → repo.add', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      expect(spy.add).toEqual(['did:plc:alice']);
    });

    it('addContactIfNotExists (new) → repo.add', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContactIfNotExists('did:plc:bob', 'Bob');
      expect(spy.add).toEqual(['did:plc:bob']);
    });

    it('updateContact → repo.update', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      updateContact('did:plc:alice', { displayName: 'Alice 2' });
      // Repo is person-keyed now — assert the write-through happened
      // (the recorded key is the resolved person_id, not the DID).
      expect(spy.update).toHaveLength(1);
    });

    it('deleteContact → repo.remove (Bug #2 contract)', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      deleteContact('did:plc:alice');
      expect(spy.remove).toHaveLength(1);
    });

    it('addAlias → repo.addAlias', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      expect(spy.addAlias).toHaveLength(1);
      expect(spy.addAlias[0].alias).toBe('ali');
    });

    it('removeAlias → repo.removeAlias', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      removeAlias('did:plc:alice', 'Ali');
      expect(spy.removeAlias).toContain('ali');
    });

    it('setPreferredFor → repo.setPreferredFor', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      setPreferredFor('did:plc:alice', ['dentist']);
      expect(spy.setPreferredFor).toHaveLength(1);
      expect(spy.setPreferredFor[0].categories).toEqual(['dentist']);
    });

    it('addContact → people repo.upsertContactPerson (when wired, non-blocked)', () => {
      const { repo: contactRepo } = makeSpyRepo();
      setContactRepository(contactRepo);
      const peopleSpy: Array<{ did: string; displayName: string }> = [];
      const peopleRepo = makeSpyPeopleRepo(peopleSpy);
      setPeopleRepository(peopleRepo);

      addContact('did:plc:sancho', 'Sancho', 'verified');

      expect(peopleSpy).toEqual([{ did: 'did:plc:sancho', displayName: 'Sancho' }]);
      setPeopleRepository(null);
    });

    it('addContact still creates the person for a blocked contact (person is the key)', () => {
      // Post-redesign: the person_id IS the contact policy key, so a
      // blocked contact must still resolve to a person — it just isn't
      // gate-eligible (syncProjections prunes it). The old "skip the
      // people mirror for blocked" optimisation no longer applies.
      const { repo: contactRepo } = makeSpyRepo();
      setContactRepository(contactRepo);
      const peopleSpy: Array<{ did: string; displayName: string }> = [];
      setPeopleRepository(makeSpyPeopleRepo(peopleSpy));

      addContact('did:plc:bad', 'Bad Actor', 'blocked');

      expect(peopleSpy).toEqual([{ did: 'did:plc:bad', displayName: 'Bad Actor' }]);
      setPeopleRepository(null);
    });

    it('addContact FAILS when the people-graph write throws (people is load-bearing)', () => {
      // Post-redesign the people graph is no longer optional enrichment:
      // contact policy is keyed by person_id, so if the person/identity
      // write fails there is no key to store policy under. The failure
      // must surface, not be swallowed.
      const { repo: contactRepo } = makeSpyRepo();
      setContactRepository(contactRepo);
      setPeopleRepository(
        makeStubPeopleRepo({
          upsertContactPerson: () => {
            throw new Error('people db locked');
          },
        }),
      );

      expect(() => addContact('did:plc:alice', 'Alice', 'verified')).toThrow('people db locked');
      expect(getContact('did:plc:alice')).toBeNull();
      setPeopleRepository(null);
    });

    it('addContact throws when no people repo is wired (people is a required dependency)', () => {
      const { repo: contactRepo } = makeSpyRepo();
      setContactRepository(contactRepo);
      setPeopleRepository(null);
      expect(() => addContact('did:plc:alice', 'Alice', 'verified')).toThrow('not wired');
    });

    it('repo failure surfaces — memory does not silently diverge', () => {
      // GAP-PERSIST-01 contract: SQL write happens FIRST. If it
      // throws, the in-memory Map must NOT have been mutated. Without
      // this ordering, a transient SQL failure (full disk, locked DB)
      // would leave stale state in memory until the next app boot.
      const repo: ContactRepository = {
        list: () => [],
        add: () => {
          throw new Error('disk full');
        },
        get: () => null,
        update: () => {
          /* unused */
        },
        remove: () => true,
        addAlias: () => {
          /* unused */
        },
        removeAlias: () => {
          /* unused */
        },
        resolveAlias: () => null,
        getAliases: () => [],
        setPreferredFor: () => {
          /* unused */
        },
        getPreferredFor: () => [],
        findByPreferredFor: () => [],
      };
      setContactRepository(repo);
      expect(() => addContact('did:plc:alice', 'Alice')).toThrow('disk full');
      // Memory MUST NOT have the contact — write-through ordering.
      expect(getContact('did:plc:alice')).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Phase D matrix — projection sync (block/unblock prune+restore) +
  // lifecycle (delete preserves the person + identity).
  // ----------------------------------------------------------------
  describe('projection sync + lifecycle (Phase D matrix)', () => {
    it('a non-blocked contact is in the D2D gate + ring-1 source trust', () => {
      addContact('did:plc:alice', 'Alice', 'verified');
      expect(checkContactGate('did:plc:alice')).toBe(true);
      expect(isContactRing1('did:plc:alice')).toBe(true);
    });

    it('blocking a contact prunes it from the gate + source trust', () => {
      addContact('did:plc:alice', 'Alice', 'verified');
      expect(checkContactGate('did:plc:alice')).toBe(true);
      updateContact('did:plc:alice', { trustLevel: 'blocked' });
      expect(checkContactGate('did:plc:alice')).toBe(false);
      expect(isContactRing1('did:plc:alice')).toBe(false);
    });

    it('unblocking restores the gate + source trust', () => {
      addContact('did:plc:alice', 'Alice', 'verified');
      updateContact('did:plc:alice', { trustLevel: 'blocked' });
      expect(checkContactGate('did:plc:alice')).toBe(false);
      updateContact('did:plc:alice', { trustLevel: 'verified' });
      expect(checkContactGate('did:plc:alice')).toBe(true);
      expect(isContactRing1('did:plc:alice')).toBe(true);
    });

    it('deleting a contact prunes projections but PRESERVES the person + identity', () => {
      addContact('did:plc:alice', 'Alice', 'verified');
      const before = getPeopleRepository()?.resolveByIdentity('did', 'did:plc:alice');
      expect(before).not.toBeNull();
      deleteContact('did:plc:alice');
      // Contact policy + projections gone…
      expect(getContact('did:plc:alice')).toBeNull();
      expect(checkContactGate('did:plc:alice')).toBe(false);
      // …but the person + their DID identity survive (history preserved).
      const after = getPeopleRepository()?.resolveByIdentity('did', 'did:plc:alice');
      expect(after?.personId).toBe(before?.personId);
    });

    it('rebuildContactProjections prunes orphaned DIDs + restores real ones', () => {
      addContact('did:plc:alice', 'Alice', 'verified');
      // Simulate drift: a stale DID in the gate with no backing contact
      // (e.g. a person rejected via the people repo without a directory
      // removal). rebuild must prune it and keep the real contact.
      addEgressGateContact('did:plc:ghost');
      expect(checkContactGate('did:plc:ghost')).toBe(true);

      rebuildContactProjections();

      expect(checkContactGate('did:plc:ghost')).toBe(false); // orphan pruned
      expect(checkContactGate('did:plc:alice')).toBe(true); // real contact kept
      expect(isContactRing1('did:plc:alice')).toBe(true);
    });

    it('mergeContactPersons folds policy + re-points subject links + tombstones the loser', () => {
      setVaultRepository('general', new InMemoryVaultRepository());
      try {
        const keep = addContact('did:plc:keep', 'Keeper', 'verified');
        setPreferredFor('did:plc:keep', ['dental']);
        const loser = addContact('did:plc:loser', 'Loser', 'verified');
        setPreferredFor('did:plc:loser', ['tax']);

        // A REAL stored memory, subject-linked to the loser person — so
        // we can prove end-to-end recall survives the merge, not just that
        // a synthetic id moved between subject maps.
        const vault = getVaultRepository('general')!;
        vault.storeItemSync({
          id: 'item-pref',
          type: 'note',
          persona: 'general',
          content_l0: 'Loser prefers oat milk',
          timestamp: Date.now(),
        } as unknown as Parameters<typeof vault.storeItemSync>[0]);
        vault.linkSubjectSync('item-pref', loser.personId, { source: 'manual' });

        // Sanity: the loser's note is retrievable BEFORE the merge.
        expect(
          vault.getItemsForPersonSync(loser.personId, 10).map((i) => i.id),
        ).toEqual(['item-pref']);

        mergeContactPersons(keep.personId, loser.personId);

        // Subject link re-pointed to the survivor; none left on the loser.
        expect(vault.getItemIdsForPersonSync(keep.personId)).toContain('item-pref');
        expect(vault.getItemIdsForPersonSync(loser.personId)).toEqual([]);
        // The REAL item is now recallable through the survivor — content
        // and all — which is the actual user-visible promise of a merge.
        const recalled = vault.getItemsForPersonSync(keep.personId, 10);
        expect(recalled.map((i) => i.id)).toContain('item-pref');
        expect(recalled.find((i) => i.id === 'item-pref')?.content_l0).toBe(
          'Loser prefers oat milk',
        );
        // Contact policy folded: survivor now carries both preferred_for.
        expect(getContact('did:plc:keep')?.preferredFor?.sort()).toEqual(['dental', 'tax']);
        // …and the merged categories are PERSISTED, not just in the live
        // map: a hydrate round-trip (proxy for restart) must still show
        // both. `update()` ignores preferred_for, so without the explicit
        // setPreferredFor in the merge the loser's 'tax' would vanish here.
        resetContactDirectory();
        hydrateContactDirectory();
        expect(getContact('did:plc:keep')?.preferredFor?.sort()).toEqual(['dental', 'tax']);
        // Loser tombstoned; its DID now resolves to the survivor (identity moved).
        expect(getPeopleRepository()?.getPerson(loser.personId)?.status).toBe('rejected');
        expect(getContact('did:plc:loser')?.personId).toBe(keep.personId);
        // Only the survivor remains as a live person.
        expect(getPeopleRepository()?.listPeople().map((p) => p.personId)).toEqual([keep.personId]);
      } finally {
        setVaultRepository('general', null);
      }
    });

    it('two DIDs on one person both resolve to that person', () => {
      addContact('did:plc:alice-phone', 'Alice', 'verified');
      const personId = getPeopleRepository()?.resolveByIdentity(
        'did',
        'did:plc:alice-phone',
      )?.personId;
      expect(personId).toBeDefined();
      // Bind a second device DID to the same person.
      getPeopleRepository()?.upsertIdentity(personId!, 'did', 'did:plc:alice-laptop', {
        verified: true,
      });
      expect(getPeopleRepository()?.resolveByIdentity('did', 'did:plc:alice-laptop')?.personId).toBe(
        personId,
      );
    });
  });
});
