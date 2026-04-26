/**
 * Pattern A end-to-end — capstone integration test for 5.21-E.
 *
 * Wires every piece built in 5.21-A through 5.21-E into one closed
 * loop and pins the full bail/approve/resume cycle:
 *
 *   1. `buildAgenticAskPipeline({approvalManager, ...})` → pipeline
 *      with `buildToolsForAsk`.
 *   2. `AskRegistry` + `AskApprovalGateway` + `AskApprovalResumer`
 *      wired with both `executeFn` (Pattern B fallback) and
 *      `resumeFromPausedFn` (Pattern A primary).
 *   3. Mock LLM provider that emits a `vault_search` tool call on
 *      a sensitive persona on the first turn, then a final answer
 *      after the tool returns real data.
 *   4. Ask submits → loop bails on approval_required → registry
 *      parks `pending_approval` → operator approves via gateway →
 *      registry emits `approval_resumed` → resumer fires →
 *      `resumeAgenticTurn` re-runs the bailing tool (which now
 *      consumes the approval and reads the vault) → loop completes
 *      with the answer → registry transitions to `complete`.
 *
 * No HTTP, no real LLM, no real vault file. Pure in-memory wiring.
 */

import { ApprovalManager } from '../../../core/src/approval/manager';
import {
  createPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { clearVaults, storeItem } from '../../../core/src/vault/crud';
import {
  AskRegistry,
  InMemoryAskAdapter,
  type AskEvent,
} from '../../src/ask/ask_registry';
import {
  AskApprovalGateway,
  type ApprovalSource,
} from '../../src/ask/ask_approval_gateway';
import {
  AskApprovalResumer,
  type AskApprovalResumerEvent,
} from '../../src/ask/ask_approval_resumer';
import {
  buildAgenticAskPipeline,
  type AgenticAskPipeline,
  type BuildAgenticAskPipelineInput,
} from '../../src/composition/agentic_ask';
import {
  resumeAgenticTurn,
  runAgenticTurn,
  type AgenticLoopResult,
} from '../../src/reasoning/agentic_loop';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';
import { resetReminderLLM } from '../../src/pipeline/reminder_planner';
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';

const REQUESTER = 'did:key:zRequester';
const SYSTEM_PROMPT = 'You answer the user with the help of vault tools.';

// ──────────────────────────────────────────────────────────────────────
// Scripted LLM provider — emits queued responses in order. Captures
// every chat call so the test can introspect how the loop proceeded.
// ──────────────────────────────────────────────────────────────────────

interface ScriptedCall {
  messages: ChatMessage[];
  options: ChatOptions | undefined;
}

function makeScripted(): {
  provider: LLMProvider;
  calls: ScriptedCall[];
  push: (...rs: ChatResponse[]) => void;
} {
  const calls: ScriptedCall[] = [];
  const queue: ChatResponse[] = [];
  const provider: LLMProvider = {
    name: 'scripted',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat: async (messages, options) => {
      calls.push({ messages, options });
      const next = queue.shift();
      if (!next) throw new Error('ScriptedProvider: no responses queued');
      return next;
    },
    stream: () => {
      throw new Error('not used');
    },
    embed: async () => {
      throw new Error('not used');
    },
  };
  return {
    provider,
    calls,
    push: (...rs) => {
      queue.push(...rs);
    },
  };
}

function toolCallResp(call: ToolCall): ChatResponse {
  return {
    content: '',
    toolCalls: [call],
    model: 'scripted',
    usage: { inputTokens: 10, outputTokens: 10 },
    finishReason: 'tool_use',
  };
}

function answerResp(text: string): ChatResponse {
  return {
    content: text,
    toolCalls: [],
    model: 'scripted',
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: 'end',
  };
}

// ──────────────────────────────────────────────────────────────────────
// AppView / orchestrator stubs — none of these matter for Pattern A,
// the loop only ever exercises vault tools. Shapes copied from
// agentic_ask.test.ts which already knows the right contracts.
// ──────────────────────────────────────────────────────────────────────

function fakeAppView(): BuildAgenticAskPipelineInput['appViewClient'] {
  return {
    async searchServices() {
      return [];
    },
    async isDiscoverable() {
      return { isDiscoverable: false, capabilities: [] };
    },
    async resolveTrust() {
      return {} as unknown as Awaited<
        ReturnType<NonNullable<BuildAgenticAskPipelineInput['appViewClient']['resolveTrust']>>
      >;
    },
    async searchTrust() {
      return {} as unknown as Awaited<
        ReturnType<NonNullable<BuildAgenticAskPipelineInput['appViewClient']['searchTrust']>>
      >;
    },
  };
}

function fakeOrchestrator(): BuildAgenticAskPipelineInput['orchestratorHandle'] {
  return {
    async issueQueryToDID() {
      return {
        queryId: 'noop',
        taskId: 'noop',
        toDID: 'did:plc:noop',
        serviceName: 'noop',
        deduped: false,
      };
    },
  };
}

function fakeCoreClient(): BuildAgenticAskPipelineInput['coreClient'] {
  return {
    async findContactsByPreference() {
      return [];
    },
  };
}

function builderInputWithApprovalManager(
  approvalManager: ApprovalManager,
  llm: LLMProvider,
): BuildAgenticAskPipelineInput {
  return {
    llm,
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestrator(),
    coreClient: fakeCoreClient(),
    cloudConsentGranted: true,
    approvalManager,
  };
}

function approvalManagerSource(am: ApprovalManager): ApprovalSource {
  return {
    getStatus(id) {
      const r = am.getRequest(id);
      if (!r) return 'unknown';
      if (r.status === 'pending') return 'pending';
      if (r.status === 'approved') return 'approved';
      return 'denied';
    },
    approve(id) {
      am.approveRequest(id, 'single', 'test-operator');
    },
    deny(id) {
      am.denyRequest(id);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('Pattern A end-to-end (5.21-E capstone)', () => {
  beforeEach(() => {
    resetPersonaState();
    resetReasoningProvider();
    clearVaults();
    setAccessiblePersonas([]); // emulate sensitive personas not yet open
  });

  afterEach(() => {
    resetReminderLLM();
    resetIdentityExtractor();
  });

  it('full bail → approve → resume → complete cycle parks then answers', async () => {
    // Set up vault data the LLM will eventually read.
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']); // operator-unlocked DEK so the post-approval read finds rows
    storeItem('health', {
      type: 'note',
      summary: 'BP reading from yesterday',
      body: '120/80 morning',
    });

    // The scripted LLM:
    //  - First chat: emit vault_search tool call on 'health'.
    //  - Second chat (after resume): final answer.
    const llm = makeScripted();
    llm.push(
      toolCallResp({ id: 'call-1', name: 'vault_search', arguments: { query: 'BP', persona: 'health' } }),
      answerResp('Your blood pressure was 120/80.'),
    );

    const approvalManager = new ApprovalManager();
    const pipeline: AgenticAskPipeline = buildAgenticAskPipeline(
      builderInputWithApprovalManager(approvalManager, llm.provider),
    );
    expect(pipeline.buildToolsForAsk).toBeDefined();

    // Wire the registry + resumer chain.
    const resumerEvents: AskApprovalResumerEvent[] = [];
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e: AskEvent) => {
        resumer?.handle(e);
      },
    });
    resumer = new AskApprovalResumer({
      registry,
      onEvent: (e) => resumerEvents.push(e),
      resumeFromPausedFn: async (pausedState, ctx) => {
        const tools = pipeline.buildToolsForAsk!({
          askId: ctx.askId,
          requesterDid: ctx.requesterDid,
        });
        return resumeAgenticTurn({
          provider: pipeline.provider,
          tools,
          systemPrompt: SYSTEM_PROMPT,
          pausedState,
        });
      },
    });

    // Submit the ask: enqueue + run loop manually (no HTTP). The
    // production handler does enqueue → runAgenticTurn → applyOutcome
    // in one go; we inline that here.
    const askId = 'ask-1';
    await registry.enqueue({ id: askId, question: 'what was my BP?', requesterDid: REQUESTER });

    // First turn: build per-ask tools, run agentic turn.
    const tools = pipeline.buildToolsForAsk!({ askId, requesterDid: REQUESTER });
    const firstResult: AgenticLoopResult = await runAgenticTurn({
      provider: pipeline.provider,
      tools,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: 'what was my BP?',
    });

    // Loop bailed on approval_required.
    expect(firstResult.finishReason).toBe('approval_required');
    expect(firstResult.pausedState).toBeDefined();
    expect(firstResult.pausedState!.approvalId).toBe('appr-ask-1-health');
    expect(firstResult.pausedState!.persona).toBe('health');

    // Park the ask manually (in production, applyOutcome inside the
    // ask handler does this; here we drive the registry directly).
    await registry.markPendingApproval(
      askId,
      firstResult.pausedState!.approvalId,
      JSON.stringify(firstResult.pausedState),
    );

    let parked = await registry.get(askId);
    expect(parked?.status).toBe('pending_approval');
    expect(parked?.approvalId).toBe('appr-ask-1-health');
    expect(parked?.pausedStateJson).toBeDefined();

    // Operator approves via the gateway. The gateway transitions
    // pending_approval → in_flight, fires `approval_resumed`, and
    // the registry's onEvent → resumer.handle → resume() chain fires
    // resumeFromPausedFn. The resume re-runs vault_search; the guard
    // sees the now-approved single-scope grant, consumes it, and
    // returns null. The tool then reads vault data, the LLM emits
    // its final answer, and applyAgenticResult marks complete.
    const gateway = new AskApprovalGateway({
      askRegistry: registry,
      approvalSource: approvalManagerSource(approvalManager),
    });
    await gateway.approve('appr-ask-1-health');

    // Wait one microtask flush so the fire-and-forget resume settles.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const final = await registry.get(askId);
    expect(final?.status).toBe('complete');
    expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({
      text: 'Your blood pressure was 120/80.',
    });

    // Approval was consumed.
    expect(approvalManager.getRequest('appr-ask-1-health')).toBeUndefined();

    // Resumer emitted resumed_completed.
    expect(resumerEvents).toContainEqual({ kind: 'resumed_completed', askId });

    // The LLM saw 2 chat calls — first turn + resume's continuation.
    expect(llm.calls).toHaveLength(2);
  });

  it('a re-bail (LLM picks a second sensitive persona on resume) re-parks with new approvalId', async () => {
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    setAccessiblePersonas(['health', 'financial']);
    storeItem('financial', { type: 'note', summary: 'balance', body: '$42' });

    const llm = makeScripted();
    llm.push(
      // Turn 1: ask for health.
      toolCallResp({ id: 'c1', name: 'vault_search', arguments: { query: 'BP', persona: 'health' } }),
      // Turn 2 (resume after first approve): pivot to financial.
      toolCallResp({ id: 'c2', name: 'vault_search', arguments: { query: 'balance', persona: 'financial' } }),
      // Turn 3 (resume after second approve): final answer.
      answerResp('Health: 120/80. Balance: $42.'),
    );

    const approvalManager = new ApprovalManager();
    const pipeline = buildAgenticAskPipeline(
      builderInputWithApprovalManager(approvalManager, llm.provider),
    );

    const resumerEvents: AskApprovalResumerEvent[] = [];
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e) => resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({
      registry,
      onEvent: (e) => resumerEvents.push(e),
      resumeFromPausedFn: async (paused, ctx) => {
        const tools = pipeline.buildToolsForAsk!({
          askId: ctx.askId,
          requesterDid: ctx.requesterDid,
        });
        return resumeAgenticTurn({
          provider: pipeline.provider,
          tools,
          systemPrompt: SYSTEM_PROMPT,
          pausedState: paused,
        });
      },
    });

    const askId = 'ask-1';
    await registry.enqueue({ id: askId, question: 'health + balance', requesterDid: REQUESTER });

    // Turn 1
    const tools = pipeline.buildToolsForAsk!({ askId, requesterDid: REQUESTER });
    const r1 = await runAgenticTurn({
      provider: pipeline.provider,
      tools,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: 'health + balance',
    });
    expect(r1.finishReason).toBe('approval_required');
    expect(r1.pausedState!.approvalId).toBe('appr-ask-1-health');
    await registry.markPendingApproval(
      askId,
      r1.pausedState!.approvalId,
      JSON.stringify(r1.pausedState),
    );

    // First approval → triggers resume. LLM pivots to financial → re-parks.
    const gateway = new AskApprovalGateway({
      askRegistry: registry,
      approvalSource: approvalManagerSource(approvalManager),
    });
    await gateway.approve('appr-ask-1-health');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reParked = await registry.get(askId);
    expect(reParked?.status).toBe('pending_approval');
    expect(reParked?.approvalId).toBe('appr-ask-1-financial');
    expect(reParked?.pausedStateJson).toBeDefined();
    expect(resumerEvents).toContainEqual({
      kind: 'resumed_re_approval',
      askId,
      approvalId: 'appr-ask-1-financial',
    });

    // Second approval → resume picks up where we left off, drains
    // financial read, gets final answer, marks complete.
    await gateway.approve('appr-ask-1-financial');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const final = await registry.get(askId);
    expect(final?.status).toBe('complete');
    expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({
      text: 'Health: 120/80. Balance: $42.',
    });
    expect(resumerEvents).toContainEqual({ kind: 'resumed_completed', askId });
  });
});
