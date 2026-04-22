/**
 * T7.6 — Living window: zone-based data lifecycle.
 *
 * Zone 1 (0-365d): sync + index. Zone 2 (>365d): pass-through only.
 *
 * Source: ARCHITECTURE.md Task 7.6
 */

import {
  classifyZone,
  getZone1Boundary,
  partitionByZone,
  getSyncStrategy,
  shouldIndex,
  needsPassThrough,
  getAgedOutItems,
} from '../../src/sync/living_window';

const MS_PER_DAY = 86_400_000;
const NOW = Date.now();

function daysAgo(days: number): number {
  return NOW - days * MS_PER_DAY;
}

describe('Living Window', () => {
  describe('classifyZone', () => {
    it('classifies recent item as Zone 1', () => {
      const result = classifyZone(daysAgo(30), { nowMs: NOW });
      expect(result.zone).toBe(1);
      expect(result.ageInDays).toBe(30);
      expect(result.isIndexable).toBe(true);
      expect(result.isSyncTarget).toBe(true);
      expect(result.isPassThrough).toBe(false);
    });

    it('classifies year-old item as Zone 1 (boundary)', () => {
      const result = classifyZone(daysAgo(364), { nowMs: NOW });
      expect(result.zone).toBe(1);
    });

    it('classifies 366-day-old item as Zone 2', () => {
      const result = classifyZone(daysAgo(366), { nowMs: NOW });
      expect(result.zone).toBe(2);
      expect(result.isIndexable).toBe(false);
      expect(result.isSyncTarget).toBe(false);
      expect(result.isPassThrough).toBe(true);
    });

    it('classifies 2-year-old item as Zone 2', () => {
      const result = classifyZone(daysAgo(730), { nowMs: NOW });
      expect(result.zone).toBe(2);
      expect(result.ageInDays).toBe(730);
    });

    it('classifies today item as Zone 1 with 0 age', () => {
      const result = classifyZone(NOW, { nowMs: NOW });
      expect(result.zone).toBe(1);
      expect(result.ageInDays).toBe(0);
    });

    it('respects custom zone1Days', () => {
      // 90-day window
      const recent = classifyZone(daysAgo(80), { nowMs: NOW, zone1Days: 90 });
      expect(recent.zone).toBe(1);

      const old = classifyZone(daysAgo(100), { nowMs: NOW, zone1Days: 90 });
      expect(old.zone).toBe(2);
    });
  });

  describe('getZone1Boundary', () => {
    it('returns timestamp 365 days ago by default', () => {
      const boundary = getZone1Boundary({ nowMs: NOW });
      const expectedDaysAgo = Math.round((NOW - boundary) / MS_PER_DAY);
      expect(expectedDaysAgo).toBe(365);
    });

    it('respects custom zone1Days', () => {
      const boundary = getZone1Boundary({ nowMs: NOW, zone1Days: 90 });
      const daysAgo = Math.round((NOW - boundary) / MS_PER_DAY);
      expect(daysAgo).toBe(90);
    });
  });

  describe('partitionByZone', () => {
    it('partitions items into Zone 1 and Zone 2', () => {
      const items = [
        { id: 'recent', timestamp: daysAgo(10) },
        { id: 'mid', timestamp: daysAgo(200) },
        { id: 'old', timestamp: daysAgo(400) },
        { id: 'ancient', timestamp: daysAgo(1000) },
      ];

      const { zone1, zone2 } = partitionByZone(items, { nowMs: NOW });

      expect(zone1.map((i) => i.id)).toEqual(['recent', 'mid']);
      expect(zone2.map((i) => i.id)).toEqual(['old', 'ancient']);
    });

    it('handles empty array', () => {
      const { zone1, zone2 } = partitionByZone([], { nowMs: NOW });
      expect(zone1).toHaveLength(0);
      expect(zone2).toHaveLength(0);
    });

    it('handles all items in Zone 1', () => {
      const items = [
        { id: 'a', timestamp: daysAgo(1) },
        { id: 'b', timestamp: daysAgo(100) },
      ];

      const { zone1, zone2 } = partitionByZone(items, { nowMs: NOW });
      expect(zone1).toHaveLength(2);
      expect(zone2).toHaveLength(0);
    });

    it('handles all items in Zone 2', () => {
      const items = [
        { id: 'a', timestamp: daysAgo(500) },
        { id: 'b', timestamp: daysAgo(700) },
      ];

      const { zone1, zone2 } = partitionByZone(items, { nowMs: NOW });
      expect(zone1).toHaveLength(0);
      expect(zone2).toHaveLength(2);
    });
  });

  describe('getSyncStrategy', () => {
    it('returns sync_and_index for recent range', () => {
      const result = getSyncStrategy(daysAgo(30), NOW, { nowMs: NOW });
      expect(result.strategy).toBe('sync_and_index');
    });

    it('returns pass_through for old range', () => {
      const result = getSyncStrategy(daysAgo(500), daysAgo(400), { nowMs: NOW });
      expect(result.strategy).toBe('pass_through');
    });

    it('returns mixed for range spanning both zones', () => {
      const result = getSyncStrategy(daysAgo(400), daysAgo(100), { nowMs: NOW });
      expect(result.strategy).toBe('mixed');
    });

    it('includes zone1Cutoff in result', () => {
      const result = getSyncStrategy(daysAgo(10), NOW, { nowMs: NOW });
      expect(result.zone1Cutoff).toBe(getZone1Boundary({ nowMs: NOW }));
    });
  });

  describe('shouldIndex', () => {
    it('returns true for Zone 1 items', () => {
      expect(shouldIndex(daysAgo(30), { nowMs: NOW })).toBe(true);
    });

    it('returns false for Zone 2 items', () => {
      expect(shouldIndex(daysAgo(400), { nowMs: NOW })).toBe(false);
    });
  });

  describe('needsPassThrough', () => {
    it('returns true when query starts in Zone 2', () => {
      expect(needsPassThrough(daysAgo(500), { nowMs: NOW })).toBe(true);
    });

    it('returns false when query starts in Zone 1', () => {
      expect(needsPassThrough(daysAgo(30), { nowMs: NOW })).toBe(false);
    });
  });

  describe('getAgedOutItems', () => {
    it('returns items that have aged out of Zone 1', () => {
      const items = [
        { id: 'young', timestamp: daysAgo(30) },
        { id: 'old', timestamp: daysAgo(400) },
        { id: 'ancient', timestamp: daysAgo(1000) },
      ];

      const aged = getAgedOutItems(items, { nowMs: NOW });
      expect(aged.map((i) => i.id)).toEqual(['old', 'ancient']);
    });

    it('returns empty when nothing aged out', () => {
      const items = [{ id: 'a', timestamp: daysAgo(10) }];
      expect(getAgedOutItems(items, { nowMs: NOW })).toHaveLength(0);
    });
  });
});
