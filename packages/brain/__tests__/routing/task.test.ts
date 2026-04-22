/**
 * T2B.9 — Task routing: local LLM, MCP agent, trust-based selection.
 *
 * Source: brain/tests/test_routing.py
 */

import {
  routeTaskToHandler,
  shouldRouteToLocal,
  shouldDelegateToAgent,
  checkAgentTrustForDelegation,
  trustAgent,
  clearTrustedAgents,
} from '../../src/routing/task';

describe('Task Routing', () => {
  beforeEach(() => {
    clearTrustedAgents();
  });

  describe('routeTaskToHandler', () => {
    it('routes to local LLM when available', () => {
      const result = routeTaskToHandler('summarize');
      expect(result.target).toBe('local_llm');
    });

    it('routes to MCP agent for delegation tasks', () => {
      const result = routeTaskToHandler('web_search');
      expect(result.target).toBe('mcp_agent');
    });

    it('fallback to FTS for unknown task type', () => {
      const result = routeTaskToHandler('unknown_type');
      expect(result.target).toBe('fts_only');
    });

    it('respects persona tier (sensitive → local preferred)', () => {
      const result = routeTaskToHandler('reason', 'health');
      expect(result.target).toBe('local_llm');
    });

    it('complex tasks prefer local LLM', () => {
      const result = routeTaskToHandler('reason', 'general');
      expect(result.target).toBe('local_llm');
    });

    it('FTS-only tasks skip LLM entirely', () => {
      const result = routeTaskToHandler('keyword_search');
      expect(result.target).toBe('fts_only');
    });

    it('includes routing reason in result', () => {
      const result = routeTaskToHandler('classify');
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('shouldRouteToLocal', () => {
    it('summarize → true', () => {
      expect(shouldRouteToLocal('summarize')).toBe(true);
    });

    it('classify → true', () => {
      expect(shouldRouteToLocal('classify')).toBe(true);
    });

    it('web_search → false (requires MCP agent)', () => {
      expect(shouldRouteToLocal('web_search')).toBe(false);
    });

    it('keyword_search → false (FTS only)', () => {
      expect(shouldRouteToLocal('keyword_search')).toBe(false);
    });
  });

  describe('shouldDelegateToAgent', () => {
    it('web_search → true', () => {
      expect(shouldDelegateToAgent('web_search')).toBe(true);
    });

    it('summarize → false', () => {
      expect(shouldDelegateToAgent('summarize')).toBe(false);
    });

    it('api_call → true', () => {
      expect(shouldDelegateToAgent('api_call')).toBe(true);
    });
  });

  describe('checkAgentTrustForDelegation', () => {
    it('trusted agent passes with high score', () => {
      trustAgent('did:key:z6MkTrustedBot');
      const result = checkAgentTrustForDelegation('did:key:z6MkTrustedBot');
      expect(result.trusted).toBe(true);
      expect(result.score).toBeGreaterThan(0.5);
    });

    it('untrusted agent fails with low score', () => {
      const result = checkAgentTrustForDelegation('did:key:z6MkUnknownBot');
      expect(result.trusted).toBe(false);
      expect(result.score).toBeLessThan(0.5);
    });

    it('returns trust score between 0 and 1', () => {
      const result = checkAgentTrustForDelegation('did:key:z6MkBot');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });
  });
});
