/**
 * T1B.5 — Per-DID rate limiting.
 *
 * Category A: fixture-based. Verifies per-DID bucket mechanics:
 * token consumption, limit enforcement, reset, different DIDs independent.
 *
 * Source: core/test/ratelimit_test.go (adapted from per-IP to per-DID)
 */

import { PerDIDRateLimiter } from '../../src/auth/ratelimit';

describe('Per-DID Rate Limiter', () => {
  const brainDID = 'did:key:z6MkBrainService';
  const deviceDID = 'did:key:z6MkMyPhone';

  it('constructs with default config', () => {
    const limiter = new PerDIDRateLimiter();
    expect(limiter.remaining(brainDID)).toBe(50);
  });

  it('constructs with custom config', () => {
    const limiter = new PerDIDRateLimiter({ maxRequests: 100, windowSeconds: 30 });
    expect(limiter.remaining(brainDID)).toBe(100);
  });

  describe('allow', () => {
    it('allows requests under the limit', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 5, windowSeconds: 60 });
      expect(limiter.allow(brainDID)).toBe(true);
      expect(limiter.allow(brainDID)).toBe(true);
      expect(limiter.allow(brainDID)).toBe(true);
    });

    it('rejects requests over the limit', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 3, windowSeconds: 60 });
      expect(limiter.allow(brainDID)).toBe(true); // 1
      expect(limiter.allow(brainDID)).toBe(true); // 2
      expect(limiter.allow(brainDID)).toBe(true); // 3
      expect(limiter.allow(brainDID)).toBe(false); // 4 — rejected
      expect(limiter.allow(brainDID)).toBe(false); // still rejected
    });

    it('tracks different DIDs independently', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 2, windowSeconds: 60 });
      expect(limiter.allow(brainDID)).toBe(true);
      expect(limiter.allow(brainDID)).toBe(true);
      expect(limiter.allow(brainDID)).toBe(false); // brain exhausted
      expect(limiter.allow(deviceDID)).toBe(true); // device still has quota
    });

    it('allows exactly maxRequests before rejecting', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 5, windowSeconds: 60 });
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow(brainDID)).toBe(true);
      }
      expect(limiter.allow(brainDID)).toBe(false);
    });
  });

  describe('reset', () => {
    it('resets a specific DID quota', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 2, windowSeconds: 60 });
      limiter.allow(brainDID);
      limiter.allow(brainDID);
      expect(limiter.allow(brainDID)).toBe(false); // exhausted
      limiter.reset(brainDID);
      expect(limiter.allow(brainDID)).toBe(true); // fresh after reset
    });

    it('does not affect other DIDs', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 2, windowSeconds: 60 });
      limiter.allow(brainDID);
      limiter.allow(deviceDID);
      limiter.reset(brainDID);
      expect(limiter.remaining(brainDID)).toBe(2); // reset
      expect(limiter.remaining(deviceDID)).toBe(1); // unchanged
    });

    it('reset of unseen DID is a no-op', () => {
      const limiter = new PerDIDRateLimiter();
      limiter.reset('did:key:z6MkUnknown'); // no throw
      expect(limiter.remaining('did:key:z6MkUnknown')).toBe(50);
    });
  });

  describe('remaining', () => {
    it('reports remaining quota for a DID', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 10, windowSeconds: 60 });
      expect(limiter.remaining(brainDID)).toBe(10);
      limiter.allow(brainDID);
      limiter.allow(brainDID);
      limiter.allow(brainDID);
      expect(limiter.remaining(brainDID)).toBe(7);
    });

    it('returns full quota for unseen DID', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 50, windowSeconds: 60 });
      expect(limiter.remaining('did:key:z6MkNewDevice')).toBe(50);
    });

    it('returns 0 when exhausted', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 1, windowSeconds: 60 });
      limiter.allow(brainDID);
      expect(limiter.remaining(brainDID)).toBe(0);
    });
  });

  describe('window expiry', () => {
    it('resets quota after window expires', () => {
      // Use a very short window (1ms effectively) so Date.now() crosses it
      const limiter = new PerDIDRateLimiter({ maxRequests: 1, windowSeconds: 0 });
      limiter.allow(brainDID);
      // Window is 0 seconds → immediately expired on next call
      expect(limiter.allow(brainDID)).toBe(true); // new window
    });
  });
});
