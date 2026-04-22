/**
 * T1E.1 — Tier 1 PII regex patterns: detect, scrub, rehydrate.
 *
 * Category A: fixture-based. Verifies same inputs produce same outputs
 * as Go pii/scrubber.go. Tests cover each PII type and edge cases.
 *
 * Source: core/test/pii_test.go, pii_handler_test.go
 */

import { detectPII, scrubPII, rehydratePII } from '../../src/pii/patterns';
import { PII_TEST_CASES } from '@dina/test-harness';

describe('PII Tier 1 Regex Patterns', () => {
  describe('detectPII', () => {
    it('returns empty array for text with no PII', () => {
      const matches = detectPII('The weather is nice today');
      expect(matches).toEqual([]);
    });

    it('detects email address', () => {
      const matches = detectPII('Email me at john@example.com');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('EMAIL');
      expect(matches[0].value).toBe('john@example.com');
    });

    it('detects US phone number', () => {
      const matches = detectPII('Call 555-123-4567');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('PHONE');
      expect(matches[0].value).toBe('555-123-4567');
    });

    it('detects SSN', () => {
      const matches = detectPII('SSN 123-45-6789');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('SSN');
      expect(matches[0].value).toBe('123-45-6789');
    });

    it('detects credit card with Luhn validation', () => {
      const matches = detectPII('Card 4111-1111-1111-1111');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('CREDIT_CARD');
    });

    it('rejects credit card that fails Luhn', () => {
      const matches = detectPII('Not a card: 1234-5678-9012-3456');
      const ccMatches = matches.filter((m) => m.type === 'CREDIT_CARD');
      expect(ccMatches.length).toBe(0);
    });

    it('detects Aadhaar number (12-digit Indian ID)', () => {
      const matches = detectPII('Aadhaar: 2345 6789 0123');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('AADHAAR');
    });

    it('rejects Aadhaar starting with 0 or 1', () => {
      const matches = detectPII('Bad: 0123 4567 8901');
      const aadhaarMatches = matches.filter((m) => m.type === 'AADHAAR');
      expect(aadhaarMatches.length).toBe(0);
    });

    it('detects Indian PAN (AAAAA0000A format)', () => {
      const matches = detectPII('PAN: ABCDE1234F');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('PAN');
      expect(matches[0].value).toBe('ABCDE1234F');
    });

    it('detects IFSC code', () => {
      const matches = detectPII('IFSC: SBIN0001234');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('IFSC');
    });

    it('detects IP address with octet validation (0-255)', () => {
      const matches = detectPII('Server at 192.168.1.100');
      expect(matches.length).toBe(1);
      expect(matches[0].type).toBe('IP');
      expect(matches[0].value).toBe('192.168.1.100');
    });

    it('rejects invalid IP (octet > 255)', () => {
      const matches = detectPII('Address 999.999.999.999');
      const ipMatches = matches.filter((m) => m.type === 'IP');
      expect(ipMatches.length).toBe(0);
    });

    it('detects multiple PII types in one text', () => {
      const matches = detectPII('Contact john@example.com or call 555-123-4567');
      expect(matches.length).toBe(2);
      const types = matches.map((m) => m.type).sort();
      expect(types).toEqual(['EMAIL', 'PHONE']);
    });

    it('returns correct start/end positions', () => {
      const text = 'Email me at john@example.com please';
      const matches = detectPII(text);
      expect(matches[0].start).toBe(12);
      expect(matches[0].end).toBe(28);
      expect(text.slice(matches[0].start, matches[0].end)).toBe('john@example.com');
    });
  });

  describe('scrubPII', () => {
    // Data-driven tests from harness PII_TEST_CASES
    for (const tc of PII_TEST_CASES) {
      it(`scrubs: ${tc.name}`, () => {
        const result = scrubPII(tc.input);
        expect(result.scrubbed).toBe(tc.expected);
        expect(result.entities.map((e) => e.value)).toEqual(tc.entities);
      });
    }

    it('assigns sequential tokens per type: [EMAIL_1], [EMAIL_2]', () => {
      const result = scrubPII('From john@a.com to jane@b.com');
      expect(result.scrubbed).toBe('From [EMAIL_1] to [EMAIL_2]');
    });

    it('numbers different types independently: [EMAIL_1], [PHONE_1]', () => {
      const result = scrubPII('Email john@a.com, call 555-123-4567');
      expect(result.scrubbed).toContain('[EMAIL_1]');
      expect(result.scrubbed).toContain('[PHONE_1]');
    });

    it('preserves non-PII text exactly', () => {
      const result = scrubPII('No PII here, just regular text');
      expect(result.scrubbed).toBe('No PII here, just regular text');
      expect(result.entities).toEqual([]);
    });

    it('handles empty string', () => {
      const result = scrubPII('');
      expect(result.scrubbed).toBe('');
      expect(result.entities).toEqual([]);
    });
  });

  describe('rehydratePII', () => {
    it('restores original PII from tokens', () => {
      const result = rehydratePII('Email me at [EMAIL_1]', [
        { token: '[EMAIL_1]', value: 'john@example.com' },
      ]);
      expect(result).toBe('Email me at john@example.com');
    });

    it('restores multiple tokens', () => {
      const result = rehydratePII('Contact [EMAIL_1] or [PHONE_1]', [
        { token: '[EMAIL_1]', value: 'john@example.com' },
        { token: '[PHONE_1]', value: '555-123-4567' },
      ]);
      expect(result).toBe('Contact john@example.com or 555-123-4567');
    });

    it('returns scrubbed text unchanged when no entities', () => {
      expect(rehydratePII('No tokens here', [])).toBe('No tokens here');
    });
  });

  describe('round-trip: scrub → rehydrate', () => {
    it('recovers original text', () => {
      const original = 'Email john@example.com, call 555-123-4567, SSN 123-45-6789';
      const { scrubbed, entities } = scrubPII(original);
      const recovered = rehydratePII(scrubbed, entities);
      expect(recovered).toBe(original);
    });

    it('round-trips every PII_TEST_CASE', () => {
      for (const tc of PII_TEST_CASES) {
        const { scrubbed, entities } = scrubPII(tc.input);
        const recovered = rehydratePII(scrubbed, entities);
        expect(recovered).toBe(tc.input);
      }
    });
  });
});
