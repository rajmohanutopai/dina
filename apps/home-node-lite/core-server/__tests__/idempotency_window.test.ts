/**
 * Task 4.83 — idempotency replay-window pinning tests.
 *
 * The idempotency cache's TTL must:
 *   - Be expressed in explicit minutes (operator-readable, not "a while").
 *   - Be ≥ `TIMESTAMP_WINDOW_MS` so a signed request still acceptable
 *     by the timestamp validator still hits the cache → no double-
 *     execution gap.
 *   - Drive the ms constant by arithmetic, not by a separate literal
 *     (prevents drift between the minutes spec and the ms wiring).
 */

import {
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_TTL_MINUTES,
  IdempotencyCache,
  MIN_IDEMPOTENCY_TTL_MS,
} from '../src/msgbox/idempotency_cache';
import { TIMESTAMP_WINDOW_MS } from '../src/auth/timestamp_window';

describe('idempotency replay window (task 4.83)', () => {
  describe('explicit-minutes spec', () => {
    it('IDEMPOTENCY_TTL_MINUTES = 5 (operator-readable name)', () => {
      expect(IDEMPOTENCY_TTL_MINUTES).toBe(5);
    });

    it('DEFAULT_IDEMPOTENCY_TTL_MS is derived from IDEMPOTENCY_TTL_MINUTES (no drift)', () => {
      expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBe(IDEMPOTENCY_TTL_MINUTES * 60 * 1000);
    });

    it('DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 10 000', () => {
      expect(DEFAULT_IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
    });
  });

  describe('minimum TTL invariant', () => {
    it('MIN_IDEMPOTENCY_TTL_MS equals TIMESTAMP_WINDOW_MS (no replay-vs-dedupe gap)', () => {
      expect(MIN_IDEMPOTENCY_TTL_MS).toBe(TIMESTAMP_WINDOW_MS);
    });

    it('default TTL is >= the minimum', () => {
      expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBeGreaterThanOrEqual(MIN_IDEMPOTENCY_TTL_MS);
    });

    it('constructor rejects ttlMs below MIN_IDEMPOTENCY_TTL_MS', () => {
      expect(() => new IdempotencyCache({ ttlMs: MIN_IDEMPOTENCY_TTL_MS - 1 })).toThrow(
        /must be >= MIN_IDEMPOTENCY_TTL_MS/,
      );
    });

    it('constructor accepts ttlMs equal to MIN_IDEMPOTENCY_TTL_MS', () => {
      expect(() => new IdempotencyCache({ ttlMs: MIN_IDEMPOTENCY_TTL_MS })).not.toThrow();
    });

    it('constructor accepts larger ttlMs (10 minutes)', () => {
      expect(() => new IdempotencyCache({ ttlMs: 10 * 60 * 1000 })).not.toThrow();
    });

    it('constructor still rejects non-positive ttlMs with the original message', () => {
      expect(() => new IdempotencyCache({ ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
      expect(() => new IdempotencyCache({ ttlMs: -1 })).toThrow(/ttlMs must be > 0/);
    });
  });

  describe('minutes introspection', () => {
    it('ttlMinutes() reports whole minutes', () => {
      const cache = new IdempotencyCache();
      expect(cache.ttlMinutes()).toBe(IDEMPOTENCY_TTL_MINUTES);
    });

    it('ttlMinutes() rounds DOWN for partial-minute TTLs (floor)', () => {
      // 5 min + 30s = 5.5 min → floor = 5.
      const cache = new IdempotencyCache({ ttlMs: 5 * 60 * 1000 + 30_000 });
      expect(cache.ttlMinutes()).toBe(5);
    });
  });

  describe('the reasoning-why comments survive', () => {
    // Meta-test: the header doc-string explains WHY min TTL equals
    // the timestamp window. The invariant above pins it behaviorally;
    // this pins the *relationship* between constants so a well-
    // meaning refactor that loosens one without the other fails.
    it('raising TIMESTAMP_WINDOW_MS without raising MIN_IDEMPOTENCY_TTL_MS breaks parity', () => {
      expect(MIN_IDEMPOTENCY_TTL_MS).toBe(TIMESTAMP_WINDOW_MS);
    });
  });
});
