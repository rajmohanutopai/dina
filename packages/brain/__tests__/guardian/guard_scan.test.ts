/**
 * T3.23 — Guard scan: post-processing safety for LLM responses.
 *
 * Category B: contract test. Verifies all 4 violation categories:
 * Anti-Her, PII leakage, hallucinated trust, unsolicited recommendations.
 * Tests sentence-level indexing and LLM guard scan provider.
 *
 * Source: brain/tests/test_guardian.py (guard scan section)
 */

import {
  scanResponse,
  stripViolations,
  splitSentences,
  parseLLMGuardResult,
  registerGuardScanLLM,
  resetGuardScanLLM,
} from '../../src/guardian/guard_scan';

describe('Guard Scan', () => {
  afterEach(() => resetGuardScanLLM());

  describe('clean responses', () => {
    it('factual response → safe', async () => {
      const result = await scanResponse('Your next meeting is at 3pm tomorrow.');
      expect(result.safe).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('search result → safe', async () => {
      const result = await scanResponse('I found 3 results for "ergonomic chairs" in your vault.');
      expect(result.safe).toBe(true);
    });

    it('reminder confirmation → safe', async () => {
      const result = await scanResponse('Done. Reminder set for March 15 at 9am.');
      expect(result.safe).toBe(true);
    });
  });

  describe('Anti-Her violations', () => {
    it('therapy-style → blocked', async () => {
      const result = await scanResponse('How does that make you feel?');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.category === 'anti_her')).toBe(true);
      expect(result.violations[0].severity).toBe('block');
    });

    it('engagement hook → blocked', async () => {
      const result = await scanResponse('Is there anything else I can help with?');
      expect(result.safe).toBe(false);
      expect(
        result.violations.some(
          (v) => v.category === 'anti_her' && v.detail.includes('engagement_hook'),
        ),
      ).toBe(true);
    });

    it('intimacy simulation → blocked', async () => {
      const result = await scanResponse('I care about you deeply.');
      expect(result.safe).toBe(false);
      expect(
        result.violations.some(
          (v) => v.category === 'anti_her' && v.detail.includes('intimacy_simulation'),
        ),
      ).toBe(true);
    });

    it('multiple Anti-Her violations in one response', async () => {
      const result = await scanResponse("I'm always here for you. How does that make you feel?");
      const antiHerViolations = result.violations.filter((v) => v.category === 'anti_her');
      expect(antiHerViolations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('PII leakage', () => {
    it('unrehydrated token [EMAIL_1] → blocked', async () => {
      const result = await scanResponse('The sender was [EMAIL_1] who sent the invoice.');
      expect(result.safe).toBe(false);
      expect(
        result.violations.some(
          (v) => v.category === 'pii_leakage' && v.detail.includes('[EMAIL_1]'),
        ),
      ).toBe(true);
    });

    it('multiple unrehydrated tokens detected', async () => {
      const result = await scanResponse('Contact [EMAIL_1] at [PHONE_1] about SSN [SSN_1].');
      const piiViolations = result.violations.filter((v) => v.category === 'pii_leakage');
      expect(piiViolations.length).toBeGreaterThanOrEqual(1);
      expect(piiViolations[0].matchedText).toContain('[EMAIL_1]');
    });

    it('raw PII detected when scrubbing was expected', async () => {
      const result = await scanResponse('The email from john@example.com mentioned a payment.', {
        piiScrubbed: true,
      });
      expect(
        result.violations.some((v) => v.category === 'pii_leakage' && v.detail.includes('Raw PII')),
      ).toBe(true);
    });

    it('raw PII NOT flagged when scrubbing was not applied', async () => {
      const result = await scanResponse('The email from john@example.com mentioned a payment.');
      const piiLeakViolations = result.violations.filter(
        (v) => v.category === 'pii_leakage' && v.detail.includes('Raw PII'),
      );
      expect(piiLeakViolations).toEqual([]);
    });

    it('brackets in non-PII context not flagged', async () => {
      const result = await scanResponse('Use array[0] and object["key"] syntax.');
      expect(result.safe).toBe(true);
    });
  });

  describe('hallucinated trust scores', () => {
    it('made-up trust score → warning', async () => {
      const result = await scanResponse('This sender has a trust score: 8/10.');
      expect(result.violations.some((v) => v.category === 'hallucinated_trust')).toBe(true);
      expect(result.violations.find((v) => v.category === 'hallucinated_trust')?.severity).toBe(
        'warning',
      );
    });

    it('"the sender has high trust" → warning', async () => {
      const result = await scanResponse('The sender has high trust.');
      expect(result.violations.some((v) => v.category === 'hallucinated_trust')).toBe(true);
    });

    it('safety rating → warning', async () => {
      const result = await scanResponse('Safety rating: 9.');
      expect(result.violations.some((v) => v.category === 'hallucinated_trust')).toBe(true);
    });

    it('hallucinated trust with zero density → block severity', async () => {
      const result = await scanResponse('This sender has a trust score: 8/10.', {
        densityTier: 'zero',
      });
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('block');
      expect(v!.detail).toContain('zero/single');
    });

    it('hallucinated trust with single density → block severity', async () => {
      const result = await scanResponse('The sender has high trust.', { densityTier: 'single' });
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v!.severity).toBe('block');
    });

    it('hallucinated trust with dense density → warning severity (unchanged)', async () => {
      const result = await scanResponse('This sender has a trust score: 8/10.', {
        densityTier: 'dense',
      });
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v!.severity).toBe('warning');
    });

    it('legitimate use of "trust" not flagged', async () => {
      const result = await scanResponse('You can trust your instincts on this decision.');
      expect(result.violations.filter((v) => v.category === 'hallucinated_trust')).toEqual([]);
    });
  });

  describe('unsolicited recommendations', () => {
    it('"I recommend you buy" → warning', async () => {
      const result = await scanResponse('I recommend you buy the premium plan.');
      expect(result.violations.some((v) => v.category === 'unsolicited_recommendation')).toBe(true);
    });

    it('"you should subscribe" → warning', async () => {
      const result = await scanResponse('You should subscribe to this newsletter.');
      expect(result.violations.some((v) => v.category === 'unsolicited_recommendation')).toBe(true);
    });

    it('"check out this deal" → warning', async () => {
      const result = await scanResponse('Check out this deal on new headphones.');
      expect(result.violations.some((v) => v.category === 'unsolicited_recommendation')).toBe(true);
    });

    it('factual product mention not flagged', async () => {
      const result = await scanResponse('Your order for headphones was delivered yesterday.');
      expect(result.violations.filter((v) => v.category === 'unsolicited_recommendation')).toEqual(
        [],
      );
    });
  });

  describe('sentence-level indexing', () => {
    it('tracks sentence indices for Anti-Her violations', async () => {
      const result = await scanResponse(
        'Your meeting is at 3pm. How does that make you feel? See you then.',
      );
      const violation = result.violations.find((v) => v.category === 'anti_her');
      expect(violation).toBeDefined();
      expect(violation!.sentenceIndices).toEqual([1]); // 2nd sentence (index 1)
    });

    it('flags multiple sentence indices', async () => {
      const result = await scanResponse(
        "I'm always here for you. Your appointment is tomorrow. How does that make you feel?",
      );
      expect(result.flaggedSentences).toContain(0); // engagement hook
      expect(result.flaggedSentences).toContain(2); // therapy style
      expect(result.flaggedSentences).not.toContain(1); // clean sentence
    });

    it('reports sentenceCount', async () => {
      const result = await scanResponse('Sentence one. Sentence two. Sentence three.');
      expect(result.sentenceCount).toBe(3);
    });

    it('flaggedSentences is sorted', async () => {
      const result = await scanResponse(
        "I'm always here for you. Clean. How does that make you feel?",
      );
      const sorted = [...result.flaggedSentences].sort((a, b) => a - b);
      expect(result.flaggedSentences).toEqual(sorted);
    });
  });

  describe('stripViolations', () => {
    it('removes therapy-style sentences', () => {
      const input = 'Your appointment is at 3pm. How does that make you feel? See you then.';
      const cleaned = stripViolations(input);
      expect(cleaned).toContain('Your appointment is at 3pm.');
      expect(cleaned).not.toContain('How does that make you feel?');
      expect(cleaned).toContain('See you then.');
    });

    it('removes engagement hooks', () => {
      const input = 'Here are your results. Is there anything else I can help with?';
      const cleaned = stripViolations(input);
      expect(cleaned).toContain('Here are your results.');
      expect(cleaned).not.toContain('anything else');
    });

    it('precise removal by scan result indices', async () => {
      const input = 'Good info. I care about you deeply. More good info.';
      const scanResult = await scanResponse(input);
      const cleaned = stripViolations(input, scanResult);
      expect(cleaned).toContain('Good info.');
      expect(cleaned).not.toContain('care about you deeply');
      expect(cleaned).toContain('More good info.');
    });

    it('returns clean text unchanged', () => {
      const input = 'Your meeting is at 3pm. The agenda is attached.';
      expect(stripViolations(input)).toBe(input);
    });

    it('handles empty string', () => {
      expect(stripViolations('')).toBe('');
    });
  });

  describe('splitSentences', () => {
    it('splits on sentence boundaries', () => {
      expect(splitSentences('Hello. World. Foo!')).toEqual(['Hello.', 'World.', 'Foo!']);
    });

    it('handles single sentence', () => {
      expect(splitSentences('Hello world.')).toEqual(['Hello world.']);
    });

    it('handles empty string', () => {
      expect(splitSentences('')).toEqual([]);
    });

    it('handles question marks', () => {
      expect(splitSentences('What? Why! OK.')).toEqual(['What?', 'Why!', 'OK.']);
    });

    it('handles abbreviations like Dr.', () => {
      const result = splitSentences('Dr. Smith sent a message. It was important.');
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Dr. Smith');
    });

    it('handles Mr. and Mrs. abbreviations', () => {
      const result = splitSentences('Mr. Jones and Mrs. Smith arrived. They sat down.');
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Mr. Jones');
      expect(result[0]).toContain('Mrs. Smith');
    });
  });

  describe('LLM guard scan', () => {
    it('uses LLM when registered and regex finds nothing', async () => {
      registerGuardScanLLM(async () =>
        JSON.stringify({
          safe: false,
          violations: [{ type: 'therapy_simulation', text: 'subtle therapy' }],
        }),
      );

      const result = await scanResponse('Let me explore your feelings about that situation.');
      // regex may or may not catch this; LLM adds coverage
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    it('runs LLM as complement to regex (both contribute)', async () => {
      const mockLLM = jest.fn(async () =>
        JSON.stringify({
          safe: false,
          violations: [{ type: 'unsolicited_recommendation', text: 'subtle rec' }],
        }),
      );
      registerGuardScanLLM(mockLLM);

      // "How does that make you feel?" triggers regex. LLM adds additional violations.
      const result = await scanResponse(
        'How does that make you feel? Also check out this new thing.',
      );
      expect(mockLLM).toHaveBeenCalled();
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    it('falls back to regex when LLM fails', async () => {
      registerGuardScanLLM(async () => {
        throw new Error('timeout');
      });
      const result = await scanResponse('Normal factual answer.');
      expect(result.safe).toBe(true);
    });

    it('scrubs PII from response before sending to LLM', async () => {
      let receivedPrompt = '';
      registerGuardScanLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ safe: true, violations: [] });
      });

      // Response contains PII (email and phone) that should be scrubbed
      await scanResponse('Contact alice@secret.com or call 555-999-1111 for details.');

      expect(receivedPrompt).not.toContain('alice@secret.com');
      expect(receivedPrompt).not.toContain('555-999-1111');
      expect(receivedPrompt).toContain('[EMAIL_1]');
      expect(receivedPrompt).toContain('[PHONE_1]');
    });
  });

  describe('parseLLMGuardResult', () => {
    it('parses direct sentence_indices from LLM', () => {
      const json = JSON.stringify({
        safe: false,
        violations: [
          { type: 'therapy_simulation', sentence_indices: [0], text: 'How are you holding up' },
        ],
      });
      const response = 'How are you holding up? Your meeting is tomorrow.';
      const violations = parseLLMGuardResult(json, response);
      expect(violations).toHaveLength(1);
      expect(violations[0].category).toBe('anti_her');
      expect(violations[0].sentenceIndices).toEqual([0]);
    });

    it('falls back to text matching when no sentence_indices', () => {
      const json = JSON.stringify({
        safe: false,
        violations: [{ type: 'therapy_simulation', text: 'How are you holding up' }],
      });
      const response = 'How are you holding up? Your meeting is tomorrow.';
      const violations = parseLLMGuardResult(json, response);
      expect(violations).toHaveLength(1);
      expect(violations[0].sentenceIndices).toContain(0);
    });

    it('validates sentence_indices are within bounds', () => {
      const json = JSON.stringify({
        safe: false,
        violations: [{ type: 'therapy_simulation', sentence_indices: [0, 99], text: '...' }],
      });
      const response = 'First sentence. Second sentence.';
      const violations = parseLLMGuardResult(json, response);
      // Index 99 is out of bounds (only 2 sentences), so should be filtered out
      expect(violations[0].sentenceIndices).toEqual([0]);
    });

    it('returns empty for safe: true', () => {
      const json = JSON.stringify({ safe: true, violations: [] });
      expect(parseLLMGuardResult(json, 'test')).toEqual([]);
    });

    it('handles malformed JSON gracefully', () => {
      expect(parseLLMGuardResult('not json', 'test')).toEqual([]);
    });

    it('handles empty input', () => {
      expect(parseLLMGuardResult('', 'test')).toEqual([]);
    });

    it('ignores unknown violation types', () => {
      const json = JSON.stringify({
        safe: false,
        violations: [{ type: 'totally_unknown_type', text: 'some text' }],
      });
      expect(parseLLMGuardResult(json, 'test')).toEqual([]);
    });
  });
});
