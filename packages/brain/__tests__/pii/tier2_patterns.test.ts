/**
 * T1J.2 — Tier 2 PII pattern recognizers (Presidio port).
 *
 * Source: brain/tests/test_pii.py
 */

import {
  detectTier2,
  isSafeEntity,
  getSafeEntityTypes,
  detectIndianPII,
  detectEUPII,
  applySyntheticReplacement,
} from '../../src/pii/tier2_patterns';

describe('Tier 2 PII Pattern Recognizers', () => {
  describe('detectTier2', () => {
    it('detects email address', () => {
      const matches = detectTier2('Contact john@example.com');
      expect(matches.some((m) => m.entity_type === 'EMAIL_ADDRESS')).toBe(true);
    });

    it('detects phone number', () => {
      const matches = detectTier2('Call 555-123-4567');
      expect(matches.some((m) => m.entity_type === 'PHONE_NUMBER')).toBe(true);
    });

    it('detects credit card (Luhn valid)', () => {
      const matches = detectTier2('Card 4111111111111111');
      expect(matches.some((m) => m.entity_type === 'CREDIT_CARD')).toBe(true);
    });

    it('detects US SSN', () => {
      const matches = detectTier2('SSN 123-45-6789');
      expect(matches.some((m) => m.entity_type === 'US_SSN')).toBe(true);
    });

    it('detects IP address', () => {
      const matches = detectTier2('Server 192.168.1.1');
      expect(matches.some((m) => m.entity_type === 'IP_ADDRESS')).toBe(true);
    });

    it('returns empty for clean text', () => {
      expect(detectTier2('No PII here')).toEqual([]);
    });

    it('detects multiple entities in one text', () => {
      const matches = detectTier2('Email john@example.com, SSN 123-45-6789');
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('includes confidence score per match', () => {
      const matches = detectTier2('SSN 123-45-6789');
      expect(matches[0].score).toBeGreaterThan(0);
      expect(matches[0].score).toBeLessThanOrEqual(1);
    });

    it('"India" passes through (not PII)', () => {
      const matches = detectTier2('Traveled to India');
      expect(matches).toEqual([]);
    });

    it('"USA" passes through (not PII)', () => {
      const matches = detectTier2('Lives in USA');
      expect(matches).toEqual([]);
    });
  });

  describe('safe entities', () => {
    const safeTypes = [
      'DATE',
      'TIME',
      'MONEY',
      'PERCENT',
      'QUANTITY',
      'ORDINAL',
      'CARDINAL',
      'NORP',
    ];
    for (const type of safeTypes) {
      it(`"${type}" is safe`, () => {
        expect(isSafeEntity(type)).toBe(true);
      });
    }

    it('EMAIL_ADDRESS is NOT safe', () => {
      expect(isSafeEntity('EMAIL_ADDRESS')).toBe(false);
    });

    it('PHONE_NUMBER is NOT safe', () => {
      expect(isSafeEntity('PHONE_NUMBER')).toBe(false);
    });

    it('getSafeEntityTypes returns all 8 safe types', () => {
      expect(getSafeEntityTypes().length).toBe(8);
    });
  });

  describe('detectIndianPII', () => {
    it('detects Aadhaar number', () => {
      const matches = detectIndianPII('Aadhaar: 2345 6789 0123');
      expect(matches.some((m) => m.entity_type === 'AADHAAR_NUMBER')).toBe(true);
    });

    it('detects PAN', () => {
      const matches = detectIndianPII('PAN: ABCDE1234F');
      expect(matches.some((m) => m.entity_type === 'IN_PAN')).toBe(true);
    });

    it('detects IFSC code', () => {
      const matches = detectIndianPII('IFSC: SBIN0001234');
      expect(matches.some((m) => m.entity_type === 'IN_IFSC')).toBe(true);
    });

    it('detects UPI ID', () => {
      const matches = detectIndianPII('Pay via name@upi');
      expect(matches.some((m) => m.entity_type === 'IN_UPI_ID')).toBe(true);
    });

    it('detects Indian phone with country code', () => {
      const matches = detectIndianPII('Call +91 98765 43210');
      expect(matches.some((m) => m.entity_type === 'PHONE_NUMBER')).toBe(true);
    });
  });

  describe('detectEUPII', () => {
    it('detects German Steuer-ID', () => {
      const matches = detectEUPII('Steuer-ID: 12345678901');
      expect(matches.some((m) => m.entity_type === 'DE_STEUER_ID')).toBe(true);
    });

    it('detects French NIR', () => {
      const matches = detectEUPII('NIR: 1 85 01 75 123 456 78');
      expect(matches.some((m) => m.entity_type === 'FR_NIR')).toBe(true);
    });
  });

  describe('applySyntheticReplacement', () => {
    it('replaces PII with synthetic data', () => {
      const matches = [
        { entity_type: 'PERSON', start: 0, end: 10, score: 0.9, value: 'John Smith' },
      ];
      const result = applySyntheticReplacement('John Smith went home', matches);
      expect(result.replaced).not.toContain('John Smith');
      expect(result.mappings.length).toBe(1);
      expect(result.mappings[0].original).toBe('John Smith');
    });

    it('returns mapping of original → synthetic', () => {
      const matches = [
        { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95, value: 'john@example.com' },
      ];
      const result = applySyntheticReplacement('john@example.com', matches);
      expect(result.mappings[0].original).toBe('john@example.com');
      expect(result.mappings[0].synthetic).toBeTruthy();
    });

    it('handles multiple replacements', () => {
      const matches = [
        { entity_type: 'PERSON', start: 0, end: 5, score: 0.9, value: 'Alice' },
        { entity_type: 'PERSON', start: 10, end: 13, score: 0.9, value: 'Bob' },
      ];
      const result = applySyntheticReplacement('Alice met Bob today', matches);
      expect(result.replaced).not.toContain('Alice');
      expect(result.replaced).not.toContain('Bob');
      expect(result.mappings.length).toBe(2);
    });
  });

  describe('DE_STEUER_ID first-digit fix (§A76)', () => {
    it('detects valid Steuer-ID (first digit 1-9)', () => {
      // Use a number unlikely to match phone patterns (no valid phone prefix)
      const matches = detectTier2('Steuer-ID: 56789012345');
      expect(matches.some((m) => m.entity_type === 'DE_STEUER_ID')).toBe(true);
    });

    it('rejects Steuer-ID with leading zero', () => {
      const matches = detectTier2('Number: 02345678901');
      expect(matches.every((m) => m.entity_type !== 'DE_STEUER_ID')).toBe(true);
    });

    it('regex requires exactly 11 digits', () => {
      // 10 digits — too short
      const short = detectTier2('Num: 5678901234');
      expect(short.every((m) => m.entity_type !== 'DE_STEUER_ID')).toBe(true);
    });
  });

  describe('SWIFT_BIC detection (§A76)', () => {
    it('detects 11-char SWIFT/BIC code', () => {
      const matches = detectTier2('SWIFT: DEUTDEFF500');
      expect(matches.some((m) => m.entity_type === 'SWIFT_BIC')).toBe(true);
    });

    it('detects 8-char SWIFT/BIC with digit', () => {
      const matches = detectTier2('BIC: DEUTDE2H');
      expect(matches.some((m) => m.entity_type === 'SWIFT_BIC')).toBe(true);
    });

    it('rejects 8-char all-alpha (false positive guard)', () => {
      // 8 pure letters could be a common English word — require at least one digit
      const matches = detectTier2('Word: ABCDEFGH');
      expect(matches.every((m) => m.entity_type !== 'SWIFT_BIC')).toBe(true);
    });
  });

  describe('IN_PASSPORT detection (§A76)', () => {
    it('detects Indian passport number', () => {
      const matches = detectTier2('Passport: A1234567');
      expect(matches.some((m) => m.entity_type === 'IN_PASSPORT')).toBe(true);
    });

    it('has low base score (many false positives)', () => {
      const matches = detectTier2('Code: B9876543');
      const passport = matches.find((m) => m.entity_type === 'IN_PASSPORT');
      if (passport) {
        expect(passport.score).toBeLessThanOrEqual(0.3);
      }
    });
  });
});
