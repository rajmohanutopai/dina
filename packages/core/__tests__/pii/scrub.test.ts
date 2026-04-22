/**
 * T1E.2 — PII scrub/rehydrate integration and entity vault pattern.
 *
 * Category A: fixture-based. Verifies full scrub→rehydrate round-trip
 * and the scrub→process→rehydrate cycle for cloud LLM calls.
 *
 * Source: core/test/pii_handler_test.go, brain/tests/test_pii.py
 */

import { scrubTier1, rehydrate, scrubProcessRehydrate } from '../../src/pii/scrub';
import { PII_TEST_CASES } from '@dina/test-harness';

describe('PII Scrub/Rehydrate Integration', () => {
  describe('scrubTier1', () => {
    for (const tc of PII_TEST_CASES) {
      it(`scrubs correctly: ${tc.name}`, () => {
        const result = scrubTier1(tc.input);
        expect(result.scrubbed).toBe(tc.expected);
        expect(result.entities.map((e) => e.value)).toEqual(tc.entities);
      });
    }

    it('returns empty entities for clean text', () => {
      const result = scrubTier1('No PII in this text');
      expect(result.entities).toEqual([]);
      expect(result.scrubbed).toBe('No PII in this text');
    });

    it('entities contain token field for rehydration', () => {
      const result = scrubTier1('Email john@example.com');
      expect(result.entities.length).toBe(1);
      expect(result.entities[0].token).toBe('[EMAIL_1]');
      expect(result.entities[0].value).toBe('john@example.com');
      expect(result.entities[0].type).toBe('EMAIL');
    });
  });

  describe('rehydrate', () => {
    it('restores single token', () => {
      const result = rehydrate('Contact [EMAIL_1]', [
        { token: '[EMAIL_1]', value: 'john@example.com' },
      ]);
      expect(result).toBe('Contact john@example.com');
    });

    it('restores multiple tokens of same type', () => {
      const result = rehydrate('From [EMAIL_1] to [EMAIL_2]', [
        { token: '[EMAIL_1]', value: 'alice@example.com' },
        { token: '[EMAIL_2]', value: 'bob@example.com' },
      ]);
      expect(result).toBe('From alice@example.com to bob@example.com');
    });

    it('restores mixed types', () => {
      const result = rehydrate('Contact [EMAIL_1] or call [PHONE_1]', [
        { token: '[EMAIL_1]', value: 'alice@example.com' },
        { token: '[PHONE_1]', value: '555-123-4567' },
      ]);
      expect(result).toBe('Contact alice@example.com or call 555-123-4567');
    });

    it('returns text unchanged when entities is empty', () => {
      expect(rehydrate('Clean text', [])).toBe('Clean text');
    });

    it('handles tokens not found in text (no-op)', () => {
      const result = rehydrate('No tokens here', [
        { token: '[EMAIL_1]', value: 'ghost@example.com' },
      ]);
      expect(result).toBe('No tokens here');
    });
  });

  describe('round-trip: scrubTier1 → rehydrate', () => {
    for (const tc of PII_TEST_CASES.filter((tc) => tc.entities.length > 0)) {
      it(`round-trips: ${tc.name}`, () => {
        const { scrubbed, entities } = scrubTier1(tc.input);
        const recovered = rehydrate(scrubbed, entities);
        expect(recovered).toBe(tc.input);
      });
    }
  });

  describe('scrubProcessRehydrate (entity vault pattern)', () => {
    it('scrubs → calls processor → rehydrates result', async () => {
      const processor = async (scrubbed: string) => `Processed: ${scrubbed}`;
      const result = await scrubProcessRehydrate('Email john@example.com', processor);
      expect(result).toBe('Processed: Email john@example.com');
    });

    it('processor receives scrubbed text (no PII)', async () => {
      let received = '';
      const processor = async (scrubbed: string) => {
        received = scrubbed;
        return scrubbed;
      };
      await scrubProcessRehydrate('Email john@example.com', processor);
      expect(received).toBe('Email [EMAIL_1]');
      expect(received).not.toContain('john@example.com');
    });

    it('result has PII restored', async () => {
      const processor = async (scrubbed: string) => `Reply to ${scrubbed}`;
      const result = await scrubProcessRehydrate('Email john@example.com', processor);
      expect(result).toContain('john@example.com');
      expect(result).not.toContain('[EMAIL_1]');
    });

    it('handles text with no PII (pass-through)', async () => {
      const processor = async (s: string) => `Got: ${s}`;
      const result = await scrubProcessRehydrate('No PII here', processor);
      expect(result).toBe('Got: No PII here');
    });
  });
});
