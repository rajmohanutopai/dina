/**
 * CORE-P0-008 — Per-message expires_at enforcement tests.
 */

import { isMessageExpired } from '../../src/rpc/expiry';

describe('isMessageExpired', () => {
  const now = 1_700_000_000;

  it('returns false when expires_at is undefined (no deadline)', () => {
    expect(isMessageExpired({}, now)).toBe(false);
  });

  it('returns false when expires_at is in the future', () => {
    expect(isMessageExpired({ expires_at: now + 10 }, now)).toBe(false);
  });

  it('returns true when expires_at is strictly in the past', () => {
    expect(isMessageExpired({ expires_at: now - 1 }, now)).toBe(true);
  });

  it('returns true when expires_at equals now (deadline inclusive)', () => {
    expect(isMessageExpired({ expires_at: now }, now)).toBe(true);
  });

  it('returns false for non-finite expires_at (defensive)', () => {
    expect(isMessageExpired({ expires_at: Number.NaN }, now)).toBe(false);
    expect(isMessageExpired({ expires_at: Number.POSITIVE_INFINITY }, now)).toBe(false);
  });
});
