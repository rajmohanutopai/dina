/**
 * Task 5.35 — ContactMatcher tests.
 */

import {
  ContactMatcher,
  type ContactEntry,
  type MatchedContact,
} from '../src/brain/contact_matcher';

const ALICE: ContactEntry = {
  name: 'Alice',
  did: 'did:plc:alice',
  relationship: 'friend',
  dataResponsibility: 'external',
};
const BOB: ContactEntry = {
  name: 'Bob Smith',
  did: 'did:plc:bob',
  relationship: 'colleague',
  dataResponsibility: 'external',
  aliases: ['Bobby'],
};
const EMMA: ContactEntry = {
  name: 'Emma Watson',
  did: 'did:plc:emma',
  relationship: 'friend',
  aliases: ['Emma'],
};
const MOM: ContactEntry = {
  name: 'Sarah Johnson',
  did: 'did:plc:mom',
  relationship: 'parent',
  aliases: ['Mom', 'Mother', 'my mom'],
};

describe('ContactMatcher (task 5.35)', () => {
  describe('basic matching', () => {
    it('returns [] for empty contact list', () => {
      const m = new ContactMatcher([]);
      expect(m.findMentions('Alice says hi')).toEqual([]);
    });

    it('returns [] for empty text', () => {
      const m = new ContactMatcher([ALICE]);
      expect(m.findMentions('')).toEqual([]);
    });

    it('finds a single mention', () => {
      const m = new ContactMatcher([ALICE]);
      const r = m.findMentions('I saw Alice yesterday');
      expect(r).toHaveLength(1);
      expect(r[0]!.name).toBe('Alice');
      expect(r[0]!.did).toBe('did:plc:alice');
      expect(r[0]!.span).toEqual([6, 11]);
      expect(r[0]!.matchedText).toBe('Alice');
    });

    it('propagates relationship + dataResponsibility fields', () => {
      const m = new ContactMatcher([ALICE]);
      const r = m.findMentions('Alice');
      expect(r[0]!.relationship).toBe('friend');
      expect(r[0]!.dataResponsibility).toBe('external');
    });

    it('defaults relationship to "unknown" when missing', () => {
      const m = new ContactMatcher([{ name: 'Zoe', did: 'did:plc:zoe' }]);
      const r = m.findMentions('Zoe');
      expect(r[0]!.relationship).toBe('unknown');
      expect(r[0]!.dataResponsibility).toBe('external');
    });
  });

  describe('case-insensitive matching', () => {
    it('matches lowercase / mixed-case surfaces', () => {
      const m = new ContactMatcher([ALICE]);
      expect(m.findMentions('ALICE').length).toBe(1);
      expect(m.findMentions('alice').length).toBe(1);
      expect(m.findMentions('AlIcE').length).toBe(1);
    });

    it('preserves original matchedText surface form', () => {
      const m = new ContactMatcher([ALICE]);
      const r = m.findMentions('ALICE said hi');
      expect(r[0]!.matchedText).toBe('ALICE');
      expect(r[0]!.name).toBe('Alice'); // canonical
    });
  });

  describe('word boundaries', () => {
    it('does not match within another word', () => {
      const m = new ContactMatcher([ALICE]);
      expect(m.findMentions('Malice in wonderland')).toEqual([]);
      expect(m.findMentions('alicesmith@example.com')).toEqual([]);
    });

    it('matches across punctuation', () => {
      const m = new ContactMatcher([ALICE]);
      expect(m.findMentions('(Alice)').length).toBe(1);
      expect(m.findMentions('"Alice said so"').length).toBe(1);
      expect(m.findMentions('Alice,').length).toBe(1);
    });
  });

  describe('aliases', () => {
    it('alias matches + reports canonical name', () => {
      const m = new ContactMatcher([BOB]);
      const r = m.findMentions('Bobby said hi');
      expect(r[0]!.name).toBe('Bob Smith');
      expect(r[0]!.matchedText).toBe('Bobby');
    });

    it('multi-word alias works', () => {
      const m = new ContactMatcher([MOM]);
      const r = m.findMentions('my mom called');
      expect(r[0]!.matchedText).toBe('my mom');
      expect(r[0]!.name).toBe('Sarah Johnson');
    });

    it('skips aliases shorter than 2 chars', () => {
      const m = new ContactMatcher([
        { name: 'Ian', did: 'did:plc:ian', aliases: ['I', 'Izi'] },
      ]);
      // 'I' skipped; 'Ian' + 'Izi' kept.
      expect(m.patternCount()).toBe(2);
    });
  });

  describe('longest-match-first priority', () => {
    it('"Emma Watson" matches before "Emma"', () => {
      const m = new ContactMatcher([EMMA]);
      const r = m.findMentions('I met Emma Watson yesterday');
      expect(r).toHaveLength(1);
      expect(r[0]!.matchedText).toBe('Emma Watson');
    });

    it('"Emma" alone still matches when no longer version in text', () => {
      const m = new ContactMatcher([EMMA]);
      const r = m.findMentions('Emma said hi');
      expect(r).toHaveLength(1);
      expect(r[0]!.matchedText).toBe('Emma');
    });

    it('multiple contacts — overlap resolved longest-first', () => {
      const short: ContactEntry = { name: 'Mark', did: 'did:plc:mark' };
      const long: ContactEntry = { name: 'Mark Twain', did: 'did:plc:twain' };
      const m = new ContactMatcher([short, long]);
      const r = m.findMentions('Mark Twain wrote books');
      expect(r).toHaveLength(1);
      expect(r[0]!.did).toBe('did:plc:twain');
      expect(r[0]!.matchedText).toBe('Mark Twain');
    });

    it('"my mom" alias beats "Mom" in "my mom called"', () => {
      const m = new ContactMatcher([MOM]);
      const r = m.findMentions('my mom called');
      expect(r).toHaveLength(1);
      expect(r[0]!.matchedText).toBe('my mom');
    });
  });

  describe('multiple mentions', () => {
    it('returns one match per occurrence', () => {
      const m = new ContactMatcher([ALICE]);
      const r = m.findMentions('Alice and Alice again');
      expect(r).toHaveLength(2);
      expect(r[0]!.span[0]).toBeLessThan(r[1]!.span[0]);
    });

    it('results sorted by position in text', () => {
      const m = new ContactMatcher([ALICE, BOB]);
      const r = m.findMentions('Bob Smith first, then Alice');
      expect(r.map((mc) => mc.matchedText)).toEqual(['Bob Smith', 'Alice']);
    });

    it('different contacts in same text', () => {
      const m = new ContactMatcher([ALICE, BOB, EMMA]);
      const r = m.findMentions('Alice, Bob Smith, and Emma Watson came');
      expect(r.map((mc) => mc.name)).toEqual([
        'Alice',
        'Bob Smith',
        'Emma Watson',
      ]);
    });
  });

  describe('deduplication at construction', () => {
    it('same DID + same lowered text → one pattern', () => {
      const m = new ContactMatcher([
        { name: 'Alice', did: 'did:plc:alice' },
        { name: 'ALICE', did: 'did:plc:alice' }, // dup
      ]);
      expect(m.patternCount()).toBe(1);
    });

    it('same text but different DID → two patterns', () => {
      const m = new ContactMatcher([
        { name: 'Alice', did: 'did:plc:alice1' },
        { name: 'Alice', did: 'did:plc:alice2' },
      ]);
      expect(m.patternCount()).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('skips entries with empty name + no aliases', () => {
      const m = new ContactMatcher([{ name: '', did: 'did:plc:x' }]);
      expect(m.patternCount()).toBe(0);
    });

    it('non-string aliases are ignored', () => {
      const m = new ContactMatcher([
        { name: 'Zoe', did: 'did:plc:zoe', aliases: ['Zo', 42 as unknown as string, null as unknown as string] },
      ]);
      expect(m.patternCount()).toBe(2); // Zoe + Zo
    });

    it('escapes regex metacharacters in names', () => {
      const m = new ContactMatcher([
        { name: 'Dr. O\'Brien', did: 'did:plc:obrien' },
      ]);
      // The dot + apostrophe must be literals, not regex specials.
      const r = m.findMentions("I saw Dr. O'Brien today");
      expect(r).toHaveLength(1);
      // And the matcher must NOT match e.g. "Dr X O'Brien" where dot means "any char".
      expect(m.findMentions('DrXOBrien').length).toBe(0);
    });

    it('debugPatterns exposes pattern sources + ids without regex objects', () => {
      const m = new ContactMatcher([ALICE]);
      const dbg = m.debugPatterns();
      expect(dbg).toHaveLength(1);
      expect(dbg[0]!.source).toContain('Alice');
      expect(dbg[0]!.did).toBe('did:plc:alice');
    });
  });

  describe('realistic captured notes', () => {
    it('captures contact mentions from a multi-sentence note', () => {
      const m = new ContactMatcher([ALICE, BOB, EMMA, MOM]);
      const note =
        'Chatting with Alice and Bob Smith at lunch. My mom will join ' +
        'later. Bobby might come too. Met Emma Watson on Tuesday.';
      const r = m.findMentions(note);
      const byName = new Map<string, MatchedContact[]>();
      for (const mc of r) {
        const list = byName.get(mc.name) ?? [];
        list.push(mc);
        byName.set(mc.name, list);
      }
      expect(byName.get('Alice')?.length).toBe(1);
      expect(byName.get('Bob Smith')?.length).toBe(2); // "Bob Smith" + "Bobby"
      expect(byName.get('Emma Watson')?.length).toBe(1);
      expect(byName.get('Sarah Johnson')?.length).toBe(1); // "My mom"
    });
  });
});
