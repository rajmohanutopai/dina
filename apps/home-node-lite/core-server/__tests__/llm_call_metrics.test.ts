/**
 * Task 5.53 — LLM call metrics tests.
 */

import {
  ESTIMATED_CHARS_PER_TOKEN,
  measureLlmCall,
  toLogFields,
  type LlmCallMetricsRecord,
  type PricingTable,
} from '../src/brain/llm_call_metrics';

/** Deterministic clock factory. */
function clock(start = 1000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const BASE_ID = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  taskType: 'complex_reasoning',
} as const;

describe('measureLlmCall (task 5.53)', () => {
  describe('construction', () => {
    it.each([
      ['provider', { ...BASE_ID, provider: '' }],
      ['model', { ...BASE_ID, model: '' }],
      ['taskType', { ...BASE_ID, taskType: '' }],
    ])('throws on empty %s', (_label, opts) => {
      expect(() => measureLlmCall(opts)).toThrow();
    });
  });

  describe('happy path — explicit token counts', () => {
    it('captures identity + latency + tokens + outcome=ok', () => {
      const c = clock();
      const rec = measureLlmCall({ ...BASE_ID, nowMsFn: c.nowMsFn });
      c.advance(150);
      rec.complete({ inputTokens: 120, outputTokens: 400 });
      const r = rec.done();
      expect(r.provider).toBe('anthropic');
      expect(r.model).toBe('claude-opus-4-7');
      expect(r.taskType).toBe('complex_reasoning');
      expect(r.latencyMs).toBe(150);
      expect(r.outcome).toBe('ok');
      expect(r.tokens).toEqual({
        inputTokens: 120,
        outputTokens: 400,
        estimated: false,
      });
      expect(r.error).toBeNull();
      expect(r.costUsd).toBeNull(); // no pricing table
      expect(r.startedAtMs).toBe(1000);
    });

    it('record is frozen', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.complete({ inputTokens: 1, outputTokens: 1 });
      const r = rec.done();
      expect(Object.isFrozen(r)).toBe(true);
      expect(() => {
        (r as { provider: string }).provider = 'MUTATED';
      }).toThrow();
    });

    it('persona tier + request ids preserved', () => {
      const rec = measureLlmCall({
        ...BASE_ID,
        personaTier: 'sensitive',
        requestId: 'req-1',
        parentId: 'parent-1',
      });
      rec.complete({ inputTokens: 0, outputTokens: 0 });
      const r = rec.done();
      expect(r.personaTier).toBe('sensitive');
      expect(r.requestId).toBe('req-1');
      expect(r.parentId).toBe('parent-1');
    });

    it('omits optional fields when not provided', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.complete({ inputTokens: 1, outputTokens: 1 });
      const r = rec.done();
      expect('personaTier' in r).toBe(false);
      expect('requestId' in r).toBe(false);
      expect('parentId' in r).toBe(false);
    });

    it.each([
      ['negative input', { inputTokens: -1, outputTokens: 0 }],
      ['negative output', { inputTokens: 0, outputTokens: -1 }],
      ['float input', { inputTokens: 1.5, outputTokens: 0 }],
      ['NaN input', { inputTokens: NaN, outputTokens: 0 }],
    ])('rejects %s', (_label, bad) => {
      const rec = measureLlmCall({ ...BASE_ID });
      expect(() => rec.complete(bad as { inputTokens: number; outputTokens: number })).toThrow();
    });
  });

  describe('token estimation from text', () => {
    it('estimates ~4 chars per token + marks estimated=true', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.complete({
        inputText: 'a'.repeat(100), // ~25 tokens
        outputText: 'b'.repeat(400), // ~100 tokens
      });
      const r = rec.done();
      expect(r.tokens).toEqual({
        inputTokens: 25,
        outputTokens: 100,
        estimated: true,
      });
    });

    it('empty text → 0 tokens', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.complete({ inputText: '', outputText: '' });
      const r = rec.done();
      expect(r.tokens!.inputTokens).toBe(0);
      expect(r.tokens!.outputTokens).toBe(0);
    });

    it('rounds UP to the nearest token', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      // 3 chars → ceil(3/4) = 1 token
      rec.complete({ inputText: 'abc', outputText: 'd' });
      const r = rec.done();
      expect(r.tokens!.inputTokens).toBe(1);
      expect(r.tokens!.outputTokens).toBe(1);
    });

    it('ESTIMATED_CHARS_PER_TOKEN is 4', () => {
      expect(ESTIMATED_CHARS_PER_TOKEN).toBe(4);
    });
  });

  describe('fail / cancel / timeout outcomes', () => {
    it('fail(err) captures the error + outcome=failed', () => {
      const c = clock();
      const rec = measureLlmCall({ ...BASE_ID, nowMsFn: c.nowMsFn });
      c.advance(50);
      rec.fail(new Error('provider 500'));
      const r = rec.done();
      expect(r.outcome).toBe('failed');
      expect(r.error).toBe('provider 500');
      expect(r.tokens).toBeNull();
      expect(r.latencyMs).toBe(50);
    });

    it('fail() with non-Error value stringifies', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.fail('crashed');
      expect(rec.done().error).toBe('crashed');
    });

    it('cancel() → outcome=cancelled, error="cancelled"', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.cancel();
      const r = rec.done();
      expect(r.outcome).toBe('cancelled');
      expect(r.error).toBe('cancelled');
    });

    it('timeout() → outcome=timeout', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.timeout();
      expect(rec.done().outcome).toBe('timeout');
    });

    it('first terminal call wins; subsequent ignored', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      rec.complete({ inputTokens: 1, outputTokens: 1 });
      rec.fail(new Error('late-error'));
      rec.cancel();
      const r = rec.done();
      expect(r.outcome).toBe('ok');
      expect(r.error).toBeNull();
    });

    it('done() without terminal state → outcome=failed with diagnostic error', () => {
      const rec = measureLlmCall({ ...BASE_ID });
      const r = rec.done();
      expect(r.outcome).toBe('failed');
      expect(r.error).toMatch(/without a terminal state/);
    });
  });

  describe('pricing + cost', () => {
    const pricing: PricingTable = new Map([
      ['anthropic:claude-opus-4-7', [15, 75] as const], // $15/M input, $75/M output
      ['anthropic:claude-haiku-4-5', [0.8, 4] as const],
    ]);

    it('computes cost when model is in pricing table', () => {
      const rec = measureLlmCall({ ...BASE_ID, pricing });
      rec.complete({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const r = rec.done();
      expect(r.costUsd).toBeCloseTo(15 + 75, 5);
    });

    it('fractional token counts produce fractional cost', () => {
      const rec = measureLlmCall({ ...BASE_ID, pricing });
      rec.complete({ inputTokens: 100, outputTokens: 200 });
      const r = rec.done();
      expect(r.costUsd).toBeCloseTo(
        (100 / 1_000_000) * 15 + (200 / 1_000_000) * 75,
        10,
      );
    });

    it('case-insensitive pricing lookup', () => {
      const rec = measureLlmCall({
        ...BASE_ID,
        provider: 'ANTHROPIC',
        pricing,
      });
      rec.complete({ inputTokens: 100, outputTokens: 100 });
      expect(rec.done().costUsd).not.toBeNull();
    });

    it('unknown model → costUsd=null', () => {
      const rec = measureLlmCall({
        ...BASE_ID,
        model: 'claude-sonnet-4-2',
        pricing,
      });
      rec.complete({ inputTokens: 100, outputTokens: 100 });
      expect(rec.done().costUsd).toBeNull();
    });

    it('failed call → costUsd=null (no tokens)', () => {
      const rec = measureLlmCall({ ...BASE_ID, pricing });
      rec.fail(new Error('x'));
      expect(rec.done().costUsd).toBeNull();
    });
  });
});

describe('toLogFields (task 5.53)', () => {
  it('produces snake_case fields for a successful call', () => {
    const rec = measureLlmCall({
      ...BASE_ID,
      personaTier: 'default',
      requestId: 'req-1',
      parentId: 'parent-1',
    });
    rec.complete({ inputTokens: 10, outputTokens: 20 });
    const fields = toLogFields(rec.done());
    expect(fields).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task_type: 'complex_reasoning',
      outcome: 'ok',
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      tokens_estimated: false,
      persona_tier: 'default',
      request_id: 'req-1',
      parent_id: 'parent-1',
    });
    expect(fields.latency_ms).toBeGreaterThanOrEqual(0);
    expect(fields.started_at_ms).toBeGreaterThan(0);
  });

  it('includes cost_usd when available', () => {
    const pricing: PricingTable = new Map([
      ['anthropic:claude-opus-4-7', [15, 75] as const],
    ]);
    const rec = measureLlmCall({ ...BASE_ID, pricing });
    rec.complete({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const fields = toLogFields(rec.done());
    expect(fields.cost_usd).toBeCloseTo(90, 5);
  });

  it('includes error when outcome !== ok', () => {
    const rec = measureLlmCall({ ...BASE_ID });
    rec.fail(new Error('rate limited'));
    const fields = toLogFields(rec.done());
    expect(fields.error).toBe('rate limited');
    expect(fields.outcome).toBe('failed');
    // No token fields when tokens is null.
    expect('input_tokens' in fields).toBe(false);
  });

  it('omits optional fields when absent', () => {
    const rec = measureLlmCall({ ...BASE_ID });
    rec.complete({ inputTokens: 1, outputTokens: 1 });
    const fields = toLogFields(rec.done());
    expect('persona_tier' in fields).toBe(false);
    expect('request_id' in fields).toBe(false);
    expect('parent_id' in fields).toBe(false);
    expect('cost_usd' in fields).toBe(false);
    expect('error' in fields).toBe(false);
  });

  it('fields are primitives only (logger-safe)', () => {
    const rec = measureLlmCall({
      ...BASE_ID,
      personaTier: 'sensitive',
      requestId: 'r1',
    });
    rec.complete({ inputTokens: 5, outputTokens: 5 });
    const fields = toLogFields(rec.done());
    for (const v of Object.values(fields)) {
      const t = typeof v;
      expect(['string', 'number', 'boolean']).toContain(t);
    }
  });
});

describe('realistic call sequence', () => {
  it('measures a full round-trip with trace + pricing + personaTier', () => {
    const c = clock();
    const pricing: PricingTable = new Map([
      ['anthropic:claude-haiku-4-5', [0.8, 4] as const],
    ]);
    const rec = measureLlmCall({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      taskType: 'intent_classification',
      personaTier: 'default',
      requestId: '37a2b64b1c0f4b8eaf3c6d98a5f14c9e',
      nowMsFn: c.nowMsFn,
      pricing,
    });
    c.advance(42);
    rec.complete({ inputTokens: 250, outputTokens: 40 });
    const r: LlmCallMetricsRecord = rec.done();
    expect(r.outcome).toBe('ok');
    expect(r.latencyMs).toBe(42);
    expect(r.tokens!.estimated).toBe(false);
    expect(r.costUsd).toBeCloseTo(
      (250 / 1_000_000) * 0.8 + (40 / 1_000_000) * 4,
      10,
    );
    expect(r.personaTier).toBe('default');
    expect(r.requestId).toBe('37a2b64b1c0f4b8eaf3c6d98a5f14c9e');
  });
});
