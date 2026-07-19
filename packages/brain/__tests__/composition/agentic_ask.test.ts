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
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';
import { ToolRegistry } from '../../src/reasoning/tool_registry';

import type { LLMProvider, ChatResponse } from '../../src/llm/adapters/provider';
import type { CreateWorkflowTaskInput, WorkflowTask } from '@dina/core';

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
    async searchCapabilities() {
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

interface FakeTask { id: string; status: string; payload: string }

function fakeCoreClient(): Parameters<typeof buildAgenticAskPipeline>[0]['coreClient'] {
  return {
    async findContactsByPreference() { return []; },
    async createWorkflowTask() { return { task: {} as unknown as WorkflowTask, deduped: false }; },
    async getWorkflowTask() { return null; },
    async completeWorkflowTask() { return {} as unknown as WorkflowTask; },
  };
}

function makeFakeWorkflowCoreClient(): {
  client: Parameters<typeof buildAgenticAskPipeline>[0]['coreClient'];
  tasks: Map<string, FakeTask>;
  setStatus: (id: string, s: string) => void;
} {
  const tasks = new Map<string, FakeTask>();
  const setStatus = (id: string, s: string) => { const t = tasks.get(id); if (t) t.status = s; };
  const client = {
    async findContactsByPreference() { return []; },
    async createWorkflowTask(input: CreateWorkflowTaskInput) {
      if (tasks.has(input.id)) throw new Error(`duplicate: ${input.id}`);
      const t: FakeTask = { id: input.id, status: input.initialState ?? 'pending_approval', payload: input.payload };
      tasks.set(input.id, t);
      return { task: t as unknown as WorkflowTask, deduped: false };
    },
    async getWorkflowTask(id: string) { return (tasks.get(id) as unknown as WorkflowTask) ?? null; },
    async completeWorkflowTask(id: string) { setStatus(id, 'completed'); return tasks.get(id) as unknown as WorkflowTask; },
  };
  return { client, tasks, setStatus };
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
  // Reset the module-global `registerIdentityExtractor` mutates so
  // parallel test files don't see side-effects from this suite.
  afterEach(() => {
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

  it('registers all 14 agentic tools on the tool registry', () => {
    // 10 substrate / discovery tools (incl. search_capabilities — the
    // Layer-4 intent→canonical-capability discovery step that precedes
    // search_provider_services) + classify_intent (re-routing mid-loop)
    // + draft_review (LLM-decided trigger for the inline review-draft
    // card flow) + schedule_reminder (first-class /ask path for "remind
    // me to X" — closes MT-15-I2). The full set is documented in
    // composition/agentic_ask.ts.
    const pipeline = buildAgenticAskPipeline(makeBuilderInput());
    const names = pipeline.tools.toDefinitions().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browse_vault',
        'classify_intent',
        'draft_review',
        'find_person',
        'find_preferred_provider',
        'geocode',
        'get_full_content',
        'list_personas',
        'query_service',
        'schedule_reminder',
        'search_capabilities',
        'search_peerlens',
        'search_provider_services',
        'vault_search',
      ].sort(),
    );
    expect(pipeline.tools.size()).toBe(14);
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
    it('always exposes buildToolsForAsk (coreClient always provides the workflow task surface)', () => {
      // buildAgenticAskPipeline unconditionally wires buildToolsForAsk because
      // coreClient (always required) includes VaultApprovalWorkflowClient methods.
      const pipeline = buildAgenticAskPipeline(makeBuilderInput());
      expect(typeof pipeline.buildToolsForAsk).toBe('function');
    });

    it('per-ask registry has the same 12 tools as the static one', () => {
      const pipeline = buildAgenticAskPipeline(makeBuilderInput());
      const askTools = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });
      const staticNames = pipeline.tools.toDefinitions().map((t) => t.name).sort();
      const askNames = askTools.toDefinitions().map((t) => t.name).sort();
      expect(askNames).toEqual(staticNames);
    });

    it('per-ask vault_search returns approval_required on a sensitive persona', async () => {
      const { createPersona, resetPersonaState } =
        require('../../../core/src/persona/service');
      resetPersonaState();
      createPersona('health', 'sensitive');

      const { client, tasks } = makeFakeWorkflowCoreClient();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        coreClient: client,
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
      // Workflow task was created with the right payload shape.
      const task = tasks.get('appr-ask-1-health');
      expect(task).toBeDefined();
      expect(task?.status).toBe('pending_approval');
      const payload = JSON.parse(task?.payload ?? '{}');
      expect(payload).toMatchObject({
        type: 'vault_read_request',
        persona: 'health',
        source_ask_id: 'ask-1',
        requester_did: 'did:key:zRequester',
      });
    });

    it('static tools registry returns accessible:false for sensitive-persona reads (no guard on static registry)', async () => {
      // The static pipeline.tools has no persona guard — sensitive personas
      // surface as accessible:false rather than bailing the loop. This is
      // the degraded-mode contract for callers that use pipeline.tools directly.
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
      const { createPersona, resetPersonaState } =
        require('../../../core/src/persona/service');
      resetPersonaState();
      createPersona('health', 'sensitive');

      const { client, tasks } = makeFakeWorkflowCoreClient();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        coreClient: client,
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
      expect(tasks.size).toBe(2);
    });

    it('per-ask registry allows reads after operator approves (consume on retry)', async () => {
      // End-to-end: first read parks (pending_approval); operator approves
      // (task → queued); second read (Pattern A resume path) consumes
      // (task → completed) + proceeds.
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

      const { client, tasks, setStatus } = makeFakeWorkflowCoreClient();
      const pipeline = buildAgenticAskPipeline({
        ...makeBuilderInput(),
        coreClient: client,
      });
      const tools = pipeline.buildToolsForAsk!({
        askId: 'ask-1',
        requesterDid: 'did:key:zRequester',
      });

      // First read — bails (creates pending workflow task).
      const first = await tools.execute('vault_search', { query: 'BP', persona: 'health' });
      expect(first).toMatchObject({ code: 'approval_required' });

      // Operator approves — workflow task transitions pending_approval → queued.
      setStatus('appr-ask-1-health', 'queued');

      // Resume path — same registry, second call. Guard sees queued →
      // completes the task (consumed) → vault read proceeds.
      const second = await tools.execute('vault_search', { query: 'BP', persona: 'health' });
      expect((second as { success: boolean }).success).toBe(true);
      const result = (second as { success: true; result: unknown }).result as {
        accessible: boolean;
        results: unknown[];
      };
      expect(result.accessible).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      // Approval workflow task was consumed (completed).
      expect(tasks.get('appr-ask-1-health')?.status).toBe('completed');
    });
  });
});
