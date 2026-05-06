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
  type GuardScanLLMFn,
} from '../../src/guardian/guard_scan';

describe('Guard Scan', () => {

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

  describe('hallucinated PeerLens ratings', () => {
    it('made-up PeerLens rating → warning', async () => {
      const result = await scanResponse('This sender has a PeerLens rating: 8/10.');
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
      const result = await scanResponse('This sender has a PeerLens rating: 8/10.', {
        densityTier: 'zero',
      });
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('block');
      expect(v!.detail).toContain('zero/single');
    });

    it('rating claim is NOT flagged when a trust-providing tool fired this turn', async () => {
      // Tool-audit gate: if the agentic loop called `search_trust_network`
      // (or any peer_lens_* / peerlens_* tool), the LLM had real data
      // to draw on. The rating-claim detector still fires, but the
      // outer audit suppresses the violation. This is the data-driven
      // path that replaces the brittle brand-name regex.
      const result = await scanResponse('This sender has a PeerLens rating: 8/10.', {
        toolsCalled: ['search_trust_network'],
      });
      expect(result.violations.filter((v) => v.category === 'hallucinated_trust')).toEqual([]);
    });

    it('rating claim IS flagged when only non-trust tools fired', async () => {
      // A vault search tells us nothing about PeerLens ratings, so a
      // rating claim in the response is still suspect.
      const result = await scanResponse('Trust score: 9.', {
        toolsCalled: ['vault_search', 'geocode'],
      });
      expect(result.violations.some((v) => v.category === 'hallucinated_trust')).toBe(true);
    });

    it('matches any peerlens_* or peer_lens_* tool by prefix', async () => {
      // Future trust tools (e.g. `peerlens_aggregate`) shouldn't
      // require a parallel allow-list update — the prefix match
      // handles them.
      const r1 = await scanResponse('Reliability rating: 7.', {
        toolsCalled: ['peerlens_aggregate'],
      });
      expect(r1.violations.filter((v) => v.category === 'hallucinated_trust')).toEqual([]);
      const r2 = await scanResponse('Reliability rating: 7.', {
        toolsCalled: ['peer_lens_subject_detail'],
      });
      expect(r2.violations.filter((v) => v.category === 'hallucinated_trust')).toEqual([]);
    });

    it('detail string mentions the audit (not legacy "regex" wording)', async () => {
      const result = await scanResponse('Safety rating: 9.');
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v!.detail).toContain('trust tool call');
    });

    it('hallucinated trust with single density → block severity', async () => {
      const result = await scanResponse('The sender has high trust.', { densityTier: 'single' });
      const v = result.violations.find((v) => v.category === 'hallucinated_trust');
      expect(v!.severity).toBe('block');
    });

    it('hallucinated trust with dense density → warning severity (unchanged)', async () => {
      const result = await scanResponse('This sender has a PeerLens rating: 8/10.', {
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

    it('non-commercial advice not flagged', async () => {
      // "should" + nothing in COMMERCIAL_TARGETS → no flag. Replaces
      // the legacy regex-only behaviour that would also silently miss
      // this; the new word-set check correctly limits to commercial
      // targets.
      const result = await scanResponse('You should call your dentist tomorrow.');
      expect(result.violations.filter((v) => v.category === 'unsolicited_recommendation')).toEqual(
        [],
      );
    });

    it('solicited recommendation not flagged when user asked', async () => {
      // The `userPrompt` audit suppresses the violation when the
      // user's prompt explicitly invited a recommendation.
      const result = await scanResponse('I recommend you buy the premium plan.', {
        userPrompt: 'What should I buy for video editing?',
      });
      expect(result.violations.filter((v) => v.category === 'unsolicited_recommendation')).toEqual(
        [],
      );
    });

    it('still flagged when the user prompt is unrelated', async () => {
      // "What's my email" doesn't invite a commercial recommendation,
      // so a "you should buy" reply is still suspect.
      const result = await scanResponse('You should buy the premium plan.', {
        userPrompt: "What's my email address?",
      });
      expect(result.violations.some((v) => v.category === 'unsolicited_recommendation')).toBe(true);
    });

    it('detail string mentions the audit (no "regex"/"pattern" wording)', async () => {
      const result = await scanResponse('I recommend you buy the premium plan.');
      const v = result.violations.find((v) => v.category === 'unsolicited_recommendation');
      expect(v!.detail).toContain('explicit user invitation');
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
    // `stripViolations` requires a ScanResult. The prior optional-
    // fallback path silently used a different policy (Anti-Her only),
    // which was a footgun; production always scans first. Tests now
    // mirror that pattern: scanResponse → stripViolations.

    it('removes therapy-style sentences', async () => {
      const input = 'Your appointment is at 3pm. How does that make you feel? See you then.';
      const cleaned = stripViolations(input, await scanResponse(input));
      expect(cleaned).toContain('Your appointment is at 3pm.');
      expect(cleaned).not.toContain('How does that make you feel?');
      expect(cleaned).toContain('See you then.');
    });

    it('removes engagement hooks', async () => {
      const input = 'Here are your results. Is there anything else I can help with?';
      const cleaned = stripViolations(input, await scanResponse(input));
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

    it('returns clean text unchanged when nothing was flagged', async () => {
      const input = 'Your meeting is at 3pm. The agenda is attached.';
      const scanResult = await scanResponse(input);
      expect(scanResult.flaggedSentences).toEqual([]);
      expect(stripViolations(input, scanResult)).toBe(input);
    });

    it('handles empty string', async () => {
      const scanResult = await scanResponse('');
      expect(stripViolations('', scanResult)).toBe('');
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

    it('keeps a trailing fragment without closing punctuation', () => {
      // "no punctuation at end" used to depend on the regex picking
      // up an implicit boundary; the char-scan rewrite handles this
      // explicitly via the "tail" branch.
      const result = splitSentences('First sentence. Then a tail');
      expect(result).toEqual(['First sentence.', 'Then a tail']);
    });

    it('treats multiple whitespace between sentences as a single boundary', () => {
      const result = splitSentences('One.   Two.\n\tThree.');
      expect(result).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('does NOT split when punctuation has no trailing whitespace', () => {
      // "Hello.World." reads as one chunk — typical when an LLM forgets
      // a space rather than as two separate sentences. Don't over-split.
      const result = splitSentences('Hello.World. Foo.');
      expect(result).toEqual(['Hello.World.', 'Foo.']);
    });

    it('does NOT split decimals or numeric periods', () => {
      // "3.14" — the period after "3" has "1" (not whitespace) on its
      // right, so it isn't a boundary. Only the trailing period
      // closes the sentence.
      const result = splitSentences('Pi is 3.14 today.');
      expect(result).toEqual(['Pi is 3.14 today.']);
    });

    it('handles trimming of leading/trailing whitespace on the input', () => {
      const result = splitSentences('  Hello.  World.  ');
      expect(result).toEqual(['Hello.', 'World.']);
    });

    it('returns empty for whitespace-only input', () => {
      expect(splitSentences('   \n\t  ')).toEqual([]);
    });
  });

  describe('LLM-backed pass (per-call injection)', () => {
    // The LLM scanner is now injected via the `llmFn` context field
    // rather than a module-global setter. Tests pass it inline so
    // there's no global state to reset between cases — they can run
    // in parallel without interference.

    it('runs the injected LLM and contributes additional violations', async () => {
      const llmFn: GuardScanLLMFn = async () =>
        JSON.stringify({
          safe: false,
          violations: [{ type: 'therapy_simulation', text: 'subtle therapy' }],
        });
      const result = await scanResponse(
        'Let me explore your feelings about that situation.',
        { llmFn },
      );
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    it('LLM complements (not replaces) the deterministic checks', async () => {
      const llmFn = jest.fn<ReturnType<GuardScanLLMFn>, Parameters<GuardScanLLMFn>>(async () =>
        JSON.stringify({
          safe: false,
          violations: [{ type: 'unsolicited_recommendation', text: 'subtle rec' }],
        }),
      );
      const result = await scanResponse(
        'How does that make you feel? Also check out this new thing.',
        { llmFn },
      );
      expect(llmFn).toHaveBeenCalled();
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    it('falls open when the LLM throws (transient outage)', async () => {
      const llmFn: GuardScanLLMFn = async () => {
        throw new Error('timeout');
      };
      const result = await scanResponse('Normal factual answer.', { llmFn });
      expect(result.safe).toBe(true);
    });

    it('scrubs PII from the response before sending to the LLM', async () => {
      let receivedPrompt = '';
      const llmFn: GuardScanLLMFn = async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ safe: true, violations: [] });
      };
      await scanResponse('Contact alice@secret.com or call 555-999-1111 for details.', {
        llmFn,
      });
      expect(receivedPrompt).not.toContain('alice@secret.com');
      expect(receivedPrompt).not.toContain('555-999-1111');
      expect(receivedPrompt).toContain('[EMAIL_1]');
      expect(receivedPrompt).toContain('[PHONE_1]');
    });

    it('does NOT call the LLM when no `llmFn` is provided', async () => {
      // No global state means a `scanResponse` without `llmFn` can't
      // accidentally pick up an LLM registered by another test.
      const result = await scanResponse('Plain factual sentence.');
      expect(result.safe).toBe(true);
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
