/**
 * ask_pipeline tests.
 */

import { CloudGate } from '../src/brain/cloud_gate';
import { NullCoreClient, type CoreOutcome, type VaultItem } from '../src/brain/core_client';
import { ModelRouter, type TaskRoutingPolicy } from '../src/brain/model_router';
import type { ProviderConfig } from '../src/brain/provider_config';
import {
  createAskPipeline,
  DEFAULT_MAX_ITEMS,
  type LlmCallFn,
  type AskRequest,
} from '../src/brain/ask_pipeline';

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    providers: [
      { name: 'local-llama', kind: 'local', models: ['llama-3.2'], defaultModel: 'llama-3.2', enabled: true },
      { name: 'anthropic', kind: 'cloud', models: ['claude-haiku-4-5'], defaultModel: 'claude-haiku-4-5', enabled: true, apiKey: 'sk-test' },
    ],
    ...overrides,
  };
}

function router(
  policy: Partial<TaskRoutingPolicy> = {},
  config: ProviderConfig = providerConfig(),
): ModelRouter {
  const gate = new CloudGate({
    providers: [
      { name: 'local-llama', kind: 'local' },
      { name: 'anthropic', kind: 'cloud' },
    ],
  });
  const defaultPolicy: TaskRoutingPolicy = {
    reasoning: [{ provider: 'anthropic' }, { provider: 'local-llama' }],
    summarisation: [{ provider: 'anthropic' }, { provider: 'local-llama' }],
    classification: [{ provider: 'local-llama' }],
    embedding: [{ provider: 'local-llama' }],
    chat: [{ provider: 'anthropic' }],
    ...policy,
  };
  return new ModelRouter({ config, gate, policy: defaultPolicy });
}

function vaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'v1',
    persona: 'general',
    type: 'email',
    source: 'gmail',
    summary: 'the weekend plans',
    body: 'Join us at the park.',
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function okLlm(text: string): LlmCallFn {
  return async () => ({ ok: true, text });
}

function baseReq(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    persona: 'general',
    query: 'what are we doing this weekend?',
    ...overrides,
  };
}

describe('createAskPipeline — construction', () => {
  it.each([
    ['core', { router: router(), llmFn: okLlm('x') }],
    ['router', { core: new NullCoreClient(), llmFn: okLlm('x') }],
    ['llmFn', { core: new NullCoreClient(), router: router() }],
  ] as const)('throws without %s', (_l, bad) => {
    expect(() =>
      createAskPipeline(
        bad as unknown as Parameters<typeof createAskPipeline>[0],
      ),
    ).toThrow();
  });

  it('DEFAULT_MAX_ITEMS is 10', () => {
    expect(DEFAULT_MAX_ITEMS).toBe(10);
  });
});

describe('createAskPipeline — input validation', () => {
  const ask = createAskPipeline({
    core: new NullCoreClient(),
    router: router(),
    llmFn: okLlm('x'),
  });

  it.each([
    ['null request', null],
    ['empty persona', { persona: '', query: 'q' }],
    ['empty query', { persona: 'p', query: '' }],
    ['whitespace query', { persona: 'p', query: '   ' }],
    ['non-integer maxItems', { persona: 'p', query: 'q', maxItems: 1.5 }],
    ['zero maxItems', { persona: 'p', query: 'q', maxItems: 0 }],
  ] as const)('%s → invalid_input', async (_l, bad) => {
    const r = await ask(bad as AskRequest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_input');
  });
});

describe('createAskPipeline — happy path', () => {
  it('general-tier query routes to anthropic, returns answer + citations', async () => {
    const core = new NullCoreClient({ recordCalls: true });
    // Stub queryVault to return vault items.
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [vaultItem({ id: 'v-a' }), vaultItem({ id: 'v-b' })] });

    const seenLlm: Parameters<LlmCallFn>[0][] = [];
    const llmFn: LlmCallFn = async (input) => {
      seenLlm.push(input);
      return { ok: true, text: 'We are heading to the park.' };
    };

    const ask = createAskPipeline({ core, router: router(), llmFn });
    const r = await ask(baseReq());

    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.answer).toBe('We are heading to the park.');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.tier).toBe('general');
    expect(r.citationIds).toEqual(['v-a', 'v-b']);
    expect(r.context.meta.itemsIncluded).toBe(2);
    expect(seenLlm).toHaveLength(1);
    expect(seenLlm[0]!.prompt).toContain('User query');
    expect(seenLlm[0]!.prompt).toContain('what are we doing this weekend?');
  });

  it('sensitive-tier query routes to local-llama (cloud blocked)', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });

    const seen: Parameters<LlmCallFn>[0][] = [];
    const ask = createAskPipeline({
      core,
      router: router(),
      llmFn: async (input) => {
        seen.push(input);
        return { ok: true, text: 'on-device answer' };
      },
    });

    // Health-coded query → tier = sensitive → personaTier = sensitive → cloud blocked.
    const r = await ask(baseReq({
      query: 'I was diagnosed with depression and prescribed fluoxetine',
    }));
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.tier).toBe('sensitive');
    expect(seen[0]!.provider).toBe('local-llama');
  });

  it('explicit personaTier override wins over tier-derived mapping', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });

    const seen: Parameters<LlmCallFn>[0][] = [];
    const ask = createAskPipeline({
      core,
      router: router(),
      llmFn: async (input) => {
        seen.push(input);
        return { ok: true, text: 'x' };
      },
    });

    // Sensitive content but explicit persona tier = default → cloud allowed.
    const r = await ask(baseReq({
      query: 'I was diagnosed with depression',
      personaTier: 'default',
    }));
    expect(r.ok).toBe(true);
    expect(seen[0]!.provider).toBe('anthropic');
  });
});

describe('createAskPipeline — failure paths', () => {
  it('vault query fails → vault_query_failed', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({
        ok: false,
        error: { code: 'core_error', message: 'db down' },
      });
    const ask = createAskPipeline({ core, router: router(), llmFn: okLlm('x') });
    const r = await ask(baseReq());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('vault_query_failed');
    expect(r.detail).toBe('db down');
  });

  it('no providers for task → no_llm_available', async () => {
    const policyless = router({
      reasoning: [], // empty
    });
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });
    const ask = createAskPipeline({ core, router: policyless, llmFn: okLlm('x') });
    const r = await ask(baseReq());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('no_llm_available');
    expect(r.detail).toMatch(/reasoning/);
  });

  it('all providers cloud-blocked with no local fallback → no_llm_available', async () => {
    // policy only names cloud providers; sensitive content blocks them.
    const cloudOnly = router({
      reasoning: [{ provider: 'anthropic' }],
    });
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });
    const ask = createAskPipeline({
      core, router: cloudOnly, llmFn: okLlm('x'),
    });
    const r = await ask(baseReq({
      query: 'API key: sk-ant-abc123def456ghi7890klmn',
    }));
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('no_llm_available');
    expect(r.detail).toContain('cloud_blocked');
  });

  it('llm returns ok:false → llm_call_failed', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });
    const ask = createAskPipeline({
      core, router: router(),
      llmFn: async () => ({ ok: false, error: 'upstream 503' }),
    });
    const r = await ask(baseReq());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('llm_call_failed');
    expect(r.detail).toBe('upstream 503');
  });

  it('llm returns empty text → llm_call_failed', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({ ok: true, value: [] });
    const ask = createAskPipeline({
      core, router: router(),
      llmFn: async () => ({ ok: true, text: '' }),
    });
    const r = await ask(baseReq());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('llm_call_failed');
  });
});

describe('createAskPipeline — citation accuracy', () => {
  it('citationIds reflects only items that made it into the prompt (not truncated)', async () => {
    const core = new NullCoreClient();
    // Items with oversized bodies that will force context truncation.
    const big = 'y'.repeat(2_000);
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({
        ok: true,
        value: [
          vaultItem({ id: 'a', body: big }),
          vaultItem({ id: 'b', body: big }),
          vaultItem({ id: 'c', body: big }),
          vaultItem({ id: 'd', body: big }),
          vaultItem({ id: 'e', body: big }),
        ],
      });
    const ask = createAskPipeline({
      core, router: router(),
      llmFn: okLlm('answer'),
    });
    const r = await ask(
      baseReq({ contextOptions: { maxChars: 2500, maxItemBodyChars: 2000 } }),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    // Budget forces truncation — included count should be less than 5.
    expect(r.context.meta.itemsIncluded).toBeLessThan(5);
    expect(r.citationIds.length).toBe(r.context.meta.itemsIncluded);
    // Citations are prefix of the fetched ids.
    expect(r.citationIds).toEqual(['a', 'b', 'c', 'd', 'e'].slice(0, r.citationIds.length));
  });
});

describe('createAskPipeline — vault item body fallback', () => {
  it('falls back from body → bodyText → contentL1 → contentL0 → undefined', async () => {
    const core = new NullCoreClient();
    (core as unknown as { queryVault: () => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async () => ({
        ok: true,
        value: [
          vaultItem({ id: 'a', body: 'b-real', contentL1: 'l1', contentL0: 'l0' }),
          vaultItem({ id: 'b', body: undefined, bodyText: 'bt', contentL1: 'l1' }),
          vaultItem({ id: 'c', body: undefined, bodyText: undefined, contentL1: 'l1-only' }),
          vaultItem({ id: 'd', body: undefined, bodyText: undefined, contentL1: undefined, contentL0: 'l0-only' }),
          vaultItem({ id: 'e', body: undefined, bodyText: undefined, contentL1: undefined, contentL0: undefined }),
        ],
      });
    const seen: Parameters<LlmCallFn>[0][] = [];
    const ask = createAskPipeline({
      core, router: router(),
      llmFn: async (input) => {
        seen.push(input);
        return { ok: true, text: 'x' };
      },
    });
    const r = await ask(baseReq());
    if (!r.ok) throw new Error('expected ok');
    // Prompt should include the bodies (prefers body, then bodyText, then L1, then L0).
    const prompt = seen[0]!.prompt;
    expect(prompt).toContain('b-real');
    expect(prompt).toContain('bt');
    expect(prompt).toContain('l1-only');
    expect(prompt).toContain('l0-only');
  });
});
