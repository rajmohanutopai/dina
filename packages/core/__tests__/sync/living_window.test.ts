/**
 * T7.6 — Living window: zone classification by item age.
 *
 * Source: ARCHITECTURE.md Task 7.6
 */

import {
  classifyZone,
  isInActiveZone,
  isNearBoundary,
  filterActiveZone,
  setBoundaryDays,
  getBoundaryDays,
  resetLivingWindowState,
} from '../../src/sync/living_window';

const MS_DAY = 24 * 60 * 60 * 1000;

describe('Living Window Zone Classification', () => {
  beforeEach(() => resetLivingWindowState());

  describe('classifyZone', () => {
    it('recent item (1 day old) → active zone', () => {
      const now = Date.now();
      const result = classifyZone(now - 1 * MS_DAY, now);
      expect(result.zone).toBe('active');
      expect(result.shouldSync).toBe(true);
      expect(result.shouldIndex).toBe(true);
      expect(result.searchMode).toBe('local');
      expect(result.ageDays).toBe(1);
    });

    it('old item (400 days) → archive zone', () => {
      const now = Date.now();
      const result = classifyZone(now - 400 * MS_DAY, now);
      expect(result.zone).toBe('archive');
      expect(result.shouldSync).toBe(false);
      expect(result.shouldIndex).toBe(false);
      expect(result.searchMode).toBe('pass_through');
    });

    it('item exactly at boundary (365 days) → active zone', () => {
      const now = Date.now();
      const result = classifyZone(now - 365 * MS_DAY, now);
      expect(result.zone).toBe('active');
    });

    it('item just past boundary (366 days) → archive zone', () => {
      const now = Date.now();
      const result = classifyZone(now - 366 * MS_DAY, now);
      expect(result.zone).toBe('archive');
    });

    it('brand new item (0 days) → active zone', () => {
      const now = Date.now();
      const result = classifyZone(now, now);
      expect(result.zone).toBe('active');
      expect(result.ageDays).toBe(0);
      expect(result.nearBoundary).toBe(false);
    });

    it('future item → active zone, age 0', () => {
      const now = Date.now();
      const result = classifyZone(now + MS_DAY, now);
      expect(result.zone).toBe('active');
      expect(result.ageDays).toBe(0);
    });
  });

  describe('near boundary detection', () => {
    it('item 340 days old → near boundary (within 30 days of 365)', () => {
      const now = Date.now();
      const result = classifyZone(now - 340 * MS_DAY, now);
      expect(result.zone).toBe('active');
      expect(result.nearBoundary).toBe(true);
    });

    it('item 300 days old → NOT near boundary', () => {
      const now = Date.now();
      const result = classifyZone(now - 300 * MS_DAY, now);
      expect(result.nearBoundary).toBe(false);
    });

    it('item 335 days old → exactly at near-boundary edge (365-30=335)', () => {
      const now = Date.now();
      const result = classifyZone(now - 335 * MS_DAY, now);
      expect(result.nearBoundary).toBe(true);
    });

    it('archive items are never near-boundary', () => {
      const now = Date.now();
      const result = classifyZone(now - 500 * MS_DAY, now);
      expect(result.nearBoundary).toBe(false);
    });
  });

  describe('isInActiveZone', () => {
    it('recent → true', () => {
      expect(isInActiveZone(Date.now() - 30 * MS_DAY)).toBe(true);
    });

    it('old → false', () => {
      expect(isInActiveZone(Date.now() - 400 * MS_DAY)).toBe(false);
    });
  });

  describe('isNearBoundary', () => {
    it('340 days → true', () => {
      const now = Date.now();
      expect(isNearBoundary(now - 340 * MS_DAY, now)).toBe(true);
    });

    it('100 days → false', () => {
      const now = Date.now();
      expect(isNearBoundary(now - 100 * MS_DAY, now)).toBe(false);
    });
  });

  describe('filterActiveZone', () => {
    it('filters out archive-zone items', () => {
      const now = Date.now();
      const items = [
        { id: 'recent', ts: now - 10 * MS_DAY },
        { id: 'old', ts: now - 400 * MS_DAY },
        { id: 'mid', ts: now - 200 * MS_DAY },
      ];
      const active = filterActiveZone(items, (i) => i.ts, now);
      expect(active).toHaveLength(2);
      expect(active.map((i) => i.id)).toEqual(['recent', 'mid']);
    });

    it('returns empty when all items are archived', () => {
      const now = Date.now();
      const items = [
        { id: 'a', ts: now - 500 * MS_DAY },
        { id: 'b', ts: now - 600 * MS_DAY },
      ];
      expect(filterActiveZone(items, (i) => i.ts, now)).toHaveLength(0);
    });

    it('returns all when all items are active', () => {
      const now = Date.now();
      const items = [
        { id: 'a', ts: now - 10 * MS_DAY },
        { id: 'b', ts: now - 50 * MS_DAY },
      ];
      expect(filterActiveZone(items, (i) => i.ts, now)).toHaveLength(2);
    });
  });

  describe('custom boundary', () => {
    it('setBoundaryDays changes the boundary', () => {
      setBoundaryDays(180);
      expect(getBoundaryDays()).toBe(180);
      const now = Date.now();
      expect(classifyZone(now - 190 * MS_DAY, now).zone).toBe('archive');
      expect(classifyZone(now - 170 * MS_DAY, now).zone).toBe('active');
    });

    it('minimum boundary is 1 day', () => {
      setBoundaryDays(0);
      expect(getBoundaryDays()).toBe(1);
    });
  });
});
