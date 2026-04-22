/**
 * T6.18 — Phone contacts import: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 6.18
 */

import {
  configurePhoneContacts,
  requestPermission,
  fetchPhoneContacts,
  matchContact,
  importPhoneContacts,
  normalizePhone,
  normalizeEmail,
  resetPhoneContacts,
  type PhoneContact,
} from '../../src/hooks/usePhoneContacts';
import {
  addContact,
  listContacts,
  resetContactDirectory,
} from '../../../core/src/contacts/directory';

const PHONE_CONTACTS: PhoneContact[] = [
  { id: 'p1', name: 'Alice Johnson', phones: ['+1-555-0101'], emails: ['alice@example.com'] },
  { id: 'p2', name: 'Bob Smith', phones: ['+1-555-0102'], emails: [] },
  { id: 'p3', name: 'Charlie Brown', phones: [], emails: ['charlie@example.com'] },
  { id: 'p4', name: '', phones: ['+1-555-0104'], emails: [] }, // no name — should skip
];

describe('Phone Contacts Import Hook (6.18)', () => {
  beforeEach(() => {
    resetPhoneContacts();
    resetContactDirectory();
  });

  describe('permission', () => {
    it('returns denied when not configured', async () => {
      expect(await requestPermission()).toBe('denied');
    });

    it('returns granted when permission configured', async () => {
      configurePhoneContacts({
        fetchContacts: async () => [],
        requestPermission: async () => 'granted',
      });
      expect(await requestPermission()).toBe('granted');
    });
  });

  describe('fetchPhoneContacts', () => {
    it('returns empty when not configured', async () => {
      expect(await fetchPhoneContacts()).toHaveLength(0);
    });

    it('returns contacts from native fetcher', async () => {
      configurePhoneContacts({
        fetchContacts: async () => PHONE_CONTACTS,
        requestPermission: async () => 'granted',
      });

      const contacts = await fetchPhoneContacts();
      expect(contacts).toHaveLength(4);
    });
  });

  describe('matchContact', () => {
    it('matches by display name', () => {
      addContact('did:key:z6MkAlice', 'Alice Johnson');
      const existing = listContacts();

      const match = matchContact(PHONE_CONTACTS[0], existing);
      expect(match).toBe('did:key:z6MkAlice');
    });

    it('matches case-insensitively', () => {
      addContact('did:key:z6MkBob', 'bob smith');
      const existing = listContacts();

      expect(matchContact(PHONE_CONTACTS[1], existing)).toBe('did:key:z6MkBob');
    });

    it('returns null for no match', () => {
      const existing = listContacts();
      expect(matchContact(PHONE_CONTACTS[0], existing)).toBeNull();
    });
  });

  describe('importPhoneContacts', () => {
    beforeEach(() => {
      configurePhoneContacts({
        fetchContacts: async () => PHONE_CONTACTS,
        requestPermission: async () => 'granted',
      });
    });

    it('imports unmatched contacts', async () => {
      const result = await importPhoneContacts();

      expect(result.total).toBe(4);
      expect(result.imported).toBe(3); // Alice, Bob, Charlie
      expect(result.skipped).toBe(1); // empty name
      expect(result.matched).toBe(0);
    });

    it('skips already-matched contacts', async () => {
      addContact('did:key:z6MkAlice', 'Alice Johnson');

      const result = await importPhoneContacts();

      expect(result.matched).toBe(1); // Alice matched
      expect(result.imported).toBe(2); // Bob, Charlie imported
    });

    it('skips contacts without names', async () => {
      const result = await importPhoneContacts();
      expect(result.skipped).toBe(1);
    });

    it('creates contacts with did:phone: prefix', async () => {
      await importPhoneContacts();

      const all = listContacts();
      const phoneContacts = all.filter((c) => c.did.startsWith('did:phone:'));
      expect(phoneContacts.length).toBe(3);
    });

    it('returns empty result when no contacts fetched', async () => {
      configurePhoneContacts({
        fetchContacts: async () => [],
        requestPermission: async () => 'granted',
      });

      const result = await importPhoneContacts();
      expect(result.total).toBe(0);
      expect(result.imported).toBe(0);
    });
  });

  describe('normalization', () => {
    it('normalizePhone strips non-digits', () => {
      expect(normalizePhone('+1 (555) 010-1')).toBe('+15550101');
      expect(normalizePhone('555.010.1234')).toBe('5550101234');
    });

    it('normalizeEmail lowercases and trims', () => {
      expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
    });
  });
});
