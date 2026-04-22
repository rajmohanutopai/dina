/**
 * T3.2 — Staging sweep: lease expiry revert, retry cap, dead-letter.
 *
 * Source: core/test/staging_inbox_test.go (sweep section)
 */

import {
  isValidTransition,
  shouldRetry,
  isLeaseExpired,
  isItemExpired,
} from '../../src/staging/state_machine';

describe('Staging Sweep (Mobile-Specific)', () => {
  describe('lease expiry revert', () => {
    it('classifying + lease expired → revert to received', () => {
      expect(isValidTransition('classifying', 'received')).toBe(true);
    });

    it('lease check uses injectable now', () => {
      const now = 1700000000;
      expect(isLeaseExpired(now - 100, now)).toBe(true);
    });

    it('non-expired lease is not reverted', () => {
      const now = 1700000000;
      expect(isLeaseExpired(now + 900, now)).toBe(false);
    });
  });

  describe('retry cap', () => {
    it('retry_count ≤ 3 → requeue', () => {
      expect(shouldRetry(3)).toBe(true);
    });

    it('retry_count > 3 → dead-lettered', () => {
      expect(shouldRetry(4)).toBe(false);
    });

    it('custom max_retries respected', () => {
      expect(shouldRetry(5, 10)).toBe(true);
    });
  });

  describe('item expiry', () => {
    it('items past expires_at deleted', () => {
      expect(isItemExpired(1700000000 - 1, 1700000000)).toBe(true);
    });

    it('non-expired items preserved', () => {
      expect(isItemExpired(1700000000 + 86400, 1700000000)).toBe(false);
    });
  });
});
