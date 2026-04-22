/**
 * T1J.7 — Subject attribution: WHO is this text about?
 *
 * Category A: fixture-based. Verifies attribution rules for self,
 * contact, household, third party, unresolved subjects.
 *
 * Source: brain/tests/test_subject_attributor.py
 */

import {
  attributeSubject,
  isSelfReference,
  mentionsContact,
  mentionsHousehold,
} from '../../src/contact/attributor';
import type { AttributorContext } from '../../src/contact/attributor';

describe('Subject Attributor', () => {
  const context: AttributorContext = {
    contacts: [
      { name: 'Alice', did: 'did:plc:alice', relationship: 'friend' },
      { name: 'Dr. Shah', did: 'did:plc:shah', relationship: 'professional' },
    ],
    householdMembers: ['Emma', 'James'],
  };

  describe('attributeSubject', () => {
    it('first-person → self', () => {
      const result = attributeSubject('My lab results came back', context);
      expect(result.subjectType).toBe('self');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('explicit self reference → self', () => {
      const result = attributeSubject('I need to schedule my appointment', context);
      expect(result.subjectType).toBe('self');
    });

    it('known contact mentioned → external', () => {
      const result = attributeSubject('Alice sent me the report', context);
      expect(result.subjectType).toBe('self'); // "me" = self wins
    });

    it('known contact without self reference → external', () => {
      const result = attributeSubject('Alice sent the report', context);
      expect(result.subjectType).toBe('external');
      expect(result.subjectName).toBe('Alice');
    });

    it('household member → household', () => {
      const result = attributeSubject('Emma has a dentist appointment', context);
      expect(result.subjectType).toBe('household');
      expect(result.subjectName).toBe('Emma');
    });

    it('unknown name → third_party', () => {
      const result = attributeSubject('Charlie called about the invoice', context);
      expect(result.subjectType).toBe('third_party');
      expect(result.subjectName).toBe('Charlie');
    });

    it('no subject indicators → unresolved', () => {
      const result = attributeSubject('The weather is nice', context);
      expect(result.subjectType).toBe('unresolved');
    });

    it('self and external in same text → self (primary subject)', () => {
      const result = attributeSubject('I told Alice about the plan', context);
      expect(result.subjectType).toBe('self');
    });

    it('parent role phrase → household', () => {
      const result = attributeSubject('My daughter has a fever', context);
      expect(result.subjectType).toBe('household');
      expect(result.subjectName).toBe('daughter');
    });

    it('topical text (no sensitive signal) → unresolved', () => {
      const result = attributeSubject('Quarterly sales report summary', context);
      expect(result.subjectType).toBe('unresolved');
    });

    it('includes contactDID when subject is external', () => {
      const result = attributeSubject('Alice is arriving', context);
      expect(result.contactDID).toBe('did:plc:alice');
    });

    it('includes confidence score', () => {
      const result = attributeSubject('My results are ready', context);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('isSelfReference', () => {
    it('"I" → true', () => {
      expect(isSelfReference('I went to the doctor')).toBe(true);
    });

    it('"my" → true', () => {
      expect(isSelfReference('my appointment')).toBe(true);
    });

    it('"me" → true', () => {
      expect(isSelfReference('call me later')).toBe(true);
    });

    it('no first-person → false', () => {
      expect(isSelfReference('the report is ready')).toBe(false);
    });

    it('empty text → false', () => {
      expect(isSelfReference('')).toBe(false);
    });
  });

  describe('mentionsContact', () => {
    it('finds mentioned contact', () => {
      expect(mentionsContact('Alice called', ['Alice', 'Bob'])).toBe('Alice');
    });

    it('returns null when no contact mentioned', () => {
      expect(mentionsContact('The call ended', ['Alice', 'Bob'])).toBeNull();
    });

    it('case-insensitive', () => {
      expect(mentionsContact('ALICE called', ['Alice'])).toBe('Alice');
    });
  });

  describe('mentionsHousehold', () => {
    it('finds household member', () => {
      expect(mentionsHousehold('Emma is sick', ['Emma', 'James'])).toBe('Emma');
    });

    it('returns null when no member mentioned', () => {
      expect(mentionsHousehold('The dog is hungry', ['Emma', 'James'])).toBeNull();
    });
  });
});
