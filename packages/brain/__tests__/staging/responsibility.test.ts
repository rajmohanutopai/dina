/**
 * T2B.19 — Staging responsibility override for sensitive personas.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_staging_responsibility.py
 */

import { overrideStagingResponsibility } from '../../src/contact/alias';

describe('Staging Responsibility Override', () => {
  describe('applies responsibility override', () => {
    it('sets attributed_contact from alias match', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'general', summary: 'Message from Ali' },
        { contactName: 'Alice', matchedAlias: 'Ali', matchType: 'alias' },
      );
      expect(result.attributed_contact).toBe('Alice');
    });

    it('sets attributed_match_type', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'general' },
        { contactName: 'Alice', matchedAlias: 'Ali', matchType: 'alias' },
      );
      expect(result.attributed_match_type).toBe('alias');
    });

    it('sets attributed_alias', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'general' },
        { contactName: 'Alice', matchedAlias: 'Ali', matchType: 'alias' },
      );
      expect(result.attributed_alias).toBe('Ali');
    });

    it('preserves original item fields', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'health', summary: 'Lab results', contact_did: 'did:plc:existing' },
        { contactName: 'Dr. Shah', matchedAlias: 'Shah', matchType: 'alias' },
      );
      expect(result.target_persona).toBe('health');
      expect(result.summary).toBe('Lab results');
      expect(result.contact_did).toBe('did:plc:existing');
    });

    it('name match applies same override as alias', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'general' },
        { contactName: 'Alice', matchedAlias: 'Alice', matchType: 'name' },
      );
      expect(result.attributed_contact).toBe('Alice');
      expect(result.attributed_match_type).toBe('name');
    });

    it('kinship match applies override', () => {
      const result = overrideStagingResponsibility(
        { target_persona: 'general' },
        { contactName: 'Alice', matchedAlias: 'my friend', matchType: 'kinship' as any },
      );
      expect(result.attributed_contact).toBe('Alice');
    });
  });
});
