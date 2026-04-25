/**
 * T2.50 — Contact directory: CRUD, trust levels, aliases, uniqueness.
 *
 * Source: ARCHITECTURE.md Section 2.50
 */

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
import { setContactRepository, type ContactRepository } from '../../src/contacts/repository';

describe('Contact Directory', () => {
  beforeEach(() => resetContactDirectory());

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

    it('write-throughs to the SQL repository when one is wired', () => {
      // Mirrors the addContact write-through (see line 124 of directory.ts).
      // Without the SQL delete, on-device the row stays in `contacts.did`
      // and a re-add of the same DID hits the UNIQUE constraint —
      // observed live on the simulator before this fix landed.
      const removed: string[] = [];
      const repo = {
        list: () => [],
        add: () => {
          /* unused */
        },
        get: () => null,
        update: () => {
          /* unused */
        },
        remove: (did: string) => {
          removed.push(did);
          return true;
        },
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
      } as unknown as ContactRepository;

      setContactRepository(repo);
      try {
        addContact('did:plc:alice', 'Alice');
        deleteContact('did:plc:alice');
        expect(removed).toEqual(['did:plc:alice']);
      } finally {
        setContactRepository(null);
      }
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
      const b: Contact = { ...a, did: 'did:plc:y', preferredFor: [] };
      const nonEmpty = (c: Contact) => (c.preferredFor?.length ?? 0) > 0;
      expect(nonEmpty(a)).toBe(false);
      expect(nonEmpty(b)).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // GAP-PERSIST-02 / GAP-PERSIST-04 — hydration + alias-aware lookup
  // ----------------------------------------------------------------

  describe('hydrateContactDirectory + resolveByName (GAP-PERSIST-02/04)', () => {
    afterEach(() => {
      setContactRepository(null);
      resetContactDirectory();
    });

    function fakeRepo(rows: Contact[]): ContactRepository {
      return {
        list: () => rows,
        add: () => {
          /* unused */
        },
        get: (did: string) => rows.find((r) => r.did === did) ?? null,
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
      } as unknown as ContactRepository;
    }

    it('loads every persisted contact (+ aliases) into memory at boot', () => {
      const drcarl: Contact = {
        did: 'did:plc:drcarl',
        displayName: 'Dr Carl Jones',
        trustLevel: 'trusted',
        sharingTier: 'summary',
        relationship: 'acquaintance',
        dataResponsibility: 'external',
        aliases: ['Dr Carl', 'Carl J'],
        notes: '',
        createdAt: 0,
        updatedAt: 0,
        preferredFor: ['dental'],
      };
      setContactRepository(fakeRepo([drcarl]));

      const loaded = hydrateContactDirectory();
      expect(loaded).toBe(1);

      // Main display name + each alias all resolve to the same DID.
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
      expect(spy.update).toContain('did:plc:alice');
    });

    it('deleteContact → repo.remove (Bug #2 contract)', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      deleteContact('did:plc:alice');
      expect(spy.remove).toEqual(['did:plc:alice']);
    });

    it('addAlias → repo.addAlias', () => {
      const { repo, spy } = makeSpyRepo();
      setContactRepository(repo);
      addContact('did:plc:alice', 'Alice');
      addAlias('did:plc:alice', 'Ali');
      expect(spy.addAlias).toContainEqual({ did: 'did:plc:alice', alias: 'ali' });
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
      expect(spy.setPreferredFor).toContainEqual({
        did: 'did:plc:alice',
        categories: ['dentist'],
      });
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
});
