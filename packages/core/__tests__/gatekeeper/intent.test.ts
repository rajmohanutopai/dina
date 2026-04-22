/**
 * T1F.1 — Gatekeeper intent evaluation: action → risk level mapping.
 *
 * Category A: fixture-based. Verifies the default policy table matches
 * the server exactly for all documented actions.
 *
 * Source: core/test/gatekeeper_test.go
 */

import {
  evaluateIntent,
  evaluateIntentWithPersona,
  getDefaultRiskLevel,
  isBrainDenied,
  isMoneyAction,
} from '../../src/gatekeeper/intent';
import { DEFAULT_ACTION_POLICIES } from '@dina/test-harness';

describe('Gatekeeper Intent Evaluation', () => {
  describe('getDefaultRiskLevel', () => {
    for (const [action, expectedRisk] of Object.entries(DEFAULT_ACTION_POLICIES)) {
      it(`"${action}" → ${expectedRisk}`, () => {
        expect(getDefaultRiskLevel(action)).toBe(expectedRisk);
      });
    }

    it('returns undefined for unknown action', () => {
      expect(getDefaultRiskLevel('made_up_action')).toBeUndefined();
    });
  });

  describe('evaluateIntent', () => {
    it('SAFE action → allowed, no approval needed', () => {
      const decision = evaluateIntent('search');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('SAFE');
      expect(decision.requiresApproval).toBe(false);
    });

    it('MODERATE action → allowed, approval required', () => {
      const decision = evaluateIntent('send_large');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('MODERATE');
      expect(decision.requiresApproval).toBe(true);
    });

    it('HIGH action → allowed, approval required', () => {
      const decision = evaluateIntent('purchase');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('HIGH');
      expect(decision.requiresApproval).toBe(true);
    });

    it('BLOCKED action → denied', () => {
      const decision = evaluateIntent('credential_export');
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
    });

    it('unknown action defaults to MODERATE (require approval)', () => {
      const decision = evaluateIntent('unknown_action');
      expect(decision.riskLevel).toBe('MODERATE');
      expect(decision.requiresApproval).toBe(true);
      expect(decision.allowed).toBe(true);
    });

    it('untrusted agent escalates SAFE → MODERATE', () => {
      const decision = evaluateIntent('search', 'did:key:z6MkBot', 'unknown');
      expect(decision.riskLevel).toBe('MODERATE');
      expect(decision.requiresApproval).toBe(true);
    });

    it('verified agent keeps SAFE as SAFE', () => {
      const decision = evaluateIntent('search', 'did:key:z6MkBot', 'verified');
      expect(decision.riskLevel).toBe('SAFE');
      expect(decision.requiresApproval).toBe(false);
    });

    it('includes reason in decision', () => {
      const decision = evaluateIntent('query');
      expect(decision.reason).toBeTruthy();
      expect(decision.reason.length).toBeGreaterThan(0);
    });

    it('brain-denied action → BLOCKED even for SAFE-classified actions', () => {
      // did_sign is brain-denied, always blocked
      const decision = evaluateIntent('did_sign');
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
    });
  });

  describe('audit flag', () => {
    it('SAFE decisions are not audited (silent-pass)', () => {
      const decision = evaluateIntent('search');
      expect(decision.audit).toBe(false);
    });

    it('MODERATE decisions are audited', () => {
      const decision = evaluateIntent('send_large');
      expect(decision.audit).toBe(true);
    });

    it('HIGH decisions are audited', () => {
      const decision = evaluateIntent('purchase');
      expect(decision.audit).toBe(true);
    });

    it('BLOCKED decisions are audited', () => {
      const decision = evaluateIntent('credential_export');
      expect(decision.audit).toBe(true);
    });

    it('trust escalation (SAFE→MODERATE) becomes audited', () => {
      const decision = evaluateIntent('search', 'did:key:z6MkBot', 'unknown');
      expect(decision.riskLevel).toBe('MODERATE');
      expect(decision.audit).toBe(true);
    });
  });

  describe('brain-denied actions (extended)', () => {
    it('vault_raw_read is brain-denied', () => {
      expect(isBrainDenied('vault_raw_read')).toBe(true);
      expect(evaluateIntent('vault_raw_read').allowed).toBe(false);
    });

    it('vault_raw_write is brain-denied', () => {
      expect(isBrainDenied('vault_raw_write')).toBe(true);
      expect(evaluateIntent('vault_raw_write').allowed).toBe(false);
    });

    it('vault_export is brain-denied', () => {
      expect(isBrainDenied('vault_export')).toBe(true);
      expect(evaluateIntent('vault_export').allowed).toBe(false);
    });

    it('original 5 brain-denied actions still blocked', () => {
      for (const action of [
        'did_sign',
        'did_rotate',
        'vault_backup',
        'persona_unlock',
        'seed_export',
      ]) {
        expect(isBrainDenied(action)).toBe(true);
      }
    });

    it('non-denied action is not brain-denied', () => {
      expect(isBrainDenied('search')).toBe(false);
      expect(isBrainDenied('purchase')).toBe(false);
    });
  });

  describe('policy table completeness', () => {
    it('covers all SAFE actions', () => {
      const safeActions = Object.entries(DEFAULT_ACTION_POLICIES)
        .filter(([, risk]) => risk === 'SAFE')
        .map(([action]) => action);
      expect(safeActions.length).toBeGreaterThanOrEqual(5);
      for (const action of safeActions) {
        const decision = evaluateIntent(action);
        expect(decision.riskLevel).toBe('SAFE');
        expect(decision.allowed).toBe(true);
      }
    });

    it('covers all BLOCKED actions', () => {
      const blockedActions = Object.entries(DEFAULT_ACTION_POLICIES)
        .filter(([, risk]) => risk === 'BLOCKED')
        .map(([action]) => action);
      expect(blockedActions.length).toBeGreaterThanOrEqual(2);
      for (const action of blockedActions) {
        const decision = evaluateIntent(action);
        expect(decision.riskLevel).toBe('BLOCKED');
        expect(decision.allowed).toBe(false);
      }
    });
  });

  describe('trust-ring enforcement for money actions', () => {
    it('purchase by unknown agent → BLOCKED', () => {
      const decision = evaluateIntent('purchase', 'did:key:z6MkBot', 'unknown');
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
      expect(decision.reason).toContain('Ring 2+');
    });

    it('payment by unknown agent → BLOCKED', () => {
      const decision = evaluateIntent('payment', 'did:key:z6MkBot', 'unknown');
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
    });

    it('purchase by verified agent → HIGH (allowed with approval)', () => {
      const decision = evaluateIntent('purchase', 'did:key:z6MkBot', 'verified');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('HIGH');
    });

    it('purchase by self → HIGH (allowed)', () => {
      const decision = evaluateIntent('purchase', 'did:key:z6MkBot', 'self');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('HIGH');
    });

    it('user-initiated purchase (no trustLevel) → HIGH (allowed)', () => {
      const decision = evaluateIntent('purchase');
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('HIGH');
    });

    it('isMoneyAction identifies purchase/payment', () => {
      expect(isMoneyAction('purchase')).toBe(true);
      expect(isMoneyAction('payment')).toBe(true);
      expect(isMoneyAction('search')).toBe(false);
      expect(isMoneyAction('store')).toBe(false);
    });
  });

  describe('persona-lock pre-check', () => {
    it('denies when persona is locked', () => {
      const decision = evaluateIntentWithPersona('search', false);
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
      expect(decision.audit).toBe(true);
      expect(decision.reason).toContain('locked');
    });

    it('proceeds normally when persona is open', () => {
      const decision = evaluateIntentWithPersona('search', true);
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('SAFE');
    });

    it('locked persona blocks even SAFE actions', () => {
      const decision = evaluateIntentWithPersona('query', false);
      expect(decision.allowed).toBe(false);
    });

    it('open persona allows normal evaluation chain', () => {
      // MODERATE action with open persona → allowed with approval
      const decision = evaluateIntentWithPersona('send_large', true);
      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe('MODERATE');
      expect(decision.requiresApproval).toBe(true);
    });

    it('open persona still blocks brain-denied actions', () => {
      const decision = evaluateIntentWithPersona('did_sign', true);
      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe('BLOCKED');
    });
  });
});
