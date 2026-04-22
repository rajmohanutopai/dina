/**
 * T2D.10 — Trust rings: transaction limits for unverified/verified entities.
 *
 * Category B: integration/contract test. Only the gatekeeper-portable
 * parts — NOT trust scoring internals (which are AppView-side).
 *
 * Source: tests/integration/test_trust_rings.py (portable parts)
 */

import { evaluateIntent } from '../../src/gatekeeper/intent';

describe('Trust Rings Gatekeeper', () => {
  describe('unverified entity (Ring 1)', () => {
    it('faces escalated risk on SAFE actions (unknown → MODERATE)', () => {
      const result = evaluateIntent('search', 'did:key:z6MkUnverified', 'unknown');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.requiresApproval).toBe(true);
    });

    it('money actions BLOCKED for unverified (Ring 2+ required)', () => {
      const result = evaluateIntent('purchase', 'did:key:z6MkUnverified', 'unknown');
      expect(result.riskLevel).toBe('BLOCKED');
      expect(result.allowed).toBe(false);
    });

    it('BLOCKED actions denied regardless of ring', () => {
      const result = evaluateIntent('credential_export', 'did:key:z6MkUnverified', 'unknown');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('BLOCKED');
    });
  });

  describe('verified entity (Ring 2+)', () => {
    it('SAFE actions remain SAFE (no escalation)', () => {
      const result = evaluateIntent('search', 'did:key:z6MkVerified', 'verified');
      expect(result.riskLevel).toBe('SAFE');
      expect(result.requiresApproval).toBe(false);
    });

    it('moderate-risk actions allowed with approval', () => {
      const result = evaluateIntent('send_large', 'did:key:z6MkVerified', 'verified');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('HIGH actions possible with approval', () => {
      const result = evaluateIntent('purchase', 'did:key:z6MkVerified', 'verified');
      expect(result.riskLevel).toBe('HIGH');
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });
  });
});
