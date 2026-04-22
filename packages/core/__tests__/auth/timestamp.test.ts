/**
 * T1B.2 — RFC3339 timestamp validation for request auth.
 *
 * Category A: fixture-based. Verifies 5-minute window enforcement,
 * RFC3339 parsing, and edge cases.
 *
 * Source: core/test/auth_test.go (timestamp validation)
 */

import {
  isTimestampValid,
  parseRFC3339,
  toRFC3339,
  TIMESTAMP_WINDOW_SECONDS,
} from '../../src/auth/timestamp';

describe('RFC3339 Timestamp Validation', () => {
  describe('TIMESTAMP_WINDOW_SECONDS', () => {
    it('is 300 seconds (5 minutes)', () => {
      expect(TIMESTAMP_WINDOW_SECONDS).toBe(300);
    });
  });

  describe('isTimestampValid', () => {
    const now = new Date('2026-04-09T12:00:00Z');

    it('accepts timestamp at current time', () => {
      expect(isTimestampValid('2026-04-09T12:00:00Z', now)).toBe(true);
    });

    it('accepts timestamp 4 minutes in the past', () => {
      const laterNow = new Date('2026-04-09T12:04:00Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', laterNow)).toBe(true);
    });

    it('rejects timestamp 6 minutes in the past', () => {
      const laterNow = new Date('2026-04-09T12:06:00Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', laterNow)).toBe(false);
    });

    it('accepts timestamp 4 minutes in the future', () => {
      const earlierNow = new Date('2026-04-09T11:56:00Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', earlierNow)).toBe(true);
    });

    it('rejects timestamp 6 minutes in the future', () => {
      const earlierNow = new Date('2026-04-09T11:54:00Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', earlierNow)).toBe(false);
    });

    it('accepts timestamp exactly at window boundary (5 min)', () => {
      const boundaryNow = new Date('2026-04-09T12:05:00Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', boundaryNow)).toBe(true);
    });

    it('rejects timestamp 1 second past window', () => {
      const pastBoundary = new Date('2026-04-09T12:05:01Z');
      expect(isTimestampValid('2026-04-09T12:00:00Z', pastBoundary)).toBe(false);
    });

    it('uses current time when now is not provided', () => {
      const recent = toRFC3339(new Date());
      expect(isTimestampValid(recent)).toBe(true);
    });
  });

  describe('parseRFC3339', () => {
    it('parses valid UTC timestamp', () => {
      const date = parseRFC3339('2026-04-09T12:00:00Z');
      expect(date.toISOString()).toContain('2026-04-09T12:00:00');
    });

    it('parses timestamp with timezone offset', () => {
      const date = parseRFC3339('2026-04-09T17:30:00+05:30');
      // +05:30 → UTC 12:00:00
      expect(date.getUTCHours()).toBe(12);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('parses timestamp with fractional seconds', () => {
      const date = parseRFC3339('2026-04-09T12:00:00.123Z');
      expect(date.getUTCMilliseconds()).toBe(123);
    });

    it('rejects non-RFC3339 format', () => {
      expect(() => parseRFC3339('April 9, 2026')).toThrow('invalid RFC3339');
    });

    it('rejects Unix timestamp string', () => {
      expect(() => parseRFC3339('1712678400')).toThrow('invalid RFC3339');
    });

    it('rejects empty string', () => {
      expect(() => parseRFC3339('')).toThrow('empty string');
    });

    it('rejects date without time', () => {
      expect(() => parseRFC3339('2026-04-09')).toThrow('invalid RFC3339');
    });

    it('rejects timestamp without timezone', () => {
      expect(() => parseRFC3339('2026-04-09T12:00:00')).toThrow('invalid RFC3339');
    });
  });

  describe('toRFC3339', () => {
    it('formats Date as RFC3339 string', () => {
      const date = new Date('2026-04-09T12:00:00Z');
      expect(toRFC3339(date)).toBe('2026-04-09T12:00:00Z');
    });

    it('produces UTC timezone (Z suffix)', () => {
      const result = toRFC3339(new Date());
      expect(result).toMatch(/Z$/);
    });

    it('strips milliseconds', () => {
      const date = new Date('2026-04-09T12:00:00.123Z');
      expect(toRFC3339(date)).toBe('2026-04-09T12:00:00Z');
    });

    it('round-trips with parseRFC3339', () => {
      const original = new Date('2026-04-09T12:00:00Z');
      const str = toRFC3339(original);
      const parsed = parseRFC3339(str);
      expect(parsed.getTime()).toBe(original.getTime());
    });
  });
});
