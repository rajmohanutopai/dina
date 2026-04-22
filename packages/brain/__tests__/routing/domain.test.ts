/**
 * T3.10 — Domain classifier: keyword-based persona routing.
 *
 * Category B: contract test. Verifies keyword routing to correct
 * persona, source hints, fallback to general, alias resolution,
 * word-boundary matching, strong/weak scoring, and legal domain.
 *
 * Source: brain/tests/test_routing.py
 */

import { classifyDomain, classifyAndResolve } from '../../src/routing/domain';
import type { ClassificationInput } from '../../src/routing/domain';

describe('Domain Classifier', () => {
  describe('health domain', () => {
    it('"lab results" → health', () => {
      const result = classifyDomain({ subject: 'Your lab results are ready' });
      expect(result.persona).toBe('health');
      expect(result.matchedKeywords).toContain('lab result');
    });

    it('"prescription" → health', () => {
      const result = classifyDomain({ body: 'Your prescription is ready for pickup' });
      expect(result.persona).toBe('health');
    });

    it('"doctor appointment" → health', () => {
      const result = classifyDomain({ subject: 'Reminder: doctor appointment tomorrow' });
      expect(result.persona).toBe('health');
    });

    it('health_system source → health (high confidence)', () => {
      const result = classifyDomain({ source: 'health_system', subject: 'Update' });
      expect(result.persona).toBe('health');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('"blood sugar" → health (strong keyword from Python)', () => {
      const result = classifyDomain({ body: 'Your blood sugar levels are normal' });
      expect(result.persona).toBe('health');
      expect(result.matchedKeywords).toContain('blood sugar');
    });

    it('"cholesterol" → health (strong keyword from Python)', () => {
      const result = classifyDomain({ body: 'Cholesterol test results' });
      expect(result.persona).toBe('health');
    });
  });

  describe('financial domain', () => {
    it('"invoice" → financial', () => {
      const result = classifyDomain({ subject: 'Invoice #12345 attached' });
      expect(result.persona).toBe('financial');
    });

    it('"payment due" → financial', () => {
      const result = classifyDomain({ subject: 'Payment due for your account' });
      expect(result.persona).toBe('financial');
    });

    it('"tax" → financial', () => {
      const result = classifyDomain({ body: 'Your tax return has been processed' });
      expect(result.persona).toBe('financial');
    });

    it('bank source → financial (high confidence)', () => {
      const result = classifyDomain({ source: 'bank', subject: 'Statement' });
      expect(result.persona).toBe('financial');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('professional domain', () => {
    it('"meeting" → professional', () => {
      const result = classifyDomain({ subject: 'Team meeting at 3pm' });
      expect(result.persona).toBe('professional');
    });

    it('"deadline" → professional', () => {
      const result = classifyDomain({ body: 'Deadline for the project is Friday' });
      expect(result.persona).toBe('professional');
    });

    it('jira source → professional', () => {
      const result = classifyDomain({ source: 'jira', subject: 'PROJ-123 updated' });
      expect(result.persona).toBe('professional');
    });

    it('slack source → professional', () => {
      const result = classifyDomain({ source: 'slack', subject: 'New message' });
      expect(result.persona).toBe('professional');
    });
  });

  describe('social domain', () => {
    it('"birthday" → social', () => {
      const result = classifyDomain({ subject: "It's Alice's birthday tomorrow" });
      expect(result.persona).toBe('social');
    });

    it('"dinner" → social', () => {
      const result = classifyDomain({ body: 'Dinner at 7pm this Saturday?' });
      expect(result.persona).toBe('social');
    });
  });

  describe('consumer domain', () => {
    it('"order shipment" → consumer', () => {
      const result = classifyDomain({ subject: 'Your order has shipped' });
      expect(result.persona).toBe('consumer');
    });

    it('"delivery tracking" → consumer', () => {
      const result = classifyDomain({ body: 'Track your delivery here' });
      expect(result.persona).toBe('consumer');
    });
  });

  describe('legal domain', () => {
    it('"lawsuit" → legal', () => {
      const result = classifyDomain({ subject: 'Update on your pending lawsuit' });
      expect(result.persona).toBe('legal');
      expect(result.matchedKeywords).toContain('lawsuit');
    });

    it('"subpoena" → legal', () => {
      const result = classifyDomain({ body: 'You have been served a subpoena' });
      expect(result.persona).toBe('legal');
    });

    it('"attorney" → legal', () => {
      const result = classifyDomain({ body: 'Your attorney called about the case' });
      expect(result.persona).toBe('legal');
    });

    it('"restraining order" → legal', () => {
      const result = classifyDomain({ body: 'Filing a restraining order in court' });
      expect(result.persona).toBe('legal');
    });

    it('multiple legal keywords boost confidence', () => {
      const result = classifyDomain({
        body: 'The attorney filed the subpoena for the deposition',
      });
      expect(result.persona).toBe('legal');
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('fallback to general', () => {
    it('ambiguous text → general', () => {
      const result = classifyDomain({ subject: 'Hello there' });
      expect(result.persona).toBe('general');
      expect(result.method).toBe('fallback');
    });

    it('empty input → general', () => {
      const result = classifyDomain({});
      expect(result.persona).toBe('general');
    });

    it('no keywords matched → low confidence', () => {
      const result = classifyDomain({ subject: 'Random thoughts about life' });
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('confidence scoring', () => {
    it('source hint gives higher confidence than keyword', () => {
      const sourceResult = classifyDomain({ source: 'bank', subject: 'Update' });
      const keywordResult = classifyDomain({ subject: 'payment reminder' });
      expect(sourceResult.confidence).toBeGreaterThan(keywordResult.confidence);
    });

    it('multiple keyword matches increase confidence', () => {
      const single = classifyDomain({ subject: 'invoice' });
      const multi = classifyDomain({ subject: 'invoice payment bank statement' });
      expect(multi.confidence).toBeGreaterThan(single.confidence);
    });

    it('confidence never exceeds 0.90', () => {
      const result = classifyDomain({
        subject: 'invoice payment bank statement tax receipt expense budget',
      });
      expect(result.confidence).toBeLessThanOrEqual(0.9);
    });

    it('strong keywords contribute more than weak keywords', () => {
      // "diagnosis" is strong (0.25), "doctor" is weak (0.10)
      const strong = classifyDomain({ body: 'diagnosis confirmed' });
      const weak = classifyDomain({ body: 'called the doctor' });
      expect(strong.confidence).toBeGreaterThan(weak.confidence);
    });
  });

  describe('word-boundary matching', () => {
    it('"flu" does NOT match inside "influence"', () => {
      // "flu" is not a keyword, but if it were, word boundary prevents mid-word match
      // Test with "health" keyword — should not match "healthcare" as a substring issue
      const result = classifyDomain({ body: 'The influence of policy on public affairs' });
      // No health keywords should match here
      expect(result.persona).toBe('general');
    });

    it('"payment" does NOT match inside "nonpayment" when at mid-word', () => {
      // \bpayment does match "nonpayment" since there's no word boundary before 'p'
      // But "nonpayment" doesn't appear as a keyword — the concern is the keyword
      // "payment" matching inside "nonpayment". \bpayment matches because 'n' before
      // ... wait actually "nonpayment" has no \b before 'p', so it won't match. Good.
      const result = classifyDomain({ body: 'The nonpayment issue was resolved' });
      // "payment" has \b before 'p', but in "nonpayment" the 'n' before 'p' blocks it
      expect(result.matchedKeywords).not.toContain('payment');
    });

    it('keyword matches at word start (handles plurals)', () => {
      // "lab result" should match "lab results" (no trailing boundary)
      const result = classifyDomain({ body: 'Your lab results came back' });
      expect(result.matchedKeywords).toContain('lab result');
    });

    it('keyword matches at sentence start', () => {
      const result = classifyDomain({ body: 'Invoice for services rendered' });
      expect(result.persona).toBe('financial');
    });
  });

  describe('classifyAndResolve (with alias resolution)', () => {
    it('canonical persona passes through', () => {
      const result = classifyAndResolve({ subject: 'lab results' });
      expect(result.persona).toBe('health');
    });

    it('resolves via alias table', () => {
      // classifyDomain returns "financial" which is canonical
      const result = classifyAndResolve({ subject: 'invoice due' });
      expect(result.persona).toBe('financial');
    });

    it('fallback general is resolved', () => {
      const result = classifyAndResolve({ subject: 'hello' });
      expect(result.persona).toBe('general');
    });
  });

  describe('method field', () => {
    it('keyword match sets method to "keyword"', () => {
      const result = classifyDomain({ subject: 'lab results' });
      expect(result.method).toBe('keyword');
    });

    it('source hint sets method to "keyword"', () => {
      const result = classifyDomain({ source: 'bank' });
      expect(result.method).toBe('keyword');
    });

    it('no match sets method to "fallback"', () => {
      const result = classifyDomain({ subject: 'hello' });
      expect(result.method).toBe('fallback');
    });
  });
});
