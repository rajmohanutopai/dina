/**
 * T2D.7 — Agent delegation: detect task, suggest, approve, scope limits.
 *
 * Category B: integration/contract test.
 *
 * Source: tests/integration/test_delegation.py
 */

import { evaluateIntent } from '../../src/gatekeeper/intent';
import {
  evaluateDelegation,
  isToolAllowed,
  validateConstraints,
  clearBlacklist,
} from '../../../brain/src/mcp/delegation';

describe('Agent Delegation Integration', () => {
  beforeEach(() => clearBlacklist());

  describe('task detection', () => {
    it('unknown action defaults to MODERATE (requires approval)', () => {
      const result = evaluateIntent('detect_expiry');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.requiresApproval).toBe(true);
    });

    it('suggests delegation to appropriate agent', () => {
      // Agent requests a SAFE action → delegation approved without user prompt
      const result = evaluateDelegation({
        agentDID: 'did:key:z6MkAgent1',
        action: 'search',
        description: 'Search vault for meeting notes',
      });
      expect(result.approved).toBe(true);
      expect(result.risk).toBe('SAFE');
      expect(result.requiresUserApproval).toBe(false);
    });

    it('delegation for HIGH action requires user approval', () => {
      const result = evaluateDelegation({
        agentDID: 'did:key:z6MkAgent1',
        action: 'purchase',
        description: 'Purchase product from seller',
      });
      expect(result.approved).toBe(true);
      expect(result.risk).toBe('HIGH');
      expect(result.requiresUserApproval).toBe(true);
    });

    it('delegation with disallowed tool is rejected', () => {
      expect(isToolAllowed('vault_search')).toBe(true);
      expect(isToolAllowed('dangerous_tool')).toBe(false);
    });

    it('constraint validation: approved action matches attempted', () => {
      expect(validateConstraints('search', 'search')).toBe(true);
      expect(validateConstraints('search', 'purchase')).toBe(false);
    });
  });

  describe('user approval', () => {
    it('search is SAFE → auto-approved', () => {
      const result = evaluateIntent('search');
      expect(result.riskLevel).toBe('SAFE');
      expect(result.requiresApproval).toBe(false);
    });

    it('read-only operations auto-approved (SAFE)', () => {
      expect(evaluateIntent('query').requiresApproval).toBe(false);
      expect(evaluateIntent('list').requiresApproval).toBe(false);
    });

    it('write operations require user approval (MODERATE)', () => {
      const result = evaluateIntent('send_large');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.requiresApproval).toBe(true);
    });

    it('financial actions always flagged HIGH', () => {
      const result = evaluateIntent('purchase');
      expect(result.riskLevel).toBe('HIGH');
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('scope limitation', () => {
    it('credential_export is always BLOCKED', () => {
      const result = evaluateIntent('credential_export');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('BLOCKED');
    });
  });
});
