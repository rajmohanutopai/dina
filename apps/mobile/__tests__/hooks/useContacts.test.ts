/**
 * T6.16 — Contacts tab: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 6.16
 */

import {
  getContactList,
  searchContacts,
  filterByTrust,
  addNewContact,
  removeContact,
  getTrustBreakdown,
  getContactCount,
  getTrustLevelOptions,
  resetContacts,
} from '../../src/hooks/useContacts';
import { addAlias } from '../../../core/src/contacts/directory';

describe('Contacts Tab Hook (6.16)', () => {
  beforeEach(() => resetContacts());

  describe('getContactList', () => {
    it('returns empty when no contacts', () => {
      expect(getContactList()).toHaveLength(0);
    });

    it('returns contacts sorted alphabetically', () => {
      addNewContact('did:key:z6MkC', 'Charlie');
      addNewContact('did:key:z6MkA', 'Alice');
      addNewContact('did:key:z6MkB', 'Bob');

      const list = getContactList();
      expect(list.map((c) => c.displayName)).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('includes trust badge and initials', () => {
      addNewContact('did:key:z6MkA', 'Alice Smith', 'trusted');

      const contact = getContactList()[0];
      expect(contact.trustBadge).toBe('Trusted');
      expect(contact.initials).toBe('AS');
    });

    it('defaults trust to unknown', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      expect(getContactList()[0].trustLevel).toBe('unknown');
    });
  });

  describe('searchContacts', () => {
    beforeEach(() => {
      addNewContact('did:key:z6MkA', 'Alice Johnson');
      addNewContact('did:key:z6MkB', 'Bob Smith');
      addNewContact('did:key:z6MkC', 'Charlie Brown');
    });

    it('finds by name', () => {
      const results = searchContacts('alice');
      expect(results).toHaveLength(1);
      expect(results[0].displayName).toBe('Alice Johnson');
    });

    it('finds by partial name', () => {
      expect(searchContacts('son')).toHaveLength(1); // Johnson
    });

    it('finds by DID', () => {
      expect(searchContacts('z6MkB')).toHaveLength(1);
    });

    it('finds by alias', () => {
      addAlias('did:key:z6MkA', 'Ali');
      expect(searchContacts('ali')).toHaveLength(1);
    });

    it('returns all on empty query', () => {
      expect(searchContacts('')).toHaveLength(3);
    });

    it('case-insensitive', () => {
      expect(searchContacts('ALICE')).toHaveLength(1);
    });
  });

  describe('filterByTrust', () => {
    beforeEach(() => {
      addNewContact('did:key:z6MkA', 'Alice', 'trusted');
      addNewContact('did:key:z6MkB', 'Bob', 'verified');
      addNewContact('did:key:z6MkC', 'Charlie', 'trusted');
    });

    it('filters by trust level', () => {
      expect(filterByTrust('trusted')).toHaveLength(2);
      expect(filterByTrust('verified')).toHaveLength(1);
      expect(filterByTrust('blocked')).toHaveLength(0);
    });
  });

  describe('addNewContact', () => {
    it('adds a contact', () => {
      expect(addNewContact('did:key:z6MkA', 'Alice')).toBeNull();
      expect(getContactCount()).toBe(1);
    });

    it('rejects empty DID', () => {
      expect(addNewContact('', 'Alice')).toContain('DID is required');
    });

    it('rejects empty name', () => {
      expect(addNewContact('did:key:z6MkA', '')).toContain('name is required');
    });

    it('rejects duplicate', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      expect(addNewContact('did:key:z6MkA', 'Alice2')).toContain('already exists');
    });

    it('accepts trust level', () => {
      addNewContact('did:key:z6MkA', 'Alice', 'verified');
      expect(getContactList()[0].trustLevel).toBe('verified');
    });
  });

  describe('removeContact', () => {
    it('removes a contact', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      expect(removeContact('did:key:z6MkA')).toBe(true);
      expect(getContactCount()).toBe(0);
    });

    it('returns false for missing', () => {
      expect(removeContact('did:key:nonexistent')).toBe(false);
    });
  });

  describe('getTrustBreakdown', () => {
    it('counts per trust level', () => {
      addNewContact('did:key:z6MkA', 'A', 'trusted');
      addNewContact('did:key:z6MkB', 'B', 'trusted');
      addNewContact('did:key:z6MkC', 'C', 'blocked');

      const breakdown = getTrustBreakdown();
      expect(breakdown.trusted).toBe(2);
      expect(breakdown.blocked).toBe(1);
      expect(breakdown.unknown).toBe(0);
    });
  });

  describe('getTrustLevelOptions', () => {
    it('returns 4 options', () => {
      const options = getTrustLevelOptions();
      expect(options).toHaveLength(4);
      expect(options.map((o) => o.value)).toEqual(['trusted', 'verified', 'unknown', 'blocked']);
    });
  });

  describe('UI fields', () => {
    it('formats initials from two-word name', () => {
      addNewContact('did:key:z6MkA', 'Alice Johnson');
      expect(getContactList()[0].initials).toBe('AJ');
    });

    it('formats initials from single-word name', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      expect(getContactList()[0].initials).toBe('AL');
    });

    it('formats alias label', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      addAlias('did:key:z6MkA', 'Ali');
      addAlias('did:key:z6MkA', 'Al');

      const contact = getContactList()[0];
      expect(contact.aliasLabel).toBe('Ali, Al');
    });

    it('empty alias label when no aliases', () => {
      addNewContact('did:key:z6MkA', 'Alice');
      expect(getContactList()[0].aliasLabel).toBe('');
    });
  });
});
