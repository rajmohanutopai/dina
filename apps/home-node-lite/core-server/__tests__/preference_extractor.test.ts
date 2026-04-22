/**
 * Task 5.40 — PreferenceExtractor tests.
 */

import {
  PreferenceExtractor,
  type PreferenceCandidate,
} from '../src/brain/preference_extractor';

describe('PreferenceExtractor (task 5.40)', () => {
  const extractor = new PreferenceExtractor();

  describe('direct pattern "my <role> <Name>"', () => {
    it('extracts "my dentist Dr Carl"', () => {
      const out = extractor.extract('my dentist Dr Carl');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('dentist');
      expect(out[0]!.name).toBe('Dr Carl');
      expect(out[0]!.categories).toEqual(['dental']);
    });

    it('extracts "my lawyer Kate Jones"', () => {
      const out = extractor.extract('my lawyer Kate Jones');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('lawyer');
      expect(out[0]!.name).toBe('Kate Jones');
      expect(out[0]!.categories).toEqual(['legal']);
    });

    it('accepts title-less names', () => {
      const out = extractor.extract('my accountant Linda Smith');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Linda Smith');
      expect(out[0]!.categories).toEqual(['tax', 'accounting']);
    });
  });

  describe('is pattern "my <role> is <Name>"', () => {
    it('extracts "my dentist is Dr Carl"', () => {
      const out = extractor.extract('my dentist is Dr Carl');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('dentist');
      expect(out[0]!.name).toBe('Dr Carl');
    });

    it('extracts "my accountant is Linda Smith"', () => {
      const out = extractor.extract('my accountant is Linda Smith');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('accountant');
      expect(out[0]!.name).toBe('Linda Smith');
    });
  });

  describe('with pattern "my <role> ... with <Name>"', () => {
    it('extracts "my dentist appointment with Dr Carl"', () => {
      const out = extractor.extract('my dentist appointment with Dr Carl');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Dr Carl');
    });

    it('extracts "my trainer session with Aaron"', () => {
      const out = extractor.extract('my trainer session with Aaron');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('trainer');
      expect(out[0]!.name).toBe('Aaron');
      expect(out[0]!.categories).toEqual(['fitness']);
    });

    it('extracts "my lawyer consultation with Kate Jones"', () => {
      const out = extractor.extract('my lawyer consultation with Kate Jones');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Kate Jones');
    });
  });

  describe('name boundary — stops at lowercase tokens', () => {
    it('"my dentist Dr Carl is on April 19" → name stops at "Dr Carl"', () => {
      const out = extractor.extract('my dentist Dr Carl is on April 19');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Dr Carl');
    });

    it('does not grab trailing verb into the name', () => {
      const out = extractor.extract('my doctor Jane said hello');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Jane');
    });

    it('multi-word capitalised names work (up to 3 words)', () => {
      const out = extractor.extract('my lawyer Mary Jane Watson called');
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Mary Jane Watson');
    });
  });

  describe('dedupe', () => {
    it('same assertion twice → one candidate', () => {
      const out = extractor.extract(
        'My dentist Dr Carl. I saw my dentist Dr Carl yesterday.',
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('Dr Carl');
    });

    it('"is" + direct form same assertion → one candidate', () => {
      const out = extractor.extract(
        'My dentist is Dr Carl. My dentist Dr Carl confirmed.',
      );
      expect(out).toHaveLength(1);
    });

    it('case-insensitive dedupe key', () => {
      const out = extractor.extract(
        'My dentist Dr CARL and my dentist Dr Carl are the same person.',
      );
      expect(out).toHaveLength(1);
    });

    it('different roles for same name → separate candidates', () => {
      const out = extractor.extract(
        'My lawyer Kate Jones and my accountant Kate Jones too.',
      );
      expect(out).toHaveLength(2);
      expect(out.map((c) => c.role).sort()).toEqual(['accountant', 'lawyer']);
    });
  });

  describe('negative cases', () => {
    it('empty string → []', () => {
      expect(extractor.extract('')).toEqual([]);
    });

    it('non-string input → []', () => {
      expect(extractor.extract(null as unknown as string)).toEqual([]);
      expect(extractor.extract(undefined as unknown as string)).toEqual([]);
    });

    it('no "my" anchor → no match', () => {
      expect(extractor.extract('the dentist Dr Carl')).toEqual([]);
      expect(extractor.extract('dentist Dr Carl')).toEqual([]);
    });

    it('unknown role word → no match', () => {
      expect(extractor.extract('my astronaut is Dr Carl')).toEqual([]);
    });

    it('role substring not a word → no match', () => {
      // "dentistry" shouldn't match role=dentist.
      expect(extractor.extract('my dentistry practice is nearby')).toEqual([]);
    });

    it('lowercase name → no match (capitalised required)', () => {
      expect(extractor.extract('my dentist carl yesterday')).toEqual([]);
    });

    it('possessive-apostrophe on role → no match', () => {
      // "my dentist's" — the 's is attached to dentist, so regex for
      // role=dentist requires the trailing whitespace. This tests
      // the `\s+` after role.
      expect(extractor.extract("my dentist's office is closed")).toEqual([]);
    });
  });

  describe('role coverage', () => {
    it.each([
      ['dentist', 'dental'],
      ['doctor', 'medical'],
      ['physician', 'medical'],
      ['gp', 'medical'],
      ['pediatrician', 'pediatric'],
      ['accountant', 'tax'],
      ['cpa', 'tax'],
      ['lawyer', 'legal'],
      ['attorney', 'legal'],
      ['mechanic', 'automotive'],
      ['plumber', 'plumbing'],
      ['electrician', 'electrical'],
      ['vet', 'veterinary'],
      ['barber', 'hair'],
      ['therapist', 'mental_health'],
      ['trainer', 'fitness'],
      ['pharmacist', 'pharmacy'],
      ['optometrist', 'optical'],
      ['chiropractor', 'chiropractic'],
      ['realtor', 'real_estate'],
      ['broker', 'real_estate'],
      ['banker', 'banking'],
      ['florist', 'floral'],
      ['nanny', 'childcare'],
      ['tutor', 'education'],
    ])('role=%s maps to category including "%s"', (role, expectedCat) => {
      const out = extractor.extract(`my ${role} Alice`);
      expect(out).toHaveLength(1);
      expect(out[0]!.categories).toContain(expectedCat);
    });
  });

  describe('knownRoles + categoriesFor', () => {
    it('knownRoles is sorted + non-empty', () => {
      const roles = extractor.knownRoles;
      expect(roles.length).toBeGreaterThan(30);
      const sorted = [...roles].sort();
      expect([...roles]).toEqual(sorted);
    });

    it('categoriesFor returns the mapping or []', () => {
      expect(extractor.categoriesFor('dentist')).toEqual(['dental']);
      expect(extractor.categoriesFor('Accountant')).toEqual(['tax', 'accounting']);
      expect(extractor.categoriesFor('nonexistent')).toEqual([]);
    });
  });

  describe('case handling', () => {
    it('"My Dentist Dr Carl" works — my+role CI', () => {
      const out = extractor.extract('My Dentist Dr Carl');
      expect(out).toHaveLength(1);
      expect(out[0]!.role).toBe('dentist');
    });
  });

  describe('categories array isolation', () => {
    it('mutating a candidate\'s categories does not leak into other candidates', () => {
      const out1 = extractor.extract('my dentist Alice');
      const out2 = extractor.extract('my dentist Bob');
      out1[0]!.categories.push('MUTATED');
      expect(out2[0]!.categories).toEqual(['dental']);
    });
  });

  describe('realistic captured-memory strings', () => {
    it('extracts from a multi-line captured note', () => {
      const text = [
        'Took notes today:',
        '- my dentist Dr Carl scheduled for April 19',
        '- my accountant is Linda Smith',
        '- my trainer session with Aaron on Tuesday',
      ].join('\n');
      const out = extractor.extract(text);
      const byRole = new Map<string, PreferenceCandidate>();
      for (const c of out) byRole.set(c.role, c);
      expect(byRole.get('dentist')!.name).toBe('Dr Carl');
      expect(byRole.get('accountant')!.name).toBe('Linda Smith');
      expect(byRole.get('trainer')!.name).toBe('Aaron');
    });
  });
});
