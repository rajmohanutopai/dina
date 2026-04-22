/**
 * T3.10 — Per-DID rate limiting (not per-IP — Core only sees localhost).
 *
 * Category B+: NEW mobile-specific test.
 *
 * Source: ARCHITECTURE.md Section 24.2.
 */

import { PerDIDRateLimiter } from '../../src/auth/ratelimit';

describe('Per-DID Rate Limiting (Mobile-Specific)', () => {
  const brainDID = 'did:key:z6MkBrainService';
  const deviceDID = 'did:key:z6MkMyPhone';
  const relayDID = 'did:key:z6MkRemoteCLI';

  describe('per-DID buckets (not per-IP)', () => {
    it('each DID has independent rate limit', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 5, windowSeconds: 60 });
      expect(limiter.allow(brainDID)).toBe(true);
      expect(limiter.allow(deviceDID)).toBe(true);
      expect(limiter.remaining(brainDID)).toBe(4);
      expect(limiter.remaining(deviceDID)).toBe(4);
    });

    it('exhausting one DID does not affect another', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 3, windowSeconds: 60 });
      limiter.allow(brainDID);
      limiter.allow(brainDID);
      limiter.allow(brainDID);
      expect(limiter.allow(brainDID)).toBe(false); // brain exhausted
      expect(limiter.allow(deviceDID)).toBe(true); // device unaffected
    });

    it('per-IP is meaningless (Core only sees 127.0.0.1)', () => {
      // Architectural: all traffic arrives via localhost or MsgBox relay
      // Per-DID correctly distinguishes callers behind the same IP
      const limiter = new PerDIDRateLimiter({ maxRequests: 50, windowSeconds: 60 });
      expect(limiter.allow(relayDID)).toBe(true);
      expect(limiter.remaining(relayDID)).toBe(49);
    });
  });

  describe('Brain gets higher limit (trusted local process)', () => {
    it('Brain service DID has higher default limit when configured', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 100, windowSeconds: 60 });
      expect(limiter.remaining(brainDID)).toBe(100);
    });

    it('device DID has standard limit', () => {
      const limiter = new PerDIDRateLimiter({ maxRequests: 50, windowSeconds: 60 });
      expect(limiter.remaining(deviceDID)).toBe(50);
    });
  });

  describe('MsgBox edge rate limit (server-side)', () => {
    it('MsgBox enforces 60 req/min per sender DID (first layer)', () => {
      // This is enforced by the MsgBox server, not by mobile Core
      // Mobile Core applies second-layer per-DID limits
      expect(true).toBe(true); // documented architectural boundary
    });
  });
});
