/**
 * Task 4.22 — timestamp window validator tests.
 *
 * Uses an injected `now()` so assertions are deterministic regardless
 * of wall-clock. Covers RFC3339 + epoch-ms parsing, both drift
 * directions, boundary ±5 min, and the full rejection-reason enum.
 */

import {
  validateTimestamp,
  TIMESTAMP_WINDOW_MS,
} from '../src/auth/timestamp_window';

// Anchor the "server clock" at a fixed instant for every test.
const SERVER_NOW_MS = Date.parse('2026-04-21T22:00:00.000Z');
const now = () => SERVER_NOW_MS;

describe('validateTimestamp (task 4.22)', () => {
  describe('accepting valid timestamps', () => {
    it('accepts RFC3339 "now"', () => {
      const res = validateTimestamp('2026-04-21T22:00:00.000Z', { now });
      expect(res).toEqual({ ok: true, timestampMs: SERVER_NOW_MS });
    });

    it('accepts RFC3339 4 minutes in the past', () => {
      const ts = new Date(SERVER_NOW_MS - 4 * 60 * 1000).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(true);
    });

    it('accepts RFC3339 4 minutes in the future (client clock skew)', () => {
      const ts = new Date(SERVER_NOW_MS + 4 * 60 * 1000).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(true);
    });

    it('accepts epoch-ms as string', () => {
      const res = validateTimestamp(String(SERVER_NOW_MS), { now });
      expect(res).toEqual({ ok: true, timestampMs: SERVER_NOW_MS });
    });

    it('accepts epoch-ms 4 minutes in the past', () => {
      const ts = String(SERVER_NOW_MS - 4 * 60 * 1000);
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(true);
    });

    it('accepts RFC3339 with timezone offset (non-Z)', () => {
      // 22:00 UTC = 17:00 UTC-5 (EST)
      const res = validateTimestamp('2026-04-21T17:00:00.000-05:00', { now });
      expect(res.ok).toBe(true);
    });

    it('accepts boundary: exactly -5 min', () => {
      const ts = new Date(SERVER_NOW_MS - TIMESTAMP_WINDOW_MS).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(true);
    });

    it('accepts boundary: exactly +5 min', () => {
      const ts = new Date(SERVER_NOW_MS + TIMESTAMP_WINDOW_MS).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(true);
    });
  });

  describe('rejecting out-of-window timestamps', () => {
    it('rejects "too_old" past the window', () => {
      const ts = new Date(SERVER_NOW_MS - TIMESTAMP_WINDOW_MS - 1).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ ok: false, reason: 'too_old' });
    });

    it('rejects "too_future" past the window', () => {
      const ts = new Date(SERVER_NOW_MS + TIMESTAMP_WINDOW_MS + 1).toISOString();
      const res = validateTimestamp(ts, { now });
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ ok: false, reason: 'too_future' });
    });

    it('rejects a year-old timestamp as "too_old"', () => {
      const ts = '2025-04-21T22:00:00.000Z';
      const res = validateTimestamp(ts, { now });
      expect(res).toMatchObject({ ok: false, reason: 'too_old' });
    });
  });

  describe('rejecting malformed input', () => {
    it('rejects empty string as "missing"', () => {
      expect(validateTimestamp('', { now })).toMatchObject({
        ok: false,
        reason: 'missing',
      });
    });

    it('rejects undefined as "missing"', () => {
      expect(validateTimestamp(undefined, { now })).toMatchObject({
        ok: false,
        reason: 'missing',
      });
    });

    it('rejects null as "missing"', () => {
      expect(validateTimestamp(null, { now })).toMatchObject({
        ok: false,
        reason: 'missing',
      });
    });

    it('rejects garbage as "malformed"', () => {
      expect(validateTimestamp('not-a-date', { now })).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    });

    it('rejects half-valid RFC3339 as "malformed"', () => {
      expect(validateTimestamp('2026-13-99T99:99:99Z', { now })).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    });

    it('rejects negative epoch as "malformed"', () => {
      // Our epoch branch requires /^\d+$/ so `-1745270000000` fails the
      // epoch parse AND Date.parse treats it as NaN → malformed.
      expect(validateTimestamp('-1745270000000', { now })).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    });
  });

  describe('custom windowMs override', () => {
    it('accepts tighter windows (narrower tolerance)', () => {
      // 30s window; 20s past = ok; 1min past = too_old
      expect(
        validateTimestamp(String(SERVER_NOW_MS - 20_000), { now, windowMs: 30_000 }),
      ).toMatchObject({ ok: true });

      expect(
        validateTimestamp(String(SERVER_NOW_MS - 60_000), { now, windowMs: 30_000 }),
      ).toMatchObject({ ok: false, reason: 'too_old' });
    });
  });

  describe('default clock', () => {
    it('uses Date.now when no now() is injected', () => {
      // A "now"-anchored string is within the ±5 min window.
      const res = validateTimestamp(new Date().toISOString());
      expect(res.ok).toBe(true);
    });
  });

  describe('TIMESTAMP_WINDOW_MS constant', () => {
    it('is exactly 5 minutes', () => {
      expect(TIMESTAMP_WINDOW_MS).toBe(5 * 60 * 1000);
    });
  });
});
