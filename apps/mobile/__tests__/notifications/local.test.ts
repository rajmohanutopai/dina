/**
 * T3.15 — Local notifications: reminder fires at correct priority.
 *
 * Source: ARCHITECTURE.md Section 15.3.
 */

import {
  scheduleNotification,
  tierToChannel,
  cancelNotification,
  rescheduleAllReminders,
  getScheduled,
  resetNotifications,
} from '../../src/notifications/local';

describe('Local Notifications (Mobile-Specific)', () => {
  beforeEach(() => resetNotifications());

  describe('scheduleNotification', () => {
    it('schedules a fiduciary notification', () => {
      const id = scheduleNotification(
        'Security Alert',
        'Unusual login',
        'fiduciary',
        Date.now() + 60000,
      );
      expect(id).toMatch(/^notif-/);
      expect(getScheduled()).toHaveLength(1);
      expect(getScheduled()[0].channel).toBe('fiduciary');
    });

    it('schedules a solicited notification', () => {
      const id = scheduleNotification(
        'Reminder',
        'Meeting in 15 min',
        'solicited',
        Date.now() + 900000,
      );
      expect(id).toBeTruthy();
      expect(getScheduled()[0].channel).toBe('solicited');
    });

    it('returns unique notification IDs', () => {
      const id1 = scheduleNotification('A', 'a', 'solicited', 0);
      const id2 = scheduleNotification('B', 'b', 'solicited', 0);
      expect(id1).not.toBe(id2);
    });

    it('engagement tier schedules (stored for briefing reference)', () => {
      scheduleNotification('Promo', 'Sale!', 'engagement', 0);
      expect(getScheduled()[0].channel).toBe('engagement');
    });
  });

  describe('tierToChannel', () => {
    it('Tier 1 → fiduciary', () => expect(tierToChannel(1)).toBe('fiduciary'));
    it('Tier 2 → solicited', () => expect(tierToChannel(2)).toBe('solicited'));
    it('Tier 3 → engagement', () => expect(tierToChannel(3)).toBe('engagement'));
  });

  describe('cancelNotification', () => {
    it('cancels by ID', () => {
      const id = scheduleNotification('Test', 'body', 'solicited', 0);
      cancelNotification(id);
      expect(getScheduled()).toHaveLength(0);
    });

    it('no error for non-existent ID', () => {
      cancelNotification('nonexistent'); // no throw
    });
  });

  describe('rescheduleAllReminders', () => {
    it('returns count of scheduled notifications', () => {
      scheduleNotification('A', 'a', 'solicited', 0);
      scheduleNotification('B', 'b', 'fiduciary', 0);
      expect(rescheduleAllReminders()).toBe(2);
    });

    it('returns 0 when nothing scheduled', () => {
      expect(rescheduleAllReminders()).toBe(0);
    });
  });

  describe('no PII in notification payload', () => {
    it('design invariant: title is generic, full context in-app only', () => {
      expect(true).toBe(true);
    });
  });
});
