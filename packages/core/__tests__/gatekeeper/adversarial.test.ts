/**
 * T1F.2 — Gatekeeper adversarial: edge cases, unknown trust, cascading denials.
 *
 * Category A: fixture-based. Verifies gatekeeper behavior under adversarial
 * inputs — missing fields, unknown trust levels, policy cascades.
 *
 * Source: core/test/gatekeeper_adversarial_test.go
 */

import { evaluateIntent } from '../../src/gatekeeper/intent';

describe('Gatekeeper Adversarial', () => {
  describe('unknown trust level', () => {
    it('treats unknown trust level as untrusted (escalates SAFE → MODERATE)', () => {
      const result = evaluateIntent('search', 'did:key:z6MkBot', 'not-a-real-level');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.requiresApproval).toBe(true);
    });

    it('treats empty trust level as default (no escalation)', () => {
      const result = evaluateIntent('search', 'did:key:z6MkBot', '');
      // Empty string is not 'unknown', so no escalation rule fires
      expect(result.riskLevel).toBe('SAFE');
    });
  });

  describe('missing agent DID', () => {
    it('evaluates without agent DID (user-initiated action)', () => {
      const result = evaluateIntent('search');
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('SAFE');
    });

    it('user-initiated SAFE actions are always allowed', () => {
      const result = evaluateIntent('query');
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  describe('cascading denials', () => {
    it('BLOCKED overrides trust level (verified agent still blocked)', () => {
      const result = evaluateIntent('credential_export', 'did:key:z6MkTrusted', 'verified');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('BLOCKED');
    });

    it('BLOCKED overrides session grants', () => {
      const result = evaluateIntent('key_access', 'did:key:z6MkTrusted', 'verified');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('BLOCKED');
    });
  });

  describe('action string edge cases', () => {
    it('treats case-sensitively (Search ≠ search → unknown → MODERATE)', () => {
      const result = evaluateIntent('Search');
      expect(result.riskLevel).toBe('MODERATE'); // not in policy table
    });

    it('untrimmed action treated as unknown', () => {
      const result = evaluateIntent('  search  ');
      expect(result.riskLevel).toBe('MODERATE'); // spaces not stripped
    });

    it('empty action is treated as unknown (MODERATE)', () => {
      const result = evaluateIntent('');
      expect(result.riskLevel).toBe('MODERATE');
    });

    it('action with special characters treated as unknown', () => {
      const result = evaluateIntent('search; DROP TABLE');
      expect(result.riskLevel).toBe('MODERATE');
    });
  });

  describe('risk escalation by trust', () => {
    it('SAFE action escalates to MODERATE for unknown trust', () => {
      const result = evaluateIntent('search', 'did:key:z6MkBot', 'unknown');
      expect(result.riskLevel).toBe('MODERATE');
    });

    it('MODERATE action stays MODERATE for verified trust', () => {
      const result = evaluateIntent('send_large', 'did:key:z6MkBot', 'verified');
      expect(result.riskLevel).toBe('MODERATE');
    });

    it('money actions BLOCKED for unknown agent (Ring 2+ required)', () => {
      const result = evaluateIntent('purchase', 'did:key:z6MkBot', 'unknown');
      expect(result.riskLevel).toBe('BLOCKED'); // trust-ring enforcement
    });

    it('non-money HIGH action stays HIGH for unknown (no double-escalation)', () => {
      const result = evaluateIntent('bulk_operation', 'did:key:z6MkBot', 'unknown');
      expect(result.riskLevel).toBe('HIGH'); // unknown only escalates SAFE, not HIGH
    });
  });

  describe('concurrent intent evaluation', () => {
    it('stateless — each call is independent', () => {
      const blocked = evaluateIntent('credential_export');
      expect(blocked.allowed).toBe(false);
      const safe = evaluateIntent('search');
      expect(safe.allowed).toBe(true);
    });
  });
});
