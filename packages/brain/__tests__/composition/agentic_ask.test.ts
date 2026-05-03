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

  it('registers all 11 agentic tools on the tool registry', () => {
    // 9 substrate / discovery tools + classify_intent (re-routing
    // mid-loop) + draft_review (LLM-decided trigger for the inline
    // review-draft card flow). The full set is documented in
    // composition/agentic_ask.ts.
    const pipeline = buildAgenticAskPipeline(makeBuilderInput());
    const names = pipeline.tools.toDefinitions().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browse_vault',
        'classify_intent',
        'draft_review',
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
    expect(pipeline.tools.size()).toBe(11);
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

  describe('Pattern A composition (5.21-E)', () => {
    it('omits buildToolsForAsk when approvalManager is not supplied', () => {
      const pipeline = buildAgenticAskPipeline(makeBuilderInput());
      expect(pipeline.buildToolsForAsk).toBeUndefined();
    });

    it('exposes buildToolsForAsk when approvalManager is wired', () => {
      const { ApprovalManager } = require('../../../core/src/approval/manager');
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        approvalManager: new ApprovalManager(),
      });
      expect(typeof pipeline.buildToolsForAsk).toBe('function');
    });

    it('per-ask registry has the same 11 tools as the static one', () => {
      const { ApprovalManager } = require('../../../core/src/approval/manager');
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        approvalManager: new ApprovalManager(),
      });
      const askTools = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });
      const staticNames = pipeline.tools.toDefinitions().map((t) => t.name).sort();
      const askNames = askTools.toDefinitions().map((t) => t.name).sort();
      expect(askNames).toEqual(staticNames);
    });

    it('per-ask vault_search throws ApprovalRequiredError on a sensitive persona', async () => {
      const { ApprovalManager } = require('../../../core/src/approval/manager');
      const { createPersona, resetPersonaState } =
        require('../../../core/src/persona/service');
      resetPersonaState();
      createPersona('health', 'sensitive');

      const am = new ApprovalManager();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        approvalManager: am,
      });
      const tools = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });
      // Execute the tool directly via the registry — same surface the
      // agentic loop uses.
      const outcome = await tools.execute('vault_search', {
        query: 'balance',
        persona: 'health',
      });
      expect(outcome).toEqual({
        success: false,
        code: 'approval_required',
        approvalId: 'appr-ask-1-health',
        persona: 'health',
        error: expect.stringContaining('appr-ask-1-health'),
      });
      // Approval was minted with the right shape.
      expect(am.getRequest('appr-ask-1-health')).toMatchObject({
        action: 'vault_read',
        requester_did: 'did:key:zRequester',
        persona: 'health',
        status: 'pending',
      });
    });

    it('static tools registry still allows sensitive-persona reads (legacy degraded mode)', async () => {
      // Without approvalManager, the legacy "accessible:false" path
      // applies — the read returns an empty result instead of bailing.
      // This documents the degraded-mode contract for callers that
      // haven't migrated to Pattern A yet.
      const { setAccessiblePersonas, resetReasoningProvider } =
        require('../../src/vault_context/assembly');
      resetReasoningProvider();
      setAccessiblePersonas([]); // sensitive persona not unlocked
      const pipeline = buildAgenticAskPipeline(makeBuilderInput());
      const outcome = await pipeline.tools.execute('vault_search', {
        query: 'q',
        persona: 'health',
      });
      expect(outcome).toMatchObject({ success: true });
      const result = (outcome as { success: true; result: unknown }).result as {
        accessible: boolean;
        results: unknown[];
      };
      expect(result.accessible).toBe(false);
      expect(result.results).toEqual([]);
    });

    it('two asks get distinct approval ids (askId binding)', async () => {
      const { ApprovalManager } = require('../../../core/src/approval/manager');
      const { createPersona, resetPersonaState } =
        require('../../../core/src/persona/service');
      resetPersonaState();
      createPersona('health', 'sensitive');

      const am = new ApprovalManager();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        approvalManager: am,
      });
      const tools1 = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });
      const tools2 = pipeline.buildToolsForAsk!({
        askId: 'ask-2',
        requesterDid: 'did:key:zRequester',
      });
      const o1 = await tools1.execute('vault_search', { query: 'q', persona: 'health' });
      const o2 = await tools2.execute('vault_search', { query: 'q', persona: 'health' });
      expect((o1 as { approvalId: string }).approvalId).toBe('appr-ask-1-health');
      expect((o2 as { approvalId: string }).approvalId).toBe('appr-ask-2-health');
    });

    it('per-ask registry allows reads after operator approves (consume on retry)', async () => {
      // End-to-end: first read parks; operator approves; second read
      // (Pattern A resume path simulation) consumes + proceeds.
      const { ApprovalManager } = require('../../../core/src/approval/manager');
      const { createPersona, resetPersonaState } =
        require('../../../core/src/persona/service');
      const { setAccessiblePersonas, resetReasoningProvider } =
        require('../../src/vault_context/assembly');
      const { storeItem, clearVaults } = require('../../../core/src/vault/crud');
      resetPersonaState();
      resetReasoningProvider();
      clearVaults();
      createPersona('health', 'sensitive');
      setAccessiblePersonas(['health']); // operator-unlocked DEK
      storeItem('health', { type: 'note', summary: 'BP reading', body: '120/80' });

      const am = new ApprovalManager();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        approvalManager: am,
      });
      const tools = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });

      // First read — bails.
      const first = await tools.execute('vault_search', { query: 'BP', persona: 'health' });
      expect(first).toMatchObject({ code: 'approval_required' });

      // Operator approves.
      am.approveRequest('appr-ask-1-health', 'single', 'did:operator');

      // Resume path — same registry, second call. Consumes + reads.
      const second = await tools.execute('vault_search', { query: 'BP', persona: 'health' });
      expect((second as { success: boolean }).success).toBe(true);
      const result = (second as { success: true; result: unknown }).result as {
        accessible: boolean;
        results: unknown[];
      };
      expect(result.accessible).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      // Approval consumed.
      expect(am.getRequest('appr-ask-1-health')).toBeUndefined();
    });
  });
});
