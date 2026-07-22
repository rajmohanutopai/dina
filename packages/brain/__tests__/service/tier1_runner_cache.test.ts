/**
 * Tier-1 runner — provider answer cache (cost control). Proves that repeated
 * identical service queries collapse to ONE LLM call within the freshness
 * window, and that the cache is correctly bypassed for the cases that must
 * always recompute: review-policy, no declared freshness, an edited
 * instruction, an expired window, and different params.
 *
 * The scripted LLM records every `chat` call, so `systems.length` == the number
 * of cache MISSES (each miss drives exactly one chat with the permissive schema).
 */

import { Tier1AnswerCache } from '../../src/service/answer_cache';
import { makeTier1CapabilityRunner } from '../../src/service/tier1_runner';

import type { ChatOptions, ChatResponse, LLMProvider } from '../../src/llm/adapters/provider';
import type { WorkflowTask } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

const NOW = 1_750_000_000_000;
const VALID = { status: 'on_route', eta_minutes: 7 };

function scriptedProvider(): { provider: LLMProvider; calls: () => number } {
  const systems: string[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(_messages, options?: ChatOptions): Promise<ChatResponse> {
      systems.push(options?.systemPrompt ?? '');
      return {
        content: JSON.stringify(VALID),
        toolCalls: [],
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'end',
      };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('not used');
    },
    async embed() {
      throw new Error('not used');
    },
  };
  return { provider, calls: () => systems.length };
}

/** A cacheable listing: auto policy, read capability, a published schema that
 *  declares `defaultTtlSeconds` (the freshness window). */
function etaConfig(over: {
  responsePolicy?: 'auto' | 'review';
  defaultTtlSeconds?: number;
  instructionUpdatedAt?: number;
} = {}): ServiceConfig {
  return {
    isDiscoverable: true,
    discoverability: 'public',
    status: 'active',
    name: 'Route 42 Dispatch',
    capabilities: {
      eta_query: {
        responsePolicy: over.responsePolicy ?? 'auto',
        category: 'transit',
        instruction: 'Give the current ETA.',
        instructionUpdatedAt: over.instructionUpdatedAt ?? NOW - 60_000,
      },
    },
    capabilitySchemas: {
      eta_query: {
        params: { type: 'object' },
        result: { type: 'object' },
        schemaHash: 'schema-hash-1',
        ...(over.defaultTtlSeconds !== undefined
          ? { defaultTtlSeconds: over.defaultTtlSeconds }
          : {}),
      },
    },
  } as unknown as ServiceConfig;
}

function task(id: string, params: Record<string, unknown> = { route_id: '42' }): WorkflowTask {
  return {
    id,
    kind: 'delegation',
    status: 'running',
    priority: 'normal',
    description: 'test',
    payload: JSON.stringify({
      type: 'service_query_execution',
      from_did: 'did:plc:customer',
      query_id: `q-${id}`,
      capability: 'eta_query',
      params,
    }),
    policy: '{}',
    result_summary: '',
    created_at: NOW,
    updated_at: NOW,
  } as WorkflowTask;
}

function makeRunner(config: () => ServiceConfig, nowMsFn: () => number) {
  const { provider, calls } = scriptedProvider();
  const runner = makeTier1CapabilityRunner({
    getLLM: () => provider,
    nowMsFn,
    readConfig: () => config(),
    answerCache: new Tier1AnswerCache({ nowMsFn }),
  });
  return { runner, calls };
}

describe('Tier-1 runner — provider answer cache', () => {
  it('serves 3 identical auto/read queries with ONE LLM call', async () => {
    const { runner, calls } = makeRunner(() => etaConfig({ defaultTtlSeconds: 60 }), () => NOW);
    const r1 = await runner('eta_query', { route_id: '42' }, task('a'));
    const r2 = await runner('eta_query', { route_id: '42' }, task('b'));
    const r3 = await runner('eta_query', { route_id: '42' }, task('c'));
    expect(r1).toEqual(VALID);
    expect(r2).toEqual(VALID);
    expect(r3).toEqual(VALID);
    expect(calls()).toBe(1); // 2nd + 3rd were cache hits
  });

  it('does NOT cache a review-policy capability (per-response approval kept)', async () => {
    const { runner, calls } = makeRunner(
      () => etaConfig({ responsePolicy: 'review', defaultTtlSeconds: 60 }),
      () => NOW,
    );
    await runner('eta_query', { route_id: '42' }, task('a'));
    await runner('eta_query', { route_id: '42' }, task('b'));
    expect(calls()).toBe(2);
  });

  it('does NOT cache when the provider declares no freshness (defaultTtlSeconds)', async () => {
    const { runner, calls } = makeRunner(() => etaConfig({}), () => NOW);
    await runner('eta_query', { route_id: '42' }, task('a'));
    await runner('eta_query', { route_id: '42' }, task('b'));
    expect(calls()).toBe(2);
  });

  it('recomputes after the freshness window expires', async () => {
    let now = NOW;
    const { runner, calls } = makeRunner(() => etaConfig({ defaultTtlSeconds: 60 }), () => now);
    await runner('eta_query', { route_id: '42' }, task('a'));
    now = NOW + 60_000; // one full TTL later
    await runner('eta_query', { route_id: '42' }, task('b'));
    expect(calls()).toBe(2);
  });

  it('busts the cache when the provider edits the instruction', async () => {
    let updatedAt = NOW - 60_000;
    const { runner, calls } = makeRunner(
      () => etaConfig({ defaultTtlSeconds: 60, instructionUpdatedAt: updatedAt }),
      () => NOW,
    );
    await runner('eta_query', { route_id: '42' }, task('a'));
    updatedAt = NOW; // provider edited the instruction
    await runner('eta_query', { route_id: '42' }, task('b'));
    expect(calls()).toBe(2);
  });

  it('keys separate params to separate cache entries', async () => {
    const { runner, calls } = makeRunner(() => etaConfig({ defaultTtlSeconds: 60 }), () => NOW);
    await runner('eta_query', { route_id: '42' }, task('a', { route_id: '42' }));
    await runner('eta_query', { route_id: '7' }, task('b', { route_id: '7' }));
    await runner('eta_query', { route_id: '42' }, task('c', { route_id: '42' })); // hit
    expect(calls()).toBe(2);
  });
});
