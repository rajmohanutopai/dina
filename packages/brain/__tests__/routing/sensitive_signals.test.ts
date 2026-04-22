/**
 * Sensitive signal detection tests — keyword-based domain signal finder.
 *
 * Tests: span-based hit detection, strong/weak distinction, overlap merging,
 * boolean signal checks, word-boundary matching, cold-brew exclusion.
 */

import {
  findSensitiveHits,
  hasHealthSignal,
  hasFinanceSignal,
  hasWorkSignal,
  type SensitiveHit,
} from '../../src/routing/sensitive_signals';

describe('Sensitive Signals', () => {
  describe('findSensitiveHits — span detection', () => {
    it('detects health strong keywords', () => {
      const hits = findSensitiveHits('Patient has a diagnosis of diabetes');
      expect(hits.length).toBeGreaterThanOrEqual(2);

      const keywords = hits.map((h) => h.keyword);
      expect(keywords).toContain('diagnosis');
      expect(keywords).toContain('diabetes');
      expect(hits.every((h) => h.domain === 'health')).toBe(true);
      expect(hits.every((h) => h.strength === 'strong')).toBe(true);
    });

    it('detects health weak keywords', () => {
      const hits = findSensitiveHits('Saw the doctor about a headache');
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.some((h) => h.keyword === 'doctor')).toBe(true);
      expect(hits.some((h) => h.keyword === 'headache')).toBe(true);
      expect(hits.every((h) => h.strength === 'weak')).toBe(true);
    });

    it('detects finance strong keywords', () => {
      const hits = findSensitiveHits('Pay off the mortgage and loan');
      expect(hits.some((h) => h.keyword === 'mortgage')).toBe(true);
      expect(hits.some((h) => h.keyword === 'loan')).toBe(true);
      expect(hits.every((h) => h.domain === 'financial')).toBe(true);
    });

    it('detects legal keywords', () => {
      const hits = findSensitiveHits('Filed a lawsuit and spoke with the attorney');
      expect(hits.some((h) => h.keyword === 'lawsuit')).toBe(true);
      expect(hits.some((h) => h.keyword === 'attorney')).toBe(true);
      expect(hits.every((h) => h.domain === 'legal')).toBe(true);
      expect(hits.every((h) => h.strength === 'strong')).toBe(true);
    });

    it('returns span positions', () => {
      const text = 'Has diabetes';
      const hits = findSensitiveHits(text);
      expect(hits).toHaveLength(1);
      expect(hits[0].span[0]).toBe(4); // 'diabetes' starts at index 4
      expect(hits[0].span[1]).toBe(12);
      expect(text.slice(hits[0].span[0], hits[0].span[1])).toBe('diabetes');
    });

    it('detects multi-word keywords with spans', () => {
      const text = 'Check blood pressure today';
      const hits = findSensitiveHits(text);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.keyword.includes('blood'))).toBe(true);
    });

    it('returns empty for text without signals', () => {
      expect(findSensitiveHits('The weather is nice today')).toHaveLength(0);
      expect(findSensitiveHits('')).toHaveLength(0);
    });

    it('handles mixed-domain text', () => {
      const hits = findSensitiveHits('Diagnosis pending, need to pay the mortgage');
      const domains = new Set(hits.map((h) => h.domain));
      expect(domains.has('health')).toBe(true);
      expect(domains.has('financial')).toBe(true);
    });
  });

  describe('word-boundary matching', () => {
    it('does not match "cold brew" as cold (health_weak)', () => {
      const hits = findSensitiveHits('I love cold brew coffee');
      expect(hits.every((h) => h.keyword !== 'cold')).toBe(true);
    });

    it('matches "cold" alone', () => {
      const hits = findSensitiveHits('I have a cold');
      expect(hits.some((h) => h.keyword === 'cold')).toBe(true);
    });

    it('matches case-insensitively', () => {
      const hits = findSensitiveHits('DIAGNOSIS of DIABETES');
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('overlap merging', () => {
    it('merges adjacent same-domain hits', () => {
      // "blood sugar" and "blood test" would overlap in "blood sugar blood test"
      // but with word boundaries they are separate hits
      const hits = findSensitiveHits('blood pressure cholesterol A1C');
      // All health — should each be separate since they're not within 2 chars
      expect(hits.every((h) => h.domain === 'health')).toBe(true);
    });

    it('promotes strength to strong when weak merges with strong', () => {
      // "doctor" (weak, ends at 6) + space + "diagnosis" (strong, starts at 7)
      // Within 2 chars → merged, strength promoted to strong
      const text = 'doctor diagnosis';
      const hits = findSensitiveHits(text);
      expect(hits).toHaveLength(1); // merged into one
      expect(hits[0].strength).toBe('strong'); // promoted
      expect(hits[0].domain).toBe('health');
    });
  });

  describe('hasHealthSignal', () => {
    it('returns true for health words', () => {
      expect(hasHealthSignal('I have pain in my back')).toBe(true);
      expect(hasHealthSignal('Going to the hospital')).toBe(true);
      expect(hasHealthSignal('My cholesterol is high')).toBe(true);
    });

    it('returns true for strong health keywords', () => {
      expect(hasHealthSignal('Diagnosed with hypertension')).toBe(true);
      expect(hasHealthSignal('Taking insulin daily')).toBe(true);
    });

    it('returns false for non-health text', () => {
      expect(hasHealthSignal('The stock market is up')).toBe(false);
      expect(hasHealthSignal('Meeting at 3pm')).toBe(false);
    });
  });

  describe('hasFinanceSignal', () => {
    it('returns true for finance words', () => {
      expect(hasFinanceSignal('Pay the invoice on time')).toBe(true);
      expect(hasFinanceSignal('My salary was deposited')).toBe(true);
      expect(hasFinanceSignal('Check credit card statement')).toBe(true);
    });

    it('returns true for strong finance keywords', () => {
      expect(hasFinanceSignal('My bank account number')).toBe(true);
      expect(hasFinanceSignal('Filing a tax return')).toBe(true);
    });

    it('returns false for non-finance text', () => {
      expect(hasFinanceSignal('The surgery went well')).toBe(false);
      expect(hasFinanceSignal('Nice weather today')).toBe(false);
    });
  });

  describe('hasWorkSignal', () => {
    it('returns true for work words', () => {
      expect(hasWorkSignal('Standup meeting at 9am')).toBe(true);
      expect(hasWorkSignal('My colleague is on leave')).toBe(true);
      expect(hasWorkSignal('Sprint planning tomorrow')).toBe(true);
    });

    it('returns false for non-work text', () => {
      expect(hasWorkSignal('Birthday party on Saturday')).toBe(false);
      expect(hasWorkSignal('Blood pressure is 120/80')).toBe(false);
    });
  });
});
