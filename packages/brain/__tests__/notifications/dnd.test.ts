/**
 * DND policy unit tests (task 5.69).
 *
 * Pins the three-tier invariant matrix:
 *   - Tier 1 always delivers (fiduciary safety contract — see 5.49)
 *   - Tier 2 honours quiet hours
 *   - Tier 3 honours both `muteEngagement` and quiet hours
 *
 * Plus the time-window math (`isInQuietHours`) and the partial-merge
 * setter contract.
 */

import {
  DEFAULT_DND_STATE,
  getDND,
  isInQuietHours,
  isValidHHMM,
  parseHHMM,
  resetDND,
  setDND,
  shouldDeliverNotification,
} from '../../src/notifications/dnd';

describe('DND policy (5.69)', () => {
  beforeEach(() => {
    resetDND();
  });

  describe('Tier 1 invariant — fiduciary always delivers', () => {
    it('Tier 1 fires even with the strictest settings (24/7 quiet hours + muteEngagement)', () => {
      setDND({
        muteEngagement: true,
        quietHoursStart: '00:00',
        quietHoursEnd: '23:59',
      });
      // Mid-quiet-hours timestamp.
      const now = new Date(2026, 0, 1, 3, 0); // 03:00 local
      expect(shouldDeliverNotification(1, now)).toBe(true);
    });

    it('Tier 1 fires regardless of muteEngagement', () => {
      setDND({ muteEngagement: true });
      const now = new Date(2026, 0, 1, 12, 0); // mid-day
      expect(shouldDeliverNotification(1, now)).toBe(true);
    });
  });

  describe('Tier 2 — solicited honours quiet hours', () => {
    it('delivers outside quiet hours (default 22:00-07:00)', () => {
      const noon = new Date(2026, 0, 1, 12, 0);
      expect(shouldDeliverNotification(2, noon)).toBe(true);
    });

    it('suppresses during quiet hours (after 22:00)', () => {
      const lateNight = new Date(2026, 0, 1, 23, 30);
      expect(shouldDeliverNotification(2, lateNight)).toBe(false);
    });

    it('suppresses during quiet hours (before 07:00)', () => {
      const earlyMorning = new Date(2026, 0, 1, 3, 0);
      expect(shouldDeliverNotification(2, earlyMorning)).toBe(false);
    });

    it('does NOT honour muteEngagement (only Tier 3 cares about that)', () => {
      setDND({ muteEngagement: true, quietHoursStart: '00:00', quietHoursEnd: '00:00' });
      const noon = new Date(2026, 0, 1, 12, 0);
      expect(shouldDeliverNotification(2, noon)).toBe(true);
    });
  });

  describe('Tier 3 — engagement honours both gates', () => {
    it('default state suppresses all Tier 3 (muteEngagement default true)', () => {
      const noon = new Date(2026, 0, 1, 12, 0);
      expect(shouldDeliverNotification(3, noon)).toBe(false);
    });

    it('with muteEngagement=false, delivers outside quiet hours', () => {
      setDND({ muteEngagement: false });
      const noon = new Date(2026, 0, 1, 12, 0);
      expect(shouldDeliverNotification(3, noon)).toBe(true);
    });

    it('with muteEngagement=false, still suppresses during quiet hours', () => {
      setDND({ muteEngagement: false });
      const lateNight = new Date(2026, 0, 1, 23, 30);
      expect(shouldDeliverNotification(3, lateNight)).toBe(false);
    });
  });

  describe('setDND partial-merge', () => {
    it('changes only the fields supplied', () => {
      setDND({ muteEngagement: false });
      const s = getDND();
      expect(s.muteEngagement).toBe(false);
      expect(s.quietHoursStart).toBe(DEFAULT_DND_STATE.quietHoursStart);
      expect(s.quietHoursEnd).toBe(DEFAULT_DND_STATE.quietHoursEnd);
    });

    it('rejects invalid HH:MM formats', () => {
      expect(() => setDND({ quietHoursStart: '25:00' })).toThrow('quietHoursStart');
      expect(() => setDND({ quietHoursEnd: '7:00' })).toThrow('quietHoursEnd'); // missing leading zero
      expect(() => setDND({ quietHoursStart: 'abc' })).toThrow('quietHoursStart');
    });

    it('returns the new state', () => {
      const next = setDND({ muteEngagement: false });
      expect(next.muteEngagement).toBe(false);
    });
  });

  describe('time-window math', () => {
    it('isValidHHMM accepts canonical formats', () => {
      expect(isValidHHMM('00:00')).toBe(true);
      expect(isValidHHMM('23:59')).toBe(true);
      expect(isValidHHMM('07:00')).toBe(true);
    });

    it('isValidHHMM rejects malformed inputs', () => {
      expect(isValidHHMM('24:00')).toBe(false);
      expect(isValidHHMM('07:60')).toBe(false);
      expect(isValidHHMM('7:00')).toBe(false);
      expect(isValidHHMM('')).toBe(false);
    });

    it('parseHHMM converts to total minutes', () => {
      expect(parseHHMM('00:00')).toBe(0);
      expect(parseHHMM('07:30')).toBe(7 * 60 + 30);
      expect(parseHHMM('23:59')).toBe(23 * 60 + 59);
    });

    it('isInQuietHours: simple in-day window', () => {
      const at = (h: number, m: number = 0) => new Date(2026, 0, 1, h, m);
      // Window 09:00–17:00.
      expect(isInQuietHours('09:00', '17:00', at(8, 59))).toBe(false);
      expect(isInQuietHours('09:00', '17:00', at(9, 0))).toBe(true); // inclusive start
      expect(isInQuietHours('09:00', '17:00', at(12, 0))).toBe(true);
      expect(isInQuietHours('09:00', '17:00', at(16, 59))).toBe(true);
      expect(isInQuietHours('09:00', '17:00', at(17, 0))).toBe(false); // exclusive end
    });

    it('isInQuietHours: wraps-midnight window (default 22:00–07:00)', () => {
      const at = (h: number, m: number = 0) => new Date(2026, 0, 1, h, m);
      expect(isInQuietHours('22:00', '07:00', at(21, 59))).toBe(false);
      expect(isInQuietHours('22:00', '07:00', at(22, 0))).toBe(true);
      expect(isInQuietHours('22:00', '07:00', at(23, 30))).toBe(true);
      expect(isInQuietHours('22:00', '07:00', at(0, 0))).toBe(true);
      expect(isInQuietHours('22:00', '07:00', at(6, 59))).toBe(true);
      expect(isInQuietHours('22:00', '07:00', at(7, 0))).toBe(false); // exclusive end
      expect(isInQuietHours('22:00', '07:00', at(12, 0))).toBe(false);
    });

    it('isInQuietHours: empty window when start === end', () => {
      const at = (h: number, m: number = 0) => new Date(2026, 0, 1, h, m);
      expect(isInQuietHours('00:00', '00:00', at(0, 0))).toBe(false);
      expect(isInQuietHours('12:00', '12:00', at(12, 0))).toBe(false);
    });
  });

  describe('resetDND', () => {
    it('returns state to defaults', () => {
      setDND({ muteEngagement: false, quietHoursStart: '08:00', quietHoursEnd: '20:00' });
      resetDND();
      expect(getDND()).toEqual(DEFAULT_DND_STATE);
    });
  });
});
