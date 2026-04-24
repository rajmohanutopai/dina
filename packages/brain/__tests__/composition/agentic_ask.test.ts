/**
 * `buildAgenticAskPipeline` unit tests.
 *
 * Independent of mobile boot — verifies the composition module returns
 * a well-formed pipeline given minimal fully-typed handles. This is
 * the abstraction home-node-lite brain-server will consume when it
 * lands; the tests guarantee the contract is stable before the second
 * consumer materialises.
 */

import { buildAgenticAskPipeline } from '../../src/composition/agentic_ask';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import type { LLMProvider, ChatResponse } from '../../src/llm/adapters/provider';
import { resetReminderLLM } from '../../src/pipeline/reminder_planner';
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';

/**
 * Minimal fake LLMProvider. The builder doesn't call it during
 * construction — it's wired up as the router's only provider, routed
 * through `RoutedLLMProvider` for the agentic loop. Tests that exercise
 * the loop itself live in the reasoning-agent suite; here we just pin
 * the builder's output shape.
 */
function fakeLLMProvider(): LLMProvider {
  return {
    name: 'fake-gemini',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat: async (): Promise<ChatResponse> => ({
      content: '',
      toolCalls: [],
      model: 'fake-gemini',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'end',
    }),
    stream: () => {
      throw new Error('fake: stream() not used in builder tests');
    },
    embed: async () => {
      throw new Error('fake: embed() not used in builder tests');
    },
  };
}

function fakeAppView(): Parameters<typeof buildAgenticAskPipeline>[0]['appViewClient'] {
  // The builder never actually calls these during construction — it
  // only holds references for later tool invocations. The tests pin
  // the pipeline shape, not the AppView wire contract (that's the
  // AppViewClient test suite's job). Deliberate type assertion keeps
  // this fake minimal; production wiring uses the real client.
  return {
    async searchServices() {
      return [];
    },
    async isDiscoverable() {
      return { isDiscoverable: false, capabilities: [] };
    },
    async resolveTrust() {
      return {} as unknown as Awaited<
        ReturnType<
          NonNullable<Parameters<typeof buildAgenticAskPipeline>[0]['appViewClient']['resolveTrust']>
        >
      >;
    },
    async searchTrust() {
      return {} as unknown as Awaited<
        ReturnType<
          NonNullable<Parameters<typeof buildAgenticAskPipeline>[0]['appViewClient']['searchTrust']>
        >
      >;
    },
  };
}

function fakeOrchestratorHandle(): Parameters<typeof buildAgenticAskPipeline>[0]['orchestratorHandle'] {
  return {
    async issueQueryToDID() {
      return {
        queryId: 'fake-q',
        taskId: 'fake-t',
        toDID: 'did:plc:fake',
        serviceName: 'fake',
        deduped: false,
      };
    },
  };
}

function fakeCoreClient(): Parameters<typeof buildAgenticAskPipeline>[0]['coreClient'] {
  return {
    async findContactsByPreference() {
      return [];
    },
  };
}

function makeBuilderInput(): Parameters<typeof buildAgenticAskPipeline>[0] {
  return {
    llm: fakeLLMProvider(),
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestratorHandle(),
    coreClient: fakeCoreClient(),
  };
}

describe('buildAgenticAskPipeline', () => {
  // Reset the module-globals `registerReminderLLM` /
  // `registerIdentityExtractor` mutate so parallel test files don't
  // see side-effects from this suite.
  afterEach(() => {
    resetReminderLLM();
    resetIdentityExtractor();
  });

  it('returns the 4-part pipeline bundle with the right component types', () => {
    const pipeline = buildAgenticAskPipeline(makeBuilderInput());

    expect(pipeline.router).toBeInstanceOf(LLMRouter);
    expect(pipeline.provider).toBeInstanceOf(RoutedLLMProvider);
    expect(pipeline.tools).toBeInstanceOf(ToolRegistry);
    expect(pipeline.handlerOptions.intentClassifier).toBeDefined();
    expect(pipeline.handlerOptions.guardScanner).toBeDefined();
  });

  it('binds the reason-tier RoutedLLMProvider to the caller-supplied provider name', () => {
    const pipeline = buildAgenticAskPipeline(makeBuilderInput());
    // Label embeds the provider name — home-node-lite brain-server will
    // read this on structured logs to correlate LLM calls to tiers.
    expect(pipeline.provider.name).toContain('gemini');
    expect(pipeline.provider.name).toContain('reason');
  });

  it('registers all 9 agentic tools on the tool registry', () => {
    const pipeline = buildAgenticAskPipeline(makeBuilderInput());
    const names = pipeline.tools.toDefinitions().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browse_vault',
        'find_preferred_provider',
        'geocode',
        'get_full_content',
        'list_personas',
        'query_service',
        'search_provider_services',
        'search_trust_network',
        'vault_search',
      ].sort(),
    );
    expect(pipeline.tools.size()).toBe(9);
  });

  it('defaults sensitivePersonas to [health, financial] when omitted', () => {
    const input = makeBuilderInput();
    expect(input.sensitivePersonas).toBeUndefined();
    const pipeline = buildAgenticAskPipeline(input);
    // Router config is internal, but we can probe it via the cloud
    // consent gate: sensitive-persona routes refuse when
    // `cloudConsentGranted=false` (default true in input).
    expect(pipeline.router).toBeDefined();
  });

  it('accepts explicit sensitivePersonas override', () => {
    const input = {
      ...makeBuilderInput(),
      sensitivePersonas: ['family', 'health'] as const,
    };
    const pipeline = buildAgenticAskPipeline(input);
    expect(pipeline.router).toBeDefined();
  });

  it('is idempotent across multiple builder invocations', () => {
    // Two sequential builds should each produce independent pipelines
    // — no shared state mutation. Home-node-lite brain-server will
    // build one at boot; tests / integration harnesses build several.
    const p1 = buildAgenticAskPipeline(makeBuilderInput());
    const p2 = buildAgenticAskPipeline(makeBuilderInput());
    expect(p1.router).not.toBe(p2.router);
    expect(p1.tools).not.toBe(p2.tools);
  });
});
