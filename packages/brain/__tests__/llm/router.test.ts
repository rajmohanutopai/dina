/**
 * T2B.5 — LLM router: provider selection, cloud consent, token tracking.
 *
 * Category B: contract test. Verifies routing logic:
 * FTS-only skip, local preference, sensitive scrubbing, cloud consent gate,
 * extended task types, token usage accumulator, graceful degradation.
 *
 * Source: brain/tests/test_llm.py
 */

import {
  routeTask,
  isFTSOnly,
  isLightweightTask,
  requiresScrubbing,
  recordUsage,
  getModelUsage,
  getAllUsage,
  getTotalTokens,
  resetUsage,
} from '../../src/llm/router';
import type { RouterConfig } from '../../src/llm/router';
import { CloudConsentError } from '../../../core/src/errors';

describe('LLM Router', () => {
  const localConfig: RouterConfig = {
    localAvailable: true,
    cloudProviders: ['gemini', 'claude'],
    sensitivePersonas: ['health', 'financial'],
  };

  const cloudOnlyConfig: RouterConfig = {
    localAvailable: false,
    cloudProviders: ['gemini'],
    sensitivePersonas: ['health', 'financial'],
  };

  const cloudConsentedConfig: RouterConfig = {
    localAvailable: false,
    cloudProviders: ['gemini'],
    sensitivePersonas: ['health', 'financial'],
    cloudConsentGranted: true,
  };

  const noProvidersConfig: RouterConfig = {
    localAvailable: false,
    cloudProviders: [],
    sensitivePersonas: ['health', 'financial'],
  };

  describe('routeTask', () => {
    it('FTS-only task → skip LLM (provider: none)', () => {
      const result = routeTask('keyword_search', undefined, localConfig);
      expect(result.provider).toBe('none');
      expect(result.requiresScrubbing).toBe(false);
    });

    it('fts_lookup → skip LLM', () => {
      const result = routeTask('fts_lookup', undefined, localConfig);
      expect(result.provider).toBe('none');
    });

    it('local available → use local', () => {
      const result = routeTask('summarize', 'general', localConfig);
      expect(result.provider).toBe('local');
      expect(result.requiresScrubbing).toBe(false);
    });

    it('lightweight task + local available → prefer local', () => {
      const result = routeTask('classify', 'general', localConfig);
      expect(result.provider).toBe('local');
    });

    it('sensitive persona + cloud + consent → requires scrubbing', () => {
      const result = routeTask('reason', 'health', cloudConsentedConfig);
      expect(result.provider).toBe('gemini');
      expect(result.requiresScrubbing).toBe(true);
    });

    it('non-sensitive persona + cloud → STILL scrubbed (cloud-wide policy)', () => {
      const result = routeTask('reason', 'general', cloudConsentedConfig);
      expect(result.provider).toBe('gemini');
      expect(result.requiresScrubbing).toBe(true); // cloud-wide: ALL cloud calls scrubbed
    });

    it('local available + sensitive persona → local (no scrubbing needed)', () => {
      const result = routeTask('reason', 'health', localConfig);
      expect(result.provider).toBe('local');
      expect(result.requiresScrubbing).toBe(false);
    });

    it('no providers → graceful degradation (FTS-only)', () => {
      const result = routeTask('summarize', 'general', noProvidersConfig);
      expect(result.provider).toBe('none');
      expect(result.reason).toContain('falling back');
    });

    it('uses first cloud provider from list', () => {
      const result = routeTask('reason', 'general', cloudOnlyConfig);
      expect(result.provider).toBe('gemini'); // first in cloudProviders
    });

    it('includes reason in decision', () => {
      const result = routeTask('classify', 'general', localConfig);
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('financial persona + cloud + consent → requires scrubbing', () => {
      const result = routeTask('reason', 'financial', cloudConsentedConfig);
      expect(result.requiresScrubbing).toBe(true);
    });
  });

  describe('cloud consent gate', () => {
    it('throws CloudConsentError for sensitive persona + cloud without consent', () => {
      expect(() => routeTask('reason', 'health', cloudOnlyConfig)).toThrow(CloudConsentError);
    });

    it('error includes persona name', () => {
      try {
        routeTask('reason', 'health', cloudOnlyConfig);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CloudConsentError);
        expect((err as CloudConsentError).persona).toBe('health');
      }
    });

    it('allows sensitive persona when consent granted', () => {
      const result = routeTask('reason', 'health', cloudConsentedConfig);
      expect(result.provider).toBe('gemini');
      expect(result.requiresScrubbing).toBe(true);
    });

    it('does not throw for non-sensitive persona', () => {
      expect(() => routeTask('reason', 'general', cloudOnlyConfig)).not.toThrow();
    });

    it('does not throw when local is available (even for sensitive)', () => {
      expect(() => routeTask('reason', 'health', localConfig)).not.toThrow();
    });

    it('does not throw for FTS-only tasks (even sensitive persona)', () => {
      expect(() => routeTask('keyword_search', 'health', cloudOnlyConfig)).not.toThrow();
    });
  });

  describe('isFTSOnly', () => {
    it('keyword_search → true', () => {
      expect(isFTSOnly('keyword_search')).toBe(true);
    });

    it('fts_lookup → true', () => {
      expect(isFTSOnly('fts_lookup')).toBe(true);
    });

    it('classify → false', () => {
      expect(isFTSOnly('classify')).toBe(false);
    });

    it('reason → false', () => {
      expect(isFTSOnly('reason')).toBe(false);
    });

    it('embed → false', () => {
      expect(isFTSOnly('embed')).toBe(false);
    });
  });

  describe('isLightweightTask', () => {
    it('classify → true', () => {
      expect(isLightweightTask('classify')).toBe(true);
    });

    it('summarize → true', () => {
      expect(isLightweightTask('summarize')).toBe(true);
    });

    it('intent_classification → true (extended type from Python)', () => {
      expect(isLightweightTask('intent_classification')).toBe(true);
    });

    it('guard_scan → true (extended type from Python)', () => {
      expect(isLightweightTask('guard_scan')).toBe(true);
    });

    it('silence_classify → true (extended type from Python)', () => {
      expect(isLightweightTask('silence_classify')).toBe(true);
    });

    it('reason → false (complex)', () => {
      expect(isLightweightTask('reason')).toBe(false);
    });

    it('multi_step → false (complex)', () => {
      expect(isLightweightTask('multi_step')).toBe(false);
    });

    it('embed → false', () => {
      expect(isLightweightTask('embed')).toBe(false);
    });
  });

  describe('requiresScrubbing', () => {
    it('health persona + cloud → true', () => {
      expect(requiresScrubbing('health', 'gemini')).toBe(true);
    });

    it('financial persona + cloud → true', () => {
      expect(requiresScrubbing('financial', 'claude')).toBe(true);
    });

    it('general persona + cloud → true (cloud-wide scrub policy)', () => {
      expect(requiresScrubbing('general', 'gemini')).toBe(true);
    });

    it('any persona + local → false (no scrubbing for local)', () => {
      expect(requiresScrubbing('health', 'local')).toBe(false);
    });

    it('any persona + none → false', () => {
      expect(requiresScrubbing('health', 'none')).toBe(false);
    });

    it('cloud-wide: all personas scrubbed regardless of sensitive list', () => {
      // Cloud-wide policy means even non-sensitive personas get scrubbed
      expect(requiresScrubbing('medical', 'gemini', ['medical', 'legal'])).toBe(true);
      expect(requiresScrubbing('health', 'gemini', ['medical', 'legal'])).toBe(true);
      expect(requiresScrubbing('general', 'openai')).toBe(true);
    });
  });

  describe('token usage accumulator', () => {
    beforeEach(() => resetUsage());

    it('records usage for a model', () => {
      recordUsage('gpt-4o', 100, 50);
      const usage = getModelUsage('gpt-4o');
      expect(usage).toEqual({ calls: 1, tokensIn: 100, tokensOut: 50 });
    });

    it('accumulates across multiple calls', () => {
      recordUsage('gpt-4o', 100, 50);
      recordUsage('gpt-4o', 200, 80);
      const usage = getModelUsage('gpt-4o');
      expect(usage).toEqual({ calls: 2, tokensIn: 300, tokensOut: 130 });
    });

    it('tracks per-model independently', () => {
      recordUsage('gpt-4o', 100, 50);
      recordUsage('gemini-2.5-flash', 80, 40);
      expect(getModelUsage('gpt-4o')!.calls).toBe(1);
      expect(getModelUsage('gemini-2.5-flash')!.calls).toBe(1);
    });

    it('returns null for unrecorded model', () => {
      expect(getModelUsage('unknown-model')).toBeNull();
    });

    it('getTotalTokens sums across all models', () => {
      recordUsage('gpt-4o', 100, 50);
      recordUsage('gemini-2.5-flash', 200, 80);
      const total = getTotalTokens();
      expect(total.tokensIn).toBe(300);
      expect(total.tokensOut).toBe(130);
      expect(total.totalCalls).toBe(2);
    });

    it('getAllUsage returns copy of usage map', () => {
      recordUsage('gpt-4o', 100, 50);
      const all = getAllUsage();
      expect(all.size).toBe(1);
      expect(all.get('gpt-4o')).toEqual({ calls: 1, tokensIn: 100, tokensOut: 50 });
    });

    it('resetUsage clears all tracking', () => {
      recordUsage('gpt-4o', 100, 50);
      resetUsage();
      expect(getModelUsage('gpt-4o')).toBeNull();
      expect(getTotalTokens().totalCalls).toBe(0);
    });
  });
});
