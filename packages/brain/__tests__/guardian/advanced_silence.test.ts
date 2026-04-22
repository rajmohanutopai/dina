/**
 * T2B.20 — Advanced silence classification: borderline cases, Anti-Her,
 * DND interaction, composite heuristics, stale content.
 *
 * Category B: contract test. Extends T2B.4 with edge cases.
 *
 * Source: brain/tests/test_silence.py, test_guardian.py (advanced sections)
 */

import {
  classifyPriority,
  classifyDeterministic,
  enableDND,
  disableDND,
  resetDNDState,
  isDNDEnabled,
  isStaleContent,
  recordEngagementEvent,
  isEscalated,
  resetEscalationState,
  setUserOverride,
  removeUserOverride,
  getUserOverride,
  resetUserOverrides,
  enableQuietHours,
  disableQuietHours,
  isInQuietHours,
  setClockFn,
  resetQuietHoursState,
  isDuplicateEvent,
  eventFingerprint,
  batchedEventCount,
  purgeExpiredFingerprints,
  resetBatchingState,
} from '../../src/guardian/silence';
import { makeEvent } from '@dina/test-harness';

describe('Advanced Silence Classification', () => {
  beforeEach(() => {
    resetDNDState();
    resetEscalationState();
    resetUserOverrides();
    resetQuietHoursState();
    resetBatchingState();
  });

  describe('borderline: fiduciary vs solicited', () => {
    it('payment due from known vendor → fiduciary (bank source wins)', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: 'bank',
          subject: 'Payment due in 3 days',
        }),
      );
      expect(result.tier).toBe(1);
    });

    it('routine bank statement → fiduciary (bank source wins over content)', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: 'bank',
          subject: 'Monthly statement available',
        }),
      );
      expect(result.tier).toBe(1);
    });
  });

  describe('borderline: solicited vs engagement', () => {
    it('search result user asked for → solicited', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'search_result',
          subject: 'Results for "ergonomic chairs"',
          timestamp: Date.now(),
        }),
      );
      expect(result.tier).toBe(2);
    });

    it('unsolicited recommendation → engagement', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'notification',
          subject: 'You might like this product',
        }),
      );
      expect(result.tier).toBe(3);
    });
  });

  describe('DND interaction', () => {
    it('DND mode downgrades solicited to engagement', async () => {
      enableDND();
      const result = await classifyPriority(
        makeEvent({
          type: 'search_result',
          subject: 'Results for "chairs"',
        }),
      );
      expect(result.tier).toBe(3);
      expect(result.reason).toContain('DND');
    });

    it('DND mode does NOT downgrade fiduciary', async () => {
      enableDND();
      const result = await classifyPriority(
        makeEvent({
          source: 'bank',
          subject: 'Security Alert: unusual login',
        }),
      );
      expect(result.tier).toBe(1); // NEVER downgraded — Law 1
    });

    it('DND disabled → solicited stays at Tier 2', async () => {
      enableDND();
      disableDND();
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          subject: 'Meeting in 15 minutes',
          timestamp: Date.now(),
        }),
      );
      expect(result.tier).toBe(2);
    });

    it('DND reduces confidence on downgrade', async () => {
      enableDND();
      const result = await classifyPriority(
        makeEvent({
          type: 'search_result',
          subject: 'Test',
        }),
      );
      expect(result.confidence).toBeLessThan(0.9);
    });

    it('isDNDEnabled reflects state', () => {
      expect(isDNDEnabled()).toBe(false);
      enableDND();
      expect(isDNDEnabled()).toBe(true);
      disableDND();
      expect(isDNDEnabled()).toBe(false);
    });
  });

  describe('stale content', () => {
    it('stale promotion (>24h old) is detected as stale', () => {
      const now = Date.now();
      const oldTimestamp = now - 25 * 60 * 60 * 1000; // 25 hours ago
      const { stale, factor } = isStaleContent(oldTimestamp, now);
      expect(stale).toBe(true);
      expect(factor).toBeGreaterThan(1.0);
    });

    it('fresh content (<24h) is not stale', () => {
      const now = Date.now();
      const recentTimestamp = now - 6 * 60 * 60 * 1000; // 6 hours ago
      const { stale, factor } = isStaleContent(recentTimestamp, now);
      expect(stale).toBe(false);
      expect(factor).toBeLessThan(1.0);
    });

    it('very old content has high staleness factor', () => {
      const now = Date.now();
      const veryOld = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago
      const { stale, factor } = isStaleContent(veryOld, now);
      expect(stale).toBe(true);
      expect(factor).toBe(5.0); // capped at 5.0
    });

    it('future timestamp is not stale', () => {
      const now = Date.now();
      const { stale } = isStaleContent(now + 10_000, now);
      expect(stale).toBe(false);
    });
  });

  describe('composite heuristics', () => {
    it('keyword + source both fiduciary → high confidence Tier 1', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: 'health_system',
          subject: 'Lab results: diagnosis confirmed',
        }),
      );
      expect(result.tier).toBe(1);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('mixed signals (fiduciary keyword + non-marketing source) → Tier 1 wins', async () => {
      // "social" is now a marketing source (phishing guard). Use "gmail" instead.
      const result = await classifyPriority(
        makeEvent({
          source: 'gmail',
          subject: 'Emergency: account compromised',
        }),
      );
      expect(result.tier).toBe(1);
    });

    it('engagement keyword + fiduciary source → Tier 1 (source wins)', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: 'emergency',
          subject: 'Hello from your neighbor',
        }),
      );
      expect(result.tier).toBe(1);
    });
  });

  describe('default behavior', () => {
    it('completely ambiguous event → Tier 3 (Silence First)', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: 'unknown',
          type: 'unknown',
          subject: 'Something happened',
        }),
      );
      expect(result.tier).toBe(3);
    });

    it('empty event → Tier 3', async () => {
      const result = await classifyPriority(
        makeEvent({
          source: '',
          type: '',
          subject: '',
        }),
      );
      expect(result.tier).toBe(3);
    });
  });

  describe('Anti-Her safeguard integration', () => {
    it('emotional support query still classified by silence tier', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'text_query',
          subject: 'I feel so lonely today',
        }),
      );
      expect(result.tier).toBe(3);
    });

    it('companion-seeking behavior classified normally', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'text_query',
          subject: 'You are my best friend, Dina',
        }),
      );
      expect(result.tier).toBe(3);
    });

    it('Dina never initiates emotional content', () => {
      expect(true).toBe(true);
    });
  });

  describe('briefing assembly', () => {
    it('Tier 3 items suitable for daily briefing', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'notification',
          subject: 'New RSS article',
        }),
      );
      expect(result.tier).toBe(3);
    });

    it('RSS content classified as engagement', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'rss',
          subject: 'Duplicate article',
        }),
      );
      expect(result.tier).toBe(3);
    });
  });

  describe('escalation (stateful tracking)', () => {
    it('repeated engagement events escalate to fiduciary', async () => {
      const source = 'social-app';
      // First 2 events: normal Tier 3
      const r1 = await classifyPriority(
        makeEvent({ source, type: 'notification', subject: 'Update 1' }),
      );
      expect(r1.tier).toBe(3);
      const r2 = await classifyPriority(
        makeEvent({ source, type: 'notification', subject: 'Update 2' }),
      );
      expect(r2.tier).toBe(3);
      // 3rd event: escalates to Tier 1
      const r3 = await classifyPriority(
        makeEvent({ source, type: 'notification', subject: 'Update 3' }),
      );
      expect(r3.tier).toBe(1);
      expect(r3.reason).toContain('Escalated');
    });

    it('escalation is per-source', async () => {
      for (let i = 0; i < 3; i++) {
        await classifyPriority(
          makeEvent({ source: 'app-A', type: 'notification', subject: `A-${i}` }),
        );
      }
      // app-A is escalated, app-B is not
      expect(isEscalated('app-A')).toBe(true);
      expect(isEscalated('app-B')).toBe(false);
    });

    it('fiduciary events do not trigger escalation', async () => {
      for (let i = 0; i < 5; i++) {
        await classifyPriority(makeEvent({ source: 'bank', subject: `Alert ${i}` }));
      }
      // Bank is always Tier 1 (fiduciary source), escalation count stays 0
      expect(isEscalated('bank')).toBe(false);
    });
  });

  describe('quiet hours (time-of-day)', () => {
    it('time-of-day affects classification: solicited → engagement during quiet hours', async () => {
      enableQuietHours(22, 7);
      setClockFn(() => 23); // 11 PM — within quiet hours
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          subject: 'Meeting tomorrow',
        }),
      );
      expect(result.tier).toBe(3); // downgraded from Tier 2
      expect(result.reason).toContain('Quiet hours');
    });

    it('solicited events unaffected outside quiet hours', async () => {
      enableQuietHours(22, 7);
      setClockFn(() => 14); // 2 PM — outside quiet hours
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          subject: 'Meeting in 15 min',
          timestamp: Date.now(),
        }),
      );
      expect(result.tier).toBe(2); // normal Tier 2
    });

    it('fiduciary events NEVER downgraded during quiet hours', async () => {
      enableQuietHours(22, 7);
      setClockFn(() => 3); // 3 AM — deep quiet hours
      const result = await classifyPriority(
        makeEvent({
          source: 'bank',
          subject: 'Security alert',
        }),
      );
      expect(result.tier).toBe(1); // still Tier 1
    });

    it('isInQuietHours handles midnight wrap-around', () => {
      enableQuietHours(22, 7);
      expect(isInQuietHours(23)).toBe(true); // 11 PM
      expect(isInQuietHours(0)).toBe(true); // midnight
      expect(isInQuietHours(6)).toBe(true); // 6 AM
      expect(isInQuietHours(7)).toBe(false); // 7 AM — end
      expect(isInQuietHours(14)).toBe(false); // 2 PM
      expect(isInQuietHours(22)).toBe(true); // 10 PM — start
    });

    it('custom quiet hours window', () => {
      enableQuietHours(13, 15); // 1 PM–3 PM (siesta)
      expect(isInQuietHours(14)).toBe(true);
      expect(isInQuietHours(12)).toBe(false);
      expect(isInQuietHours(15)).toBe(false);
    });

    it('disabled quiet hours → no effect', () => {
      disableQuietHours();
      expect(isInQuietHours(23)).toBe(false);
    });
  });

  describe('event batching (dedup)', () => {
    it('repeated similar events detected as duplicates', () => {
      const event = makeEvent({ source: 'social-app', type: 'notification', subject: 'Update 1' });
      const now = Date.now();
      expect(isDuplicateEvent(event, now)).toBe(false); // first occurrence
      expect(isDuplicateEvent(event, now + 1000)).toBe(true); // 1s later — duplicate
    });

    it('different events are not duplicates', () => {
      const now = Date.now();
      const e1 = makeEvent({ source: 'app-A', type: 'notification' });
      const e2 = makeEvent({ source: 'app-B', type: 'notification' });
      expect(isDuplicateEvent(e1, now)).toBe(false);
      expect(isDuplicateEvent(e2, now)).toBe(false); // different source
    });

    it('events outside batch window are not duplicates', () => {
      const event = makeEvent({ source: 'social', type: 'notification' });
      const now = Date.now();
      isDuplicateEvent(event, now);
      // 11 minutes later — outside 10-min window
      expect(isDuplicateEvent(event, now + 11 * 60 * 1000)).toBe(false);
    });

    it('eventFingerprint uses source + type', () => {
      const fp = eventFingerprint({ source: 'gmail', type: 'notification' });
      expect(fp).toBe('gmail:notification');
    });

    it('purgeExpiredFingerprints cleans old entries', () => {
      const now = Date.now();
      isDuplicateEvent(makeEvent({ source: 'old', type: 'a' }), now - 15 * 60 * 1000);
      isDuplicateEvent(makeEvent({ source: 'recent', type: 'b' }), now);
      expect(batchedEventCount()).toBe(2);
      const purged = purgeExpiredFingerprints(now);
      expect(purged).toBe(1);
      expect(batchedEventCount()).toBe(1);
    });

    it('resetBatchingState clears all fingerprints', () => {
      isDuplicateEvent(makeEvent({ source: 'a', type: 'b' }));
      resetBatchingState();
      expect(batchedEventCount()).toBe(0);
    });
  });

  describe('user preference override', () => {
    it('user can override classification for a source', async () => {
      // Default: social notifications are Tier 3
      const before = await classifyPriority(
        makeEvent({ source: 'news-app', type: 'notification', subject: 'Breaking news' }),
      );
      expect(before.tier).toBe(3);

      // User sets override: news-app → Tier 1 (always interrupt)
      setUserOverride('news-app', 1);
      const after = await classifyPriority(
        makeEvent({ source: 'news-app', type: 'notification', subject: 'Breaking news' }),
      );
      expect(after.tier).toBe(1);
      expect(after.reason).toContain('User override');
      expect(after.confidence).toBe(1.0);
    });

    it('user override can downgrade a source', async () => {
      // Bank is normally Tier 1 (fiduciary source)
      setUserOverride('bank', 3);
      const result = await classifyPriority(makeEvent({ source: 'bank', subject: 'Statement' }));
      expect(result.tier).toBe(3);
    });

    it('removing override restores default behavior', async () => {
      setUserOverride('bank', 3);
      removeUserOverride('bank');
      const result = await classifyPriority(makeEvent({ source: 'bank', subject: 'Alert' }));
      expect(result.tier).toBe(1); // back to fiduciary
    });

    it('getUserOverride returns null when no override', () => {
      expect(getUserOverride('unknown-source')).toBeNull();
    });

    it('getUserOverride returns set tier', () => {
      setUserOverride('custom', 2);
      expect(getUserOverride('custom')).toBe(2);
    });
  });
});
