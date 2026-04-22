/**
 * T7.5 — Sync rhythm: morning full / hourly incremental / on-demand.
 *
 * Source: ARCHITECTURE.md Task 7.5
 */

import {
  decideSyncMode,
  triggerOnDemand,
  recordSyncComplete,
  getCursor,
  getSourceState,
  setMorningSyncHour,
  getMorningSyncHour,
  resetRhythmState,
} from '../../src/sync/rhythm';

describe('Sync Rhythm Scheduler', () => {
  beforeEach(() => resetRhythmState());

  describe('decideSyncMode', () => {
    it('morning sync triggers at configured hour when not done today', () => {
      setMorningSyncHour(6);
      const schedule = decideSyncMode('gmail', 6);
      expect(schedule.mode).toBe('morning');
      expect(schedule.lookbackDays).toBe(30);
    });

    it('morning sync does NOT trigger at other hours', () => {
      setMorningSyncHour(6);
      const schedule = decideSyncMode('gmail', 14);
      expect(schedule.mode).not.toBe('morning');
    });

    it('morning sync does NOT trigger if already done today', () => {
      setMorningSyncHour(6);
      const now = Date.now();
      recordSyncComplete('gmail', 'morning', 'cursor-1', now);
      const schedule = decideSyncMode('gmail', 6, now + 1000);
      expect(schedule.mode).not.toBe('morning');
    });

    it('hourly incremental triggers after 1 hour since last sync', () => {
      const now = Date.now();
      recordSyncComplete('gmail', 'hourly', 'c1', now);
      const oneHourLater = now + 60 * 60 * 1000;
      const schedule = decideSyncMode('gmail', 14, oneHourLater);
      expect(schedule.mode).toBe('hourly');
      expect(schedule.cursor).toBe('c1');
    });

    it('hourly incremental does NOT trigger within the hour', () => {
      const now = Date.now();
      recordSyncComplete('gmail', 'hourly', 'c1', now);
      const thirtyMinLater = now + 30 * 60 * 1000;
      const schedule = decideSyncMode('gmail', 14, thirtyMinLater);
      expect(schedule.mode).toBe('none');
    });

    it('first ever sync → hourly (no cursor, initial incremental)', () => {
      const schedule = decideSyncMode('gmail', 14);
      expect(schedule.mode).toBe('hourly');
      expect(schedule.cursor).toBeUndefined();
      expect(schedule.reason).toContain('no cursor');
    });

    it('returns none when no sync needed', () => {
      const now = Date.now();
      recordSyncComplete('gmail', 'hourly', 'c1', now);
      const schedule = decideSyncMode('gmail', 14, now + 1000);
      expect(schedule.mode).toBe('none');
    });
  });

  describe('triggerOnDemand', () => {
    it('returns on_demand mode with current cursor', () => {
      recordSyncComplete('gmail', 'hourly', 'cursor-abc');
      const schedule = triggerOnDemand('gmail');
      expect(schedule.mode).toBe('on_demand');
      expect(schedule.cursor).toBe('cursor-abc');
      expect(schedule.reason).toContain('manual');
    });

    it('works without prior cursor', () => {
      const schedule = triggerOnDemand('gmail');
      expect(schedule.mode).toBe('on_demand');
      expect(schedule.cursor).toBeUndefined();
    });
  });

  describe('recordSyncComplete', () => {
    it('updates cursor', () => {
      recordSyncComplete('gmail', 'hourly', 'new-cursor');
      expect(getCursor('gmail')).toBe('new-cursor');
    });

    it('morning sync updates both timestamps', () => {
      const now = Date.now();
      recordSyncComplete('gmail', 'morning', 'c1', now);
      const state = getSourceState('gmail');
      expect(state.lastMorningSync).toBe(now);
      expect(state.lastIncrementalSync).toBe(now);
    });

    it('increments sync count', () => {
      recordSyncComplete('gmail', 'hourly', 'c1');
      recordSyncComplete('gmail', 'hourly', 'c2');
      expect(getSourceState('gmail').syncCount).toBe(2);
    });
  });

  describe('source isolation', () => {
    it('different sources have independent state', () => {
      recordSyncComplete('gmail', 'hourly', 'gmail-cursor');
      recordSyncComplete('calendar', 'hourly', 'cal-cursor');
      expect(getCursor('gmail')).toBe('gmail-cursor');
      expect(getCursor('calendar')).toBe('cal-cursor');
    });
  });

  describe('morningSyncHour', () => {
    it('default is 6 AM', () => {
      expect(getMorningSyncHour()).toBe(6);
    });

    it('configurable', () => {
      setMorningSyncHour(8);
      expect(getMorningSyncHour()).toBe(8);
    });

    it('clamps to [0, 23]', () => {
      setMorningSyncHour(25);
      expect(getMorningSyncHour()).toBe(23);
    });
  });
});
