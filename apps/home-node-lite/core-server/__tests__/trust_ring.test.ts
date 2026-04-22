/**
 * Task 6.22 — trust ring resolution tests.
 */

import {
  TrustRingIndex,
  resolveRing,
  type Did,
} from '../src/appview/trust_ring';

const USER: Did = 'did:plc:user-self';
const FRIEND_A: Did = 'did:plc:friend-alice';
const FRIEND_B: Did = 'did:plc:friend-bob';
const FOF_X: Did = 'did:plc:friend-of-friend-x';
const FOF_Y: Did = 'did:plc:friend-of-friend-y';
const STRANGER: Did = 'did:plc:stranger';

describe('resolveRing (task 6.22)', () => {
  describe('basic ring assignment', () => {
    it('user\'s own DID → ring 1 (self)', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: USER,
          contacts: [FRIEND_A, FRIEND_B],
          twoHopContacts: [FOF_X, FOF_Y],
        }),
      ).toBe(1);
    });

    it('direct contact → ring 1', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: FRIEND_A,
          contacts: [FRIEND_A, FRIEND_B],
          twoHopContacts: [FOF_X, FOF_Y],
        }),
      ).toBe(1);
    });

    it('2-hop contact → ring 2', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: FOF_X,
          contacts: [FRIEND_A, FRIEND_B],
          twoHopContacts: [FOF_X, FOF_Y],
        }),
      ).toBe(2);
    });

    it('unknown DID → ring 3 (stranger)', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: STRANGER,
          contacts: [FRIEND_A, FRIEND_B],
          twoHopContacts: [FOF_X, FOF_Y],
        }),
      ).toBe(3);
    });
  });

  describe('userDid unknown', () => {
    it('null userDid → null result', () => {
      expect(
        resolveRing({
          userDid: null,
          subjectDid: FRIEND_A,
          contacts: [FRIEND_A],
          twoHopContacts: [],
        }),
      ).toBeNull();
    });

    it('empty-string userDid → null result', () => {
      expect(
        resolveRing({
          userDid: '',
          subjectDid: FRIEND_A,
          contacts: [FRIEND_A],
          twoHopContacts: [],
        }),
      ).toBeNull();
    });
  });

  describe('subject edge cases', () => {
    it('empty subject DID → ring 3', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: '',
          contacts: [FRIEND_A],
          twoHopContacts: [],
        }),
      ).toBe(3);
    });

    it('subject in BOTH direct + 2-hop → ring 1 wins (closer)', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: FRIEND_A,
          contacts: [FRIEND_A],
          twoHopContacts: [FRIEND_A],
        }),
      ).toBe(1);
    });

    it('empty contact lists → always ring 3 (unless self)', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: STRANGER,
          contacts: [],
          twoHopContacts: [],
        }),
      ).toBe(3);
    });

    it('case-sensitive DID comparison', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: FRIEND_A.toUpperCase(),
          contacts: [FRIEND_A],
          twoHopContacts: [],
        }),
      ).toBe(3);
    });

    it('iterables work — not just arrays (Set inputs)', () => {
      expect(
        resolveRing({
          userDid: USER,
          subjectDid: FRIEND_A,
          contacts: new Set([FRIEND_A, FRIEND_B]),
          twoHopContacts: new Set<string>(),
        }),
      ).toBe(1);
    });
  });
});

describe('TrustRingIndex (task 6.22)', () => {
  describe('single-subject lookup', () => {
    it('covers every branch of resolveRing', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A, FRIEND_B],
        twoHopContacts: [FOF_X, FOF_Y],
      });
      expect(idx.ring(USER)).toBe(1);
      expect(idx.ring(FRIEND_A)).toBe(1);
      expect(idx.ring(FOF_X)).toBe(2);
      expect(idx.ring(STRANGER)).toBe(3);
    });

    it('null userDid → every subject returns null', () => {
      const idx = new TrustRingIndex({
        userDid: null,
        contacts: [FRIEND_A],
        twoHopContacts: [],
      });
      expect(idx.ring(FRIEND_A)).toBeNull();
      expect(idx.ring(USER)).toBeNull();
      expect(idx.ring(STRANGER)).toBeNull();
    });

    it('empty userDid normalised to null', () => {
      const idx = new TrustRingIndex({
        userDid: '',
        contacts: [FRIEND_A],
        twoHopContacts: [],
      });
      expect(idx.ring(FRIEND_A)).toBeNull();
    });

    it('empty subject DID → ring 3 (not null)', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A],
        twoHopContacts: [],
      });
      expect(idx.ring('')).toBe(3);
    });
  });

  describe('batch lookup', () => {
    it('rings() preserves order', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A],
        twoHopContacts: [FOF_X],
      });
      const subjects = [STRANGER, FRIEND_A, FOF_X, USER];
      expect(idx.rings(subjects)).toEqual([3, 1, 2, 1]);
    });

    it('rings() with unknown user returns null for every subject', () => {
      const idx = new TrustRingIndex({
        userDid: null,
        contacts: [FRIEND_A, FRIEND_B],
        twoHopContacts: [FOF_X],
      });
      expect(idx.rings([FRIEND_A, FOF_X, STRANGER])).toEqual([null, null, null]);
    });

    it('rings() accepts arbitrary iterables', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A],
        twoHopContacts: [],
      });
      const subjects = new Set([STRANGER, FRIEND_A]);
      expect(idx.rings(subjects).sort()).toEqual([1, 3]);
    });

    it('rings() on empty input → empty array', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A],
        twoHopContacts: [],
      });
      expect(idx.rings([])).toEqual([]);
    });
  });

  describe('counts', () => {
    it('contactCount + twoHopCount reflect inputs', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A, FRIEND_B, FRIEND_A], // dup
        twoHopContacts: [FOF_X, FOF_Y],
      });
      // Set dedupes.
      expect(idx.contactCount()).toBe(2);
      expect(idx.twoHopCount()).toBe(2);
    });

    it('counts for empty inputs', () => {
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [],
        twoHopContacts: [],
      });
      expect(idx.contactCount()).toBe(0);
      expect(idx.twoHopCount()).toBe(0);
    });
  });

  describe('isolation', () => {
    it('mutating source iterables after construction does not affect rings', () => {
      const contacts: Did[] = [FRIEND_A];
      const twoHop: Did[] = [FOF_X];
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts,
        twoHopContacts: twoHop,
      });
      // Caller mutates the source array.
      contacts.push(STRANGER);
      twoHop.push(STRANGER);
      // Index was built from a Set snapshot — unchanged.
      expect(idx.ring(STRANGER)).toBe(3);
      expect(idx.contactCount()).toBe(1);
    });
  });

  describe('realistic search-result classification', () => {
    it('classifies a batch of candidates for service-query pre-flight', () => {
      // User has 3 contacts; 2 of them have a couple of 2-hop connections.
      const idx = new TrustRingIndex({
        userDid: USER,
        contacts: [FRIEND_A, FRIEND_B, 'did:plc:friend-carol'],
        twoHopContacts: [FOF_X, FOF_Y, 'did:plc:fof-z'],
      });
      // AppView returns 5 candidates ranked by trust.
      const candidates = [
        FRIEND_A,            // ring 1 (direct)
        'did:plc:fof-z',     // ring 2 (2-hop)
        'did:plc:unknown-1', // ring 3 (stranger)
        FOF_Y,               // ring 2
        USER,                // ring 1 (self — edge case, shouldn't appear but test anyway)
      ];
      expect(idx.rings(candidates)).toEqual([1, 2, 3, 2, 1]);
    });
  });
});
