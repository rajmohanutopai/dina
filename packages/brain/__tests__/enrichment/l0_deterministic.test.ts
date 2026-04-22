/**
 * T1J.5 — L0 deterministic summary generation (no LLM fallback).
 *
 * Category A: fixture-based. Verifies L0 is generated from metadata
 * alone when LLM is unavailable.
 *
 * Pattern: "{Type} from {sender} on {date}"
 * Self-authored: "{Type} on {date}" (sender excluded, matching Python)
 * Caveats appended for low-trust or marketing content.
 *
 * Source: brain/tests/test_enrichment.py
 */

import {
  generateL0,
  generateL0WithMeta,
  addTrustCaveat,
  formatTimestamp,
  buildEnrichmentVersion,
} from '../../src/enrichment/l0_deterministic';
import type { L0Input } from '../../src/enrichment/l0_deterministic';

describe('L0 Deterministic Generation', () => {
  describe('generateL0', () => {
    it('generates from full metadata', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000, // 2023-11-14
      };
      const l0 = generateL0(input);
      expect(l0).toBe('Email from alice@example.com on 2023-11-14');
    });

    it('uses summary when available (instead of constructing from metadata)', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
        summary: 'Meeting reminder for Thursday',
      };
      expect(generateL0(input)).toBe('Meeting reminder for Thursday');
    });

    it('excludes sender when sender is "user" (self-authored)', () => {
      const input: L0Input = {
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
      };
      expect(generateL0(input)).toBe('Note on 2023-11-14');
    });

    it('excludes sender when sender is "self"', () => {
      const input: L0Input = {
        type: 'note',
        source: 'personal',
        sender: 'self',
        timestamp: 1700000000,
      };
      expect(generateL0(input)).toBe('Note on 2023-11-14');
    });

    it('excludes sender when sender is "me"', () => {
      const input: L0Input = {
        type: 'note',
        source: 'personal',
        sender: 'Me',
        timestamp: 1700000000,
      };
      expect(generateL0(input)).toBe('Note on 2023-11-14');
    });

    it('handles empty sender gracefully (excluded like self)', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: '',
        timestamp: 1700000000,
      };
      expect(generateL0(input)).toBe('Email on 2023-11-14');
    });

    it('handles zero timestamp', () => {
      const input: L0Input = {
        type: 'note',
        source: 'personal',
        sender: 'alice@example.com',
        timestamp: 0,
      };
      expect(generateL0(input)).toBe('Note from alice@example.com on unknown date');
    });

    it('capitalizes type', () => {
      const input: L0Input = {
        type: 'sms',
        source: 'phone',
        sender: 'Bob',
        timestamp: 1700000000,
      };
      expect(generateL0(input)).toMatch(/^Sms from/);
    });

    it('includes trust caveat for low-trust sender', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'stranger@unknown.com',
        timestamp: 1700000000,
        sender_trust: 'unknown',
      };
      const l0 = generateL0(input);
      expect(l0).toContain('unverified sender');
    });

    it('includes trust caveat for marketing sender', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'promo@newsletter.com',
        timestamp: 1700000000,
        sender_trust: 'marketing',
      };
      const l0 = generateL0(input);
      expect(l0).toContain('promotional');
    });

    it('no caveat for high-trust sender (self)', () => {
      const input: L0Input = {
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        sender_trust: 'self',
      };
      const l0 = generateL0(input);
      expect(l0).not.toContain('unverified');
      expect(l0).not.toContain('promotional');
    });

    it('no caveat for contact_ring1 trust', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
        sender_trust: 'contact_ring1',
      };
      const l0 = generateL0(input);
      expect(l0).not.toContain('unverified');
    });

    it('returns empty string for completely empty input', () => {
      const input: L0Input = { type: '', source: '', sender: '', timestamp: 0 };
      expect(generateL0(input)).toBe('');
    });

    it('summary with trust caveat appends caveat to summary', () => {
      const input: L0Input = {
        type: 'email',
        source: 'gmail',
        sender: 'stranger@x.com',
        timestamp: 1700000000,
        summary: 'Special offer inside',
        sender_trust: 'marketing',
      };
      const l0 = generateL0(input);
      expect(l0).toBe('Special offer inside (promotional)');
    });
  });

  describe('generateL0WithMeta', () => {
    it('returns text, confidence, and enrichment_version', () => {
      const result = generateL0WithMeta({
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
      });

      expect(result.text).toBe('Email from alice@example.com on 2023-11-14');
      expect(result.confidence).toBe('medium');
      expect(result.enrichment_version.prompt_v).toBe('deterministic-v1');
      expect(result.enrichment_version.embed_model).toBeNull();
      expect(result.enrichment_version.timestamp).toBeGreaterThan(0);
    });

    it('confidence is high when summary provided', () => {
      const result = generateL0WithMeta({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        summary: 'My custom title',
      });
      expect(result.confidence).toBe('high');
    });

    it('confidence is high for self sender_trust', () => {
      const result = generateL0WithMeta({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        sender_trust: 'self',
      });
      expect(result.confidence).toBe('high');
    });

    it('confidence is medium for contact_ring1', () => {
      const result = generateL0WithMeta({
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
        sender_trust: 'contact_ring1',
      });
      expect(result.confidence).toBe('medium');
    });

    it('confidence is low for unknown sender_trust', () => {
      const result = generateL0WithMeta({
        type: 'email',
        source: 'gmail',
        sender: 'stranger@x.com',
        timestamp: 1700000000,
        sender_trust: 'unknown',
      });
      expect(result.confidence).toBe('low');
    });

    it('confidence is low for marketing sender_trust', () => {
      const result = generateL0WithMeta({
        type: 'email',
        source: 'gmail',
        sender: 'promo@news.com',
        timestamp: 1700000000,
        sender_trust: 'marketing',
      });
      expect(result.confidence).toBe('low');
    });

    it('explicit confidence field overrides derivation', () => {
      const result = generateL0WithMeta({
        type: 'email',
        source: 'gmail',
        sender: 'user',
        timestamp: 1700000000,
        sender_trust: 'self',
        confidence: 'low', // explicit override
      });
      expect(result.confidence).toBe('low');
    });
  });

  describe('buildEnrichmentVersion', () => {
    it('returns structured version with prompt_v and timestamp', () => {
      const version = buildEnrichmentVersion();
      expect(version.prompt_v).toBe('deterministic-v1');
      expect(version.embed_model).toBeNull();
      expect(typeof version.timestamp).toBe('number');
      expect(version.timestamp).toBeGreaterThan(0);
    });
  });

  describe('addTrustCaveat', () => {
    it('appends caveat for unknown trust', () => {
      expect(addTrustCaveat('Email from stranger', 'unknown')).toBe(
        'Email from stranger (unverified sender)',
      );
    });

    it('appends caveat for marketing trust', () => {
      expect(addTrustCaveat('Newsletter update', 'marketing')).toBe(
        'Newsletter update (promotional)',
      );
    });

    it('appends caveat for spam trust', () => {
      expect(addTrustCaveat('Free money!', 'spam')).toBe('Free money! (likely spam)');
    });

    it('no caveat for self trust', () => {
      expect(addTrustCaveat('My note', 'self')).toBe('My note');
    });

    it('no caveat for contact_ring1', () => {
      expect(addTrustCaveat('Email from Alice', 'contact_ring1')).toBe('Email from Alice');
    });

    it('no caveat for verified', () => {
      expect(addTrustCaveat('Bank statement', 'verified')).toBe('Bank statement');
    });
  });

  describe('formatTimestamp', () => {
    it('formats Unix timestamp to YYYY-MM-DD', () => {
      expect(formatTimestamp(1700000000)).toBe('2023-11-14');
    });

    it('handles zero timestamp', () => {
      expect(formatTimestamp(0)).toBe('unknown date');
    });

    it('handles early date', () => {
      expect(formatTimestamp(946684800)).toBe('2000-01-01');
    });

    it('handles negative timestamp', () => {
      expect(formatTimestamp(-1)).toBe('unknown date');
    });
  });
});
