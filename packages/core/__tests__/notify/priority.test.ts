/**
 * T2A.10 — Notification priority mapping from guardian tiers.
 *
 * Category B: contract test.
 *
 * Source: core/test/notify_test.go
 */

import {
  mapTierToPriority,
  shouldInterrupt,
  shouldDeferToBriefing,
} from '../../src/notify/priority';

describe('Notification Priority', () => {
  describe('mapTierToPriority', () => {
    it('Tier 1 (fiduciary) → high', () => {
      expect(mapTierToPriority(1)).toBe('high');
    });

    it('Tier 2 (solicited) → default', () => {
      expect(mapTierToPriority(2)).toBe('default');
    });

    it('Tier 3 (engagement) → low', () => {
      expect(mapTierToPriority(3)).toBe('low');
    });
  });

  describe('shouldInterrupt', () => {
    it('Tier 1 → true (interrupt user)', () => {
      expect(shouldInterrupt(1)).toBe(true);
    });

    it('Tier 2 → false (notify, do not interrupt)', () => {
      expect(shouldInterrupt(2)).toBe(false);
    });

    it('Tier 3 → false (silent, save for briefing)', () => {
      expect(shouldInterrupt(3)).toBe(false);
    });
  });

  describe('shouldDeferToBriefing', () => {
    it('Tier 1 → false (never defer fiduciary)', () => {
      expect(shouldDeferToBriefing(1)).toBe(false);
    });

    it('Tier 2 → false (deliver when requested)', () => {
      expect(shouldDeferToBriefing(2)).toBe(false);
    });

    it('Tier 3 → true (save for daily briefing)', () => {
      expect(shouldDeferToBriefing(3)).toBe(true);
    });
  });

  describe('consistency across functions', () => {
    it('Tier 1: high priority, interrupt, no briefing', () => {
      expect(mapTierToPriority(1)).toBe('high');
      expect(shouldInterrupt(1)).toBe(true);
      expect(shouldDeferToBriefing(1)).toBe(false);
    });

    it('Tier 2: default priority, no interrupt, no briefing', () => {
      expect(mapTierToPriority(2)).toBe('default');
      expect(shouldInterrupt(2)).toBe(false);
      expect(shouldDeferToBriefing(2)).toBe(false);
    });

    it('Tier 3: low priority, no interrupt, defer to briefing', () => {
      expect(mapTierToPriority(3)).toBe('low');
      expect(shouldInterrupt(3)).toBe(false);
      expect(shouldDeferToBriefing(3)).toBe(true);
    });
  });
});
