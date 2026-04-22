/**
 * PII scrubbing tests — rehydration bug fix + chat integration.
 *
 * Tests:
 * 1. rehydratePII replaces ALL occurrences (not just first)
 * 2. rehydratePII handles longest-first ordering (prevents partial matches)
 * 3. scrubPII correctly detects structured PII types
 * 4. Full scrub→process→rehydrate cycle
 */

import { scrubPII, rehydratePII, detectPII } from '../../../core/src/pii/patterns';

describe('PII Scrubbing', () => {
  describe('rehydratePII — replaces ALL occurrences (bug fix)', () => {
    it('replaces a token that appears twice', () => {
      const scrubbed = 'Contact [EMAIL_1] or forward to [EMAIL_1]';
      const entities = [{ token: '[EMAIL_1]', value: 'alice@example.com' }];

      const result = rehydratePII(scrubbed, entities);

      expect(result).toBe('Contact alice@example.com or forward to alice@example.com');
    });

    it('replaces a token that appears three times', () => {
      const scrubbed = 'Call [PHONE_1], or text [PHONE_1], or fax [PHONE_1]';
      const entities = [{ token: '[PHONE_1]', value: '555-123-4567' }];

      const result = rehydratePII(scrubbed, entities);

      expect(result).toBe('Call 555-123-4567, or text 555-123-4567, or fax 555-123-4567');
    });

    it('replaces multiple different tokens with multiple occurrences', () => {
      const scrubbed = '[EMAIL_1] sent to [EMAIL_2]. CC: [EMAIL_1]';
      const entities = [
        { token: '[EMAIL_1]', value: 'alice@test.com' },
        { token: '[EMAIL_2]', value: 'bob@test.com' },
      ];

      const result = rehydratePII(scrubbed, entities);

      expect(result).toBe('alice@test.com sent to bob@test.com. CC: alice@test.com');
    });
  });

  describe('rehydratePII — longest-first ordering (prevents partial matches)', () => {
    it('replaces [EMAIL_10] before [EMAIL_1]', () => {
      const scrubbed = 'Primary: [EMAIL_1], Secondary: [EMAIL_10]';
      const entities = [
        { token: '[EMAIL_1]', value: 'first@test.com' },
        { token: '[EMAIL_10]', value: 'tenth@test.com' },
      ];

      const result = rehydratePII(scrubbed, entities);

      expect(result).toBe('Primary: first@test.com, Secondary: tenth@test.com');
      // Without longest-first ordering, [EMAIL_1] would match inside [EMAIL_10]
      expect(result).not.toContain('[EMAIL_');
    });
  });

  describe('scrubPII — detects structured PII', () => {
    it('scrubs email addresses', () => {
      const result = scrubPII('Contact alice@example.com for details');
      expect(result.scrubbed).toContain('[EMAIL_1]');
      expect(result.scrubbed).not.toContain('alice@example.com');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type).toBe('EMAIL');
    });

    it('scrubs US phone numbers', () => {
      const result = scrubPII('Call me at 555-123-4567');
      expect(result.scrubbed).toContain('[PHONE_1]');
      expect(result.entities).toHaveLength(1);
    });

    it('scrubs SSNs', () => {
      const result = scrubPII('My SSN is 123-45-6789');
      expect(result.scrubbed).toContain('[SSN_1]');
      expect(result.scrubbed).not.toContain('123-45-6789');
    });

    it('scrubs multiple PII types in one text', () => {
      const result = scrubPII('Email alice@test.com, SSN 123-45-6789');
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      expect(result.scrubbed).not.toContain('alice@test.com');
      expect(result.scrubbed).not.toContain('123-45-6789');
    });

    it('does NOT scrub names or locations (by design)', () => {
      const result = scrubPII('Dr. Sharma lives in Mumbai');
      // Names and locations are NOT scrubbed — matching main Dina design
      expect(result.scrubbed).toContain('Dr. Sharma');
      expect(result.scrubbed).toContain('Mumbai');
      expect(result.entities).toHaveLength(0);
    });

    it('preserves text with no PII', () => {
      const result = scrubPII("Emma's birthday is March 15");
      expect(result.scrubbed).toBe("Emma's birthday is March 15");
      expect(result.entities).toHaveLength(0);
    });

    it('scrubs bank account numbers (16 consecutive digits)', () => {
      const result = scrubPII('Account 1234567890123456 at SBI');
      expect(result.scrubbed).toContain('[BANK_ACCT_1]');
      expect(result.scrubbed).not.toContain('1234567890123456');
    });

    it('scrubs US street addresses', () => {
      const result = scrubPII('Lives at 123 Oak Street in town');
      expect(result.scrubbed).toContain('[ADDRESS_1]');
      expect(result.scrubbed).not.toContain('123 Oak Street');
    });

    it('scrubs international phone numbers', () => {
      const result = scrubPII('Call +44 20 7946 0958 for London office');
      expect(result.scrubbed).toContain('[PHONE_1]');
      expect(result.scrubbed).not.toContain('+44 20 7946 0958');
    });

    it('scrubs Indian phone numbers (bare 10-digit)', () => {
      const result = scrubPII('Mobile: 98765 43210');
      expect(result.scrubbed).toContain('[PHONE_');
      expect(result.scrubbed).not.toContain('98765 43210');
    });

    it('scrubs Aadhaar with dash separators', () => {
      const result = scrubPII('Aadhaar: 2345-6789-0123');
      expect(result.scrubbed).toContain('[AADHAAR_1]');
      expect(result.scrubbed).not.toContain('2345-6789-0123');
    });
  });

  describe('Full scrub → rehydrate roundtrip', () => {
    it('roundtrips text with email', () => {
      const original = 'Send report to alice@example.com by Friday';
      const { scrubbed, entities } = scrubPII(original);

      expect(scrubbed).not.toContain('alice@example.com');
      expect(scrubbed).toContain('[EMAIL_1]');

      const restored = rehydratePII(scrubbed, entities);
      expect(restored).toBe(original);
    });

    it('roundtrips text with multiple PII types', () => {
      const original = 'Email bob@test.com, SSN 234-56-7890';
      const { scrubbed, entities } = scrubPII(original);

      expect(scrubbed).not.toContain('bob@test.com');
      expect(scrubbed).not.toContain('234-56-7890');

      const restored = rehydratePII(scrubbed, entities);
      expect(restored).toBe(original);
    });

    it('roundtrips text with repeated PII in simulated LLM response', () => {
      const original = 'Contact alice@example.com for help';
      const { scrubbed, entities } = scrubPII(original);

      // Simulate LLM repeating the token in its response
      const llmResponse = `You should email [EMAIL_1]. The address [EMAIL_1] is correct.`;
      const restored = rehydratePII(llmResponse, entities);

      expect(restored).toBe(
        'You should email alice@example.com. The address alice@example.com is correct.',
      );
    });
  });
});
