/**
 * Contact validation tests — relationships, data responsibility,
 * alias rules, reserved pronouns.
 */

import {
  VALID_RELATIONSHIPS,
  VALID_DATA_RESPONSIBILITY,
  RESERVED_ALIASES,
  defaultResponsibility,
  normalizeAlias,
  validateAlias,
  validateRelationship,
  validateDataResponsibility,
} from '../../src/contacts/validation';
import {
  addContact,
  addAlias,
  deleteContact,
  resetContactDirectory,
} from '../../src/contacts/directory';

describe('Contact Validation', () => {
  describe('validation sets', () => {
    it('has 8 valid relationships', () => {
      expect(VALID_RELATIONSHIPS.size).toBe(8);
      expect(VALID_RELATIONSHIPS.has('spouse')).toBe(true);
      expect(VALID_RELATIONSHIPS.has('child')).toBe(true);
      expect(VALID_RELATIONSHIPS.has('friend')).toBe(true);
      expect(VALID_RELATIONSHIPS.has('unknown')).toBe(true);
    });

    it('has 4 valid data responsibilities', () => {
      expect(VALID_DATA_RESPONSIBILITY.size).toBe(4);
      expect(VALID_DATA_RESPONSIBILITY.has('household')).toBe(true);
      expect(VALID_DATA_RESPONSIBILITY.has('external')).toBe(true);
    });

    it('excludes "self" from data responsibility (pipeline-only)', () => {
      expect(VALID_DATA_RESPONSIBILITY.has('self')).toBe(false);
    });

    it('has 16 reserved alias pronouns', () => {
      expect(RESERVED_ALIASES.size).toBe(16);
      expect(RESERVED_ALIASES.has('he')).toBe(true);
      expect(RESERVED_ALIASES.has('she')).toBe(true);
      expect(RESERVED_ALIASES.has('they')).toBe(true);
      expect(RESERVED_ALIASES.has('i')).toBe(true);
      expect(RESERVED_ALIASES.has('me')).toBe(true);
      expect(RESERVED_ALIASES.has('us')).toBe(true);
    });
  });

  describe('defaultResponsibility', () => {
    it('spouse → household', () => {
      expect(defaultResponsibility('spouse')).toBe('household');
    });

    it('child → household', () => {
      expect(defaultResponsibility('child')).toBe('household');
    });

    it('parent → external', () => {
      expect(defaultResponsibility('parent')).toBe('external');
    });

    it('friend → external', () => {
      expect(defaultResponsibility('friend')).toBe('external');
    });

    it('colleague → external', () => {
      expect(defaultResponsibility('colleague')).toBe('external');
    });
  });

  describe('validateAlias', () => {
    it('accepts valid aliases', () => {
      expect(validateAlias('Bob')).toBeNull();
      expect(validateAlias('Alice')).toBeNull();
      expect(validateAlias('Dr. Smith')).toBeNull();
    });

    it('rejects empty alias', () => {
      expect(validateAlias('')).toContain('empty');
      expect(validateAlias('   ')).toContain('empty');
    });

    it('rejects single-character alias', () => {
      expect(validateAlias('A')).toContain('at least 2');
    });

    it('rejects all 16 reserved pronouns (length or pronoun check)', () => {
      for (const pronoun of RESERVED_ALIASES) {
        const err = validateAlias(pronoun);
        expect(err).not.toBeNull();
        // Single-char pronouns ("i") fail the length check first;
        // multi-char pronouns fail the reserved check
        if (pronoun.length < 2) {
          expect(err).toContain('at least 2');
        } else {
          expect(err).toContain('reserved pronoun');
        }
      }
    });

    it('rejects pronouns case-insensitively', () => {
      expect(validateAlias('He')).toContain('reserved pronoun');
      expect(validateAlias('SHE')).toContain('reserved pronoun');
      expect(validateAlias('They')).toContain('reserved pronoun');
      expect(validateAlias('  Me  ')).toContain('reserved pronoun');
    });

    it('accepts 2-character non-pronoun aliases', () => {
      expect(validateAlias('Jo')).toBeNull();
      expect(validateAlias('Al')).toBeNull();
    });
  });

  describe('validateRelationship', () => {
    it('accepts all 8 valid relationships', () => {
      for (const r of VALID_RELATIONSHIPS) {
        expect(validateRelationship(r)).toBeNull();
      }
    });

    it('rejects invalid relationships', () => {
      expect(validateRelationship('bestie')).toContain('invalid relationship');
      expect(validateRelationship('enemy')).toContain('invalid relationship');
    });
  });

  describe('addAlias integration — reserved pronoun rejection', () => {
    beforeEach(() => resetContactDirectory());

    it('rejects pronoun aliases on addAlias', () => {
      addContact('did:key:z123', 'Alice');

      expect(() => addAlias('did:key:z123', 'she')).toThrow('reserved pronoun');
      expect(() => addAlias('did:key:z123', 'He')).toThrow('reserved pronoun');
      expect(() => addAlias('did:key:z123', 'THEY')).toThrow('reserved pronoun');
    });

    it('rejects single-character aliases on addAlias', () => {
      addContact('did:key:z123', 'Bob');

      expect(() => addAlias('did:key:z123', 'B')).toThrow('at least 2');
    });

    it('accepts valid aliases on addAlias', () => {
      addContact('did:key:z123', 'Charlie');

      expect(() => addAlias('did:key:z123', 'Chuck')).not.toThrow();
      expect(() => addAlias('did:key:z123', 'CJ')).not.toThrow();
    });
  });
});
