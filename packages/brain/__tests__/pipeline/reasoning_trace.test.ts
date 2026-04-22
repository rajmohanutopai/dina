/**
 * Structured reasoning trace — audit trail for the chat pipeline.
 *
 * Source: brain/src/service/guardian.py — reasoning trace audit
 */

import {
  TraceBuilder,
  type ReasoningTrace,
  type TraceStep,
} from '../../src/pipeline/reasoning_trace';

describe('Reasoning Trace', () => {
  describe('TraceBuilder', () => {
    it('generates a unique request ID', () => {
      const t1 = new TraceBuilder();
      const t2 = new TraceBuilder();
      expect(t1.getRequestId()).toMatch(/^req-[0-9a-f]{16}$/);
      expect(t1.getRequestId()).not.toBe(t2.getRequestId());
    });

    it('accepts a custom request ID', () => {
      const trace = new TraceBuilder('req-custom-123');
      expect(trace.getRequestId()).toBe('req-custom-123');
    });

    it('records pipeline steps in order', () => {
      const trace = new TraceBuilder();
      trace.step('anti_her_screen', { triggered: false });
      trace.step('context_assembly', { itemCount: 5 });
      trace.step('llm_reasoning', { provider: 'claude' });

      const result = trace.build();
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].step).toBe('anti_her_screen');
      expect(result.steps[1].step).toBe('context_assembly');
      expect(result.steps[2].step).toBe('llm_reasoning');
    });

    it('tracks timing for each step', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', {});
      trace.step('llm_reasoning', {});

      const result = trace.build();
      for (const step of result.steps) {
        expect(typeof step.timestamp).toBe('number');
        expect(typeof step.durationMs).toBe('number');
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('computes total duration', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', {});
      const result = trace.build();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('stores step details', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', { itemCount: 7, personas: ['general', 'health'] });

      const result = trace.build();
      expect(result.steps[0].detail.itemCount).toBe(7);
      expect(result.steps[0].detail.personas).toEqual(['general', 'health']);
    });

    it('records error steps', () => {
      const trace = new TraceBuilder();
      trace.error('LLM timeout', { provider: 'openai' });

      const result = trace.build();
      expect(result.steps[0].step).toBe('error');
      expect(result.steps[0].detail.message).toBe('LLM timeout');
    });
  });

  describe('stats tracking', () => {
    it('tracks context item count', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', { itemCount: 12 });
      expect(trace.build().stats.contextItemCount).toBe(12);
    });

    it('tracks tool call count', () => {
      const trace = new TraceBuilder();
      trace.step('tool_call', { name: 'vault_search' });
      trace.step('tool_call', { name: 'contact_lookup' });
      expect(trace.build().stats.toolCallCount).toBe(2);
    });

    it('tracks guard violations', () => {
      const trace = new TraceBuilder();
      trace.step('guard_scan', { violationCount: 3 });
      expect(trace.build().stats.guardViolationCount).toBe(3);
    });

    it('tracks LLM call count', () => {
      const trace = new TraceBuilder();
      trace.step('llm_reasoning', { provider: 'claude' });
      expect(trace.build().stats.llmCallCount).toBe(1);
    });

    it('tracks PII scrubbing', () => {
      const trace = new TraceBuilder();
      trace.step('cloud_gate', { scrubbed: true });
      expect(trace.build().stats.piiScrubbed).toBe(true);
    });

    it('tracks Anti-Her triggering', () => {
      const trace = new TraceBuilder();
      trace.step('anti_her_screen', { triggered: true });
      expect(trace.build().stats.antiHerTriggered).toBe(true);
    });

    it('defaults all stats to zero/false', () => {
      const trace = new TraceBuilder();
      const stats = trace.build().stats;
      expect(stats.contextItemCount).toBe(0);
      expect(stats.toolCallCount).toBe(0);
      expect(stats.guardViolationCount).toBe(0);
      expect(stats.llmCallCount).toBe(0);
      expect(stats.piiScrubbed).toBe(false);
      expect(stats.antiHerTriggered).toBe(false);
    });
  });

  describe('build() immutability', () => {
    it('returns a snapshot — adding more steps does not affect previous build', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', {});
      const first = trace.build();

      trace.step('llm_reasoning', {});
      const second = trace.build();

      expect(first.steps).toHaveLength(1);
      expect(second.steps).toHaveLength(2);
    });
  });

  describe('result structure', () => {
    it('contains all expected fields', () => {
      const trace = new TraceBuilder();
      trace.step('context_assembly', { itemCount: 1 });
      const result = trace.build();

      expect(typeof result.requestId).toBe('string');
      expect(typeof result.startedAt).toBe('number');
      expect(typeof result.totalDurationMs).toBe('number');
      expect(Array.isArray(result.steps)).toBe(true);
      expect(typeof result.stats).toBe('object');
      expect(typeof result.stats.contextItemCount).toBe('number');
    });
  });
});
