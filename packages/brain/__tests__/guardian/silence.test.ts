/**
 * T2B.4 — Guardian loop: silence classification across all priority tiers.
 *
 * Category B: contract test. Verifies classification rules for
 * fiduciary, solicited, engagement events.
 *
 * Source: brain/tests/test_guardian.py
 */

import {
  classifyPriority,
  classifyDeterministic,
  matchesFiduciaryKeywords,
  isFiduciarySource,
  isSolicitedType,
  isEngagementType,
  isMarketingSource,
  matchesHealthElevation,
  isStaleContent,
  registerSilenceClassifier,
  resetSilenceClassifier,
  resetDNDState,
  resetEscalationState,
  resetQuietHoursState,
  resetBatchingState,
  resetUserOverrides,
} from '../../src/guardian/silence';
import {
  makeFiduciaryEvent,
  makeSolicitedEvent,
  makeEngagementEvent,
  makeEvent,
} from '@dina/test-harness';

describe('Guardian Silence Classification', () => {
  describe('classifyPriority (async, falls back to deterministic)', () => {
    it('fiduciary event → Tier 1', async () => {
      const result = await classifyPriority(makeFiduciaryEvent());
      expect(result.tier).toBe(1);
    });

    it('solicited event → Tier 2', async () => {
      const result = await classifyPriority(makeSolicitedEvent({ timestamp: Date.now() }));
      expect(result.tier).toBe(2);
    });

    it('engagement event → Tier 3', async () => {
      const result = await classifyPriority(makeEngagementEvent());
      expect(result.tier).toBe(3);
    });

    it('ambiguous event → Tier 3 (Silence First default)', async () => {
      const result = await classifyPriority(makeEvent({ source: 'unknown', subject: 'Hello' }));
      expect(result.tier).toBe(3);
    });

    it('security alert → Tier 1', async () => {
      const result = await classifyPriority(
        makeEvent({ subject: 'Security Alert: Unusual login' }),
      );
      expect(result.tier).toBe(1);
    });

    it('lab results → Tier 1 (health fiduciary)', async () => {
      const result = await classifyPriority(makeEvent({ subject: 'Your lab results are ready' }));
      expect(result.tier).toBe(1);
    });

    it('promo email → Tier 3', async () => {
      const result = await classifyPriority(makeEvent({ type: 'promo', source: 'social' }));
      expect(result.tier).toBe(3);
    });

    it('reminder → Tier 2', async () => {
      const result = await classifyPriority(makeEvent({ type: 'reminder', timestamp: Date.now() }));
      expect(result.tier).toBe(2);
    });
  });

  describe('classifyDeterministic (regex fallback, no LLM)', () => {
    it('bank source → Tier 1', () => {
      const result = classifyDeterministic(makeEvent({ source: 'bank' }));
      expect(result.tier).toBe(1);
    });

    it('health_system source → Tier 1', () => {
      const result = classifyDeterministic(makeEvent({ source: 'health_system' }));
      expect(result.tier).toBe(1);
    });

    it('emergency source → Tier 1', () => {
      const result = classifyDeterministic(makeEvent({ source: 'emergency' }));
      expect(result.tier).toBe(1);
    });

    it('"cancel" keyword → Tier 1', () => {
      const result = classifyDeterministic(makeEvent({ subject: 'Order cancelled' }));
      expect(result.tier).toBe(1);
    });

    it('search_result type → Tier 2', () => {
      const result = classifyDeterministic(makeEvent({ type: 'search_result' }));
      expect(result.tier).toBe(2);
    });

    it('notification type → Tier 3', () => {
      const result = classifyDeterministic(makeEvent({ type: 'notification' }));
      expect(result.tier).toBe(3);
    });

    it('podcast type → Tier 3', () => {
      const result = classifyDeterministic(makeEvent({ type: 'podcast' }));
      expect(result.tier).toBe(3);
    });

    it('returns method: "deterministic"', () => {
      const result = classifyDeterministic(makeEvent());
      expect(result.method).toBe('deterministic');
    });

    it('includes a reason string', () => {
      const result = classifyDeterministic(makeEvent({ source: 'bank' }));
      expect(result.reason).toContain('bank');
    });

    it('includes confidence score', () => {
      const result = classifyDeterministic(makeEvent({ source: 'bank' }));
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('fiduciary source takes priority over engagement type', () => {
      const result = classifyDeterministic(makeEvent({ source: 'bank', type: 'notification' }));
      expect(result.tier).toBe(1); // source wins
    });
  });

  describe('matchesFiduciaryKeywords', () => {
    const keywords = [
      'cancel',
      'security alert',
      'breach',
      'unusual login',
      'overdrawn',
      'lab result',
      'diagnosis',
      'emergency',
    ];

    for (const keyword of keywords) {
      it(`matches "${keyword}"`, () => {
        expect(matchesFiduciaryKeywords(`Something about ${keyword} happened`)).toBe(true);
      });
    }

    it('is case-insensitive', () => {
      expect(matchesFiduciaryKeywords('SECURITY ALERT detected')).toBe(true);
    });

    it('does not match regular text', () => {
      expect(matchesFiduciaryKeywords('Nice weather today')).toBe(false);
    });
  });

  describe('isFiduciarySource', () => {
    for (const source of ['security', 'health_system', 'bank', 'emergency']) {
      it(`"${source}" is fiduciary`, () => {
        expect(isFiduciarySource(source)).toBe(true);
      });
    }

    it('"gmail" is NOT fiduciary', () => {
      expect(isFiduciarySource('gmail')).toBe(false);
    });

    it('"social" is NOT fiduciary', () => {
      expect(isFiduciarySource('social')).toBe(false);
    });
  });

  describe('isSolicitedType', () => {
    it('"reminder" is solicited', () => {
      expect(isSolicitedType('reminder')).toBe(true);
    });

    it('"search_result" is solicited', () => {
      expect(isSolicitedType('search_result')).toBe(true);
    });

    it('"email" is NOT solicited', () => {
      expect(isSolicitedType('email')).toBe(false);
    });
  });

  describe('isEngagementType', () => {
    for (const type of ['notification', 'promo', 'social', 'rss', 'podcast']) {
      it(`"${type}" is engagement`, () => {
        expect(isEngagementType(type)).toBe(true);
      });
    }

    it('"email" is NOT engagement', () => {
      expect(isEngagementType('email')).toBe(false);
    });

    it('"reminder" is NOT engagement', () => {
      expect(isEngagementType('reminder')).toBe(false);
    });

    it('"background_sync" is engagement', () => {
      expect(isEngagementType('background_sync')).toBe(true);
    });
  });

  describe('marketing phishing guard', () => {
    it('"cancel" keyword from promo source → NOT Tier 1', () => {
      const result = classifyDeterministic(
        makeEvent({
          source: 'promo',
          subject: 'Cancel your subscription now!',
        }),
      );
      // Marketing phishing guard: urgent keywords from promo don't elevate
      expect(result.tier).not.toBe(1);
    });

    it('"cancel" keyword from gmail source → Tier 1 (not marketing)', () => {
      const result = classifyDeterministic(
        makeEvent({
          source: 'gmail',
          subject: 'Your order has been cancelled',
        }),
      );
      expect(result.tier).toBe(1);
    });

    it('"security alert" from marketing source → NOT Tier 1', () => {
      const result = classifyDeterministic(
        makeEvent({
          source: 'marketing',
          subject: 'Security Alert: Act now!',
        }),
      );
      expect(result.tier).not.toBe(1);
    });

    it('isMarketingSource identifies promo/marketing/newsletter/social', () => {
      expect(isMarketingSource('promo')).toBe(true);
      expect(isMarketingSource('marketing')).toBe(true);
      expect(isMarketingSource('newsletter')).toBe(true);
      expect(isMarketingSource('social')).toBe(true);
      expect(isMarketingSource('gmail')).toBe(false);
      expect(isMarketingSource('bank')).toBe(false);
    });
  });

  describe('health context elevation', () => {
    it('health keywords from health_system → Tier 1', () => {
      const result = classifyDeterministic(
        makeEvent({
          source: 'health_system',
          subject: 'Your blood pressure reading is available',
        }),
      );
      expect(result.tier).toBe(1);
    });

    it('health keywords from gmail → NOT elevated (not health_system)', () => {
      const result = classifyDeterministic(
        makeEvent({
          source: 'gmail',
          subject: 'Your blood pressure reading',
        }),
      );
      // Should not be Tier 1 — health elevation only from health_system source
      expect(result.tier).not.toBe(1);
    });

    it('matchesHealthElevation detects health keywords', () => {
      expect(matchesHealthElevation('Your blood sugar is high')).toBe(true);
      expect(matchesHealthElevation('cholesterol results')).toBe(true);
      expect(matchesHealthElevation('prescription refill')).toBe(true);
      expect(matchesHealthElevation('nice weather today')).toBe(false);
    });
  });

  describe('stale content demotion', () => {
    it('stale solicited items demoted to Tier 3', async () => {
      const staleTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          timestamp: staleTimestamp,
        }),
      );
      expect(result.tier).toBe(3);
      expect(result.reason).toContain('Stale');
    });

    it('fiduciary items NOT demoted even when stale', async () => {
      const staleTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      const result = await classifyPriority(
        makeEvent({
          source: 'bank',
          subject: 'Security alert',
          timestamp: staleTimestamp,
        }),
      );
      // Fiduciary stays Tier 1 — Law 1 overrides staleness
      expect(result.tier).toBe(1);
    });

    it('fresh solicited items stay at Tier 2', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          timestamp: Date.now(),
        }),
      );
      expect(result.tier).toBe(2);
    });

    it('isStaleContent detects old content', () => {
      const old = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      expect(isStaleContent(old).stale).toBe(true);
    });

    it('isStaleContent accepts fresh content', () => {
      expect(isStaleContent(Date.now()).stale).toBe(false);
    });
  });

  describe('LLM refinement', () => {
    beforeEach(() => {
      resetSilenceClassifier();
      resetDNDState();
      resetEscalationState();
      resetQuietHoursState();
      resetBatchingState();
      resetUserOverrides();
    });
    afterEach(() => resetSilenceClassifier());

    it('uses LLM when registered and deterministic confidence is low', async () => {
      registerSilenceClassifier(async () =>
        JSON.stringify({ tier: 2, reason: 'LLM classified as solicited', confidence: 0.85 }),
      );

      // Generic event → deterministic gives Tier 3 at 0.50 confidence
      // Use recent timestamp to avoid stale demotion of LLM result
      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          subject: 'New document shared',
          type: 'unknown',
          timestamp: Date.now(),
        }),
      );
      expect(result.method).toBe('llm');
      expect(result.tier).toBe(2);
      expect(result.reason).toContain('LLM');
    });

    it('falls back to deterministic when LLM fails', async () => {
      registerSilenceClassifier(async () => {
        throw new Error('LLM timeout');
      });

      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
        }),
      );
      expect(result.method).toBe('deterministic');
    });

    it('skips LLM when deterministic confidence is high (≥0.85)', async () => {
      const mockLLM = jest.fn(async () =>
        JSON.stringify({ tier: 3, reason: 'LLM says engagement', confidence: 0.9 }),
      );
      registerSilenceClassifier(mockLLM);

      // Reminder type → deterministic gives Tier 2 at 0.90 confidence
      // Use recent timestamp to avoid stale demotion
      const result = await classifyPriority(makeEvent({ type: 'reminder', timestamp: Date.now() }));
      expect(mockLLM).not.toHaveBeenCalled();
      expect(result.method).toBe('deterministic');
      expect(result.tier).toBe(2);
    });

    it('never downgrades fiduciary via LLM', async () => {
      registerSilenceClassifier(async () =>
        JSON.stringify({ tier: 3, reason: 'LLM says engagement', confidence: 0.99 }),
      );

      // Bank source → Tier 1 fiduciary (never sent to LLM)
      const result = await classifyPriority(makeEvent({ source: 'bank' }));
      expect(result.tier).toBe(1);
    });

    it('rejects LLM response with low confidence', async () => {
      registerSilenceClassifier(async () =>
        JSON.stringify({ tier: 1, reason: 'Maybe fiduciary', confidence: 0.3 }),
      );

      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
        }),
      );
      expect(result.method).toBe('deterministic'); // LLM confidence too low
    });

    it('marketing phishing guard blocks LLM elevation to Tier 1', async () => {
      registerSilenceClassifier(async () =>
        JSON.stringify({ tier: 1, reason: 'Urgent cancel notice', confidence: 0.95 }),
      );

      // Promo source → LLM tries to elevate to Tier 1 → blocked by phishing guard
      const result = await classifyPriority(
        makeEvent({
          source: 'promo',
          subject: 'Cancel your subscription now!',
          type: 'unknown',
        }),
      );
      expect(result.tier).not.toBe(1);
    });

    it('rejects invalid LLM tier value', async () => {
      registerSilenceClassifier(async () =>
        JSON.stringify({ tier: 5, reason: 'Invalid tier', confidence: 0.9 }),
      );

      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
        }),
      );
      expect(result.method).toBe('deterministic');
    });

    it('rejects malformed LLM JSON response', async () => {
      registerSilenceClassifier(async () => 'not json at all');

      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
        }),
      );
      expect(result.method).toBe('deterministic');
    });

    it('works without LLM registered (pure deterministic)', async () => {
      const result = await classifyPriority(makeEvent({ type: 'reminder', timestamp: Date.now() }));
      expect(result.method).toBe('deterministic');
      expect(result.tier).toBe(2);
    });

    it('scrubs PII from subject and body before sending to LLM', async () => {
      let receivedPrompt = '';
      registerSilenceClassifier(async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ tier: 3, reason: 'engagement', confidence: 0.7 });
      });

      await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
          subject: 'Invoice from alice@example.com',
          body: 'Call me at 555-123-4567 about the payment',
          timestamp: Date.now(),
        }),
      );

      // PII should be scrubbed: email and phone replaced with tokens
      expect(receivedPrompt).not.toContain('alice@example.com');
      expect(receivedPrompt).not.toContain('555-123-4567');
      expect(receivedPrompt).toContain('[EMAIL_1]');
      expect(receivedPrompt).toContain('[PHONE_1]');
    });

    it('preserves source and type (non-PII metadata) in LLM prompt', async () => {
      let receivedPrompt = '';
      registerSilenceClassifier(async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ tier: 3, reason: 'engagement', confidence: 0.7 });
      });

      await classifyPriority(
        makeEvent({
          source: 'gmail',
          type: 'email',
          subject: 'Hello',
          body: 'Just checking in',
          timestamp: Date.now(),
        }),
      );

      // Source and type are system metadata — NOT scrubbed
      expect(receivedPrompt).toContain('gmail');
      expect(receivedPrompt).toContain('email');
    });
  });
});
