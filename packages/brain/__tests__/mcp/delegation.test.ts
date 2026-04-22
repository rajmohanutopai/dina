/**
 * T2B.12 — MCP agent delegation: safety gates, intent validation, sanitization.
 *
 * Source: brain/tests/test_mcp.py
 */

import {
  evaluateDelegation,
  isAgentBlacklisted,
  sanitizeAgentQuery,
  isToolAllowed,
  validateConstraints,
  blacklistAgent,
  clearBlacklist,
} from '../../src/mcp/delegation';
import type { DelegationRequest } from '../../src/mcp/delegation';

describe('MCP Agent Delegation', () => {
  beforeEach(() => {
    clearBlacklist();
  });

  describe('evaluateDelegation', () => {
    it('SAFE action → auto-approved', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'search',
        description: 'find chairs',
      };
      const result = evaluateDelegation(req);
      expect(result.approved).toBe(true);
      expect(result.risk).toBe('SAFE');
      expect(result.requiresUserApproval).toBe(false);
    });

    it('MODERATE action → requires user approval', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'send_email',
        description: 'send report',
      };
      const result = evaluateDelegation(req);
      expect(result.approved).toBe(true);
      expect(result.risk).toBe('MODERATE');
      expect(result.requiresUserApproval).toBe(true);
    });

    it('HIGH action → requires user approval', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'purchase',
        description: 'buy chair',
      };
      const result = evaluateDelegation(req);
      expect(result.risk).toBe('HIGH');
      expect(result.requiresUserApproval).toBe(true);
    });

    it('BLOCKED action → denied', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'credential_export',
        description: 'export',
      };
      const result = evaluateDelegation(req);
      expect(result.approved).toBe(false);
      expect(result.risk).toBe('BLOCKED');
    });

    it('blacklisted agent → denied regardless of action', () => {
      blacklistAgent('did:key:z6MkBadBot');
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBadBot',
        action: 'search',
        description: 'test',
      };
      const result = evaluateDelegation(req);
      expect(result.approved).toBe(false);
      expect(result.risk).toBe('BLOCKED');
    });

    it('includes reason in decision', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'query',
        description: 'test',
      };
      const result = evaluateDelegation(req);
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('unknown action → MODERATE', () => {
      const req: DelegationRequest = {
        agentDID: 'did:key:z6MkBot',
        action: 'unknown_action',
        description: 'test',
      };
      expect(evaluateDelegation(req).risk).toBe('MODERATE');
    });
  });

  describe('isAgentBlacklisted', () => {
    it('known bad agent → true', () => {
      blacklistAgent('did:key:z6MkMaliciousBot');
      expect(isAgentBlacklisted('did:key:z6MkMaliciousBot')).toBe(true);
    });

    it('trusted agent → false', () => {
      expect(isAgentBlacklisted('did:key:z6MkTrustedBot')).toBe(false);
    });
  });

  describe('sanitizeAgentQuery', () => {
    it('strips injection attempts', () => {
      const result = sanitizeAgentQuery('normal query; DROP TABLE users');
      expect(result).not.toContain('DROP TABLE');
    });

    it('preserves clean queries', () => {
      expect(sanitizeAgentQuery('find ergonomic chairs under $500')).toBe(
        'find ergonomic chairs under $500',
      );
    });

    it('removes script tags', () => {
      const result = sanitizeAgentQuery('query <script>alert(1)</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('query');
    });

    it('handles empty query', () => {
      expect(sanitizeAgentQuery('')).toBe('');
    });
  });

  describe('isToolAllowed', () => {
    it('allowed tool → true', () => {
      expect(isToolAllowed('gmail_fetch')).toBe(true);
    });

    it('disallowed tool → false', () => {
      expect(isToolAllowed('rm_rf_root')).toBe(false);
    });

    it('empty tool name → false', () => {
      expect(isToolAllowed('')).toBe(false);
    });

    it('vault_search allowed', () => {
      expect(isToolAllowed('vault_search')).toBe(true);
    });
  });

  describe('validateConstraints', () => {
    it('same action → valid', () => {
      expect(validateConstraints('search', 'search')).toBe(true);
    });

    it('escalation → invalid (approved for search, attempted send_email)', () => {
      expect(validateConstraints('search', 'send_email')).toBe(false);
    });

    it('de-escalation → valid (approved for send_email, attempted search)', () => {
      expect(validateConstraints('send_email', 'search')).toBe(true);
    });

    it('BLOCKED action always invalid regardless of approval', () => {
      expect(validateConstraints('purchase', 'credential_export')).toBe(false);
    });
  });
});
