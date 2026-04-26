/**
 * runAgenticTurn / resumeAgenticTurn — Pattern A (full-state suspend
 * & resume) for approval-gated tool calls.
 *
 * These tests pin the contract that lets the loop park mid-turn when
 * a tool throws `ApprovalRequiredError`, hand back a `pausedState`
 * blob, and pick up where it left off when the operator approves.
 * The LLM never knows there was a gap — its transcript is one
 * continuous conversation across the bail/resume boundary.
 */

import {
  resumeAgenticTurn,
  runAgenticTurn,
  type PausedAgenticState,
} from '../../src/reasoning/agentic_loop';
import {
  ApprovalRequiredError,
  ToolRegistry,
  type AgentTool,
} from '../../src/reasoning/tool_registry';
import type {
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';

/**
 * Scripted provider — same shape as the existing agentic_loop test
 * harness but lifted here so the suspend/resume tests don't depend on
 * the other file. The script is a sequence of canned responses; index
 * advances on each `chat()` call.
 */
function scriptedProvider(script: Array<Partial<ChatResponse>>): {
  provider: LLMProvider;
  calls: Array<{ messages: number; hasTools: boolean; lastRole: string | undefined }>;
} {
  let i = 0;
  const calls: Array<{ messages: number; hasTools: boolean; lastRole: string | undefined }> = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(messages, options?: ChatOptions) {
      calls.push({
        messages: messages.length,
        hasTools: (options?.tools?.length ?? 0) > 0,
        lastRole: messages[messages.length - 1]?.role,
      });
      const step = script[i] ?? { content: '(end of script)', toolCalls: [] };
      i++;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 7, outputTokens: 11 },
        finishReason: (step.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end',
      };
    },
    async *stream() {
      throw new Error('not used');
    },
    async embed() {
      throw new Error('not used');
    },
  };
  return { provider, calls };
}

/**
 * Vault-style tool that throws `ApprovalRequiredError` on the first
 * execute call and returns real data on the second. Models the
 * production seam where the operator approves between the two calls.
 */
function gatedVaultTool(opts: {
  approvalId: string;
  persona: string;
  resultOnSecondCall: unknown;
}): { tool: AgentTool; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    tool: {
      name: 'vault_search',
      description: 'Search a persona vault',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          persona: { type: 'string' },
        },
        required: ['query', 'persona'],
      },
      execute: async () => {
        calls++;
        if (calls === 1) {
          throw new ApprovalRequiredError(opts.approvalId, opts.persona);
        }
        return opts.resultOnSecondCall;
      },
    },
  };
}

/** Tool that always succeeds — for sibling-batch coverage. */
function freeVaultTool(): AgentTool {
  return {
    name: 'list_personas',
    description: 'List unlocked personas',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ personas: ['general'] }),
  };
}

describe('Pattern A — suspend on approval_required', () => {
  it('bails immediately when a tool throws ApprovalRequiredError', async () => {
    const { tool: gated } = gatedVaultTool({
      approvalId: 'appr-fin-1',
      persona: 'financial',
      resultOnSecondCall: { items: ['$42'] },
    });
    const tools = new ToolRegistry();
    tools.register(gated);

    const toolCall: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'balance', persona: 'financial' },
    };
    const { provider } = scriptedProvider([{ content: '', toolCalls: [toolCall] }]);

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: "what's my balance?",
    });

    expect(result.finishReason).toBe('approval_required');
    expect(result.answer).toBe('');
    expect(result.pausedState).toBeDefined();
    expect(result.pausedState!.version).toBe(1);
    expect(result.pausedState!.approvalId).toBe('appr-fin-1');
    expect(result.pausedState!.persona).toBe('financial');
    expect(result.pausedState!.pendingToolCall).toEqual({
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'balance', persona: 'financial' },
    });
    expect(result.pausedState!.iteration).toBe(0);
    expect(result.pausedState!.toolCallCount).toBe(1);
    expect(result.pausedState!.remainingToolCalls).toEqual([]);
  });

  it('captures sibling tool calls in the same batch as remainingToolCalls', async () => {
    const { tool: gated } = gatedVaultTool({
      approvalId: 'appr-1',
      persona: 'financial',
      resultOnSecondCall: { items: [] },
    });
    const tools = new ToolRegistry();
    tools.register(gated);
    tools.register(freeVaultTool());

    // LLM batches three tool calls; the SECOND one needs approval.
    const tcA: ToolCall = { id: 'a', name: 'list_personas', arguments: {} };
    const tcB: ToolCall = {
      id: 'b',
      name: 'vault_search',
      arguments: { query: 'x', persona: 'financial' },
    };
    const tcC: ToolCall = { id: 'c', name: 'list_personas', arguments: {} };
    const { provider } = scriptedProvider([{ content: '', toolCalls: [tcA, tcB, tcC] }]);

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });

    expect(result.finishReason).toBe('approval_required');
    expect(result.pausedState!.pendingToolCall.id).toBe('b');
    expect(result.pausedState!.remainingToolCalls).toEqual([tcC]);
    expect(result.pausedState!.toolCallCount).toBe(2); // a + b counted
    // Transcript: [user, assistant(toolCalls), tool-result(a)]. The
    // bailing tool's result is NOT pushed; its sibling-after-bail isn't
    // executed yet.
    const transcript = result.pausedState!.transcript;
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(transcript[2]!.toolCallId).toBe('a');
  });

  it('toolLog records the approval_required outcome with approvalId + persona', async () => {
    const { tool: gated } = gatedVaultTool({
      approvalId: 'appr-x',
      persona: 'health',
      resultOnSecondCall: {},
    });
    const tools = new ToolRegistry();
    tools.register(gated);
    const toolCall: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'q', persona: 'health' },
    };
    const { provider } = scriptedProvider([{ content: '', toolCalls: [toolCall] }]);

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });

    expect(result.toolCalls).toHaveLength(1);
    const entry = result.toolCalls[0]!;
    expect(entry.outcome.success).toBe(false);
    if (!entry.outcome.success && 'code' in entry.outcome) {
      expect(entry.outcome.code).toBe('approval_required');
      if (entry.outcome.code === 'approval_required') {
        expect(entry.outcome.approvalId).toBe('appr-x');
        expect(entry.outcome.persona).toBe('health');
      }
    }
  });
});

describe('Pattern A — resume after approval', () => {
  it('full cycle: bail → resume → final answer (LLM sees one continuous transcript)', async () => {
    const { tool: gated, callCount } = gatedVaultTool({
      approvalId: 'appr-1',
      persona: 'financial',
      resultOnSecondCall: { items: ['$42'] },
    });
    const tools = new ToolRegistry();
    tools.register(gated);

    const tc: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'balance', persona: 'financial' },
    };
    // Initial run: LLM emits one tool call. Resume run: LLM sees the
    // tool result and produces a final answer.
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [tc] }, // initial — tool call
      { content: 'Your balance is $42.', toolCalls: [] }, // resume — final answer
    ]);

    const initial = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'balance?',
    });
    expect(initial.finishReason).toBe('approval_required');
    expect(callCount()).toBe(1);

    // (operator approval would happen here in production)
    const resumed = await resumeAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      pausedState: initial.pausedState!,
    });

    expect(resumed.finishReason).toBe('completed');
    expect(resumed.answer).toBe('Your balance is $42.');
    expect(callCount()).toBe(2); // tool re-executed once on resume
    // Resumed transcript ends with the assistant's final-answer turn.
    const last = resumed.transcript[resumed.transcript.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('Your balance is $42.');
  });

  it('resume drains remaining sibling tools in the paused batch', async () => {
    const { tool: gated, callCount: gatedCalls } = gatedVaultTool({
      approvalId: 'appr-1',
      persona: 'financial',
      resultOnSecondCall: { items: ['$42'] },
    });
    let listCalls = 0;
    const listTool: AgentTool = {
      name: 'list_personas',
      description: 'list',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        listCalls++;
        return { personas: ['financial'] };
      },
    };
    const tools = new ToolRegistry();
    tools.register(gated);
    tools.register(listTool);

    // Batch: [list (executes), gated (bails), list (becomes 'remaining')].
    const tcA: ToolCall = { id: 'a', name: 'list_personas', arguments: {} };
    const tcB: ToolCall = {
      id: 'b',
      name: 'vault_search',
      arguments: { query: 'x', persona: 'financial' },
    };
    const tcC: ToolCall = { id: 'c', name: 'list_personas', arguments: {} };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [tcA, tcB, tcC] },
      { content: 'Done — $42.', toolCalls: [] },
    ]);

    const initial = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });
    expect(initial.finishReason).toBe('approval_required');
    expect(listCalls).toBe(1); // only tcA ran before the bail
    expect(gatedCalls()).toBe(1);

    const resumed = await resumeAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      pausedState: initial.pausedState!,
    });
    expect(resumed.finishReason).toBe('completed');
    expect(resumed.answer).toBe('Done — $42.');
    // The gated tool ran once on resume (with consumed approval); the
    // sibling tcC ran once after the gated tool.
    expect(gatedCalls()).toBe(2);
    expect(listCalls).toBe(2); // tcA + tcC
  });

  it('refuses paused states from a future version', async () => {
    const corrupt: PausedAgenticState = {
      // @ts-expect-error testing forward-compat guard
      version: 99,
      transcript: [],
      iteration: 0,
      toolCallCount: 0,
      pendingToolCall: { id: 'x', name: 'echo', arguments: {} },
      remainingToolCalls: [],
      approvalId: 'appr-x',
      persona: 'health',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const { provider } = scriptedProvider([{ content: 'never reached', toolCalls: [] }]);

    await expect(
      resumeAgenticTurn({
        provider,
        tools: new ToolRegistry(),
        systemPrompt: '',
        pausedState: corrupt,
      }),
    ).rejects.toThrow('paused state version 99 not supported');
  });

  it('re-bails when the resumed tool needs approval again (different approvalId)', async () => {
    // Tool throws on calls 1 AND 2 — operator approved appr-1 but the
    // tool decides it now needs appr-2 (e.g. a different sub-persona).
    let calls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'vault_search',
      description: 'gated',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, persona: { type: 'string' } },
        required: ['query', 'persona'],
      },
      execute: async () => {
        calls++;
        if (calls === 1) throw new ApprovalRequiredError('appr-1', 'financial');
        if (calls === 2) throw new ApprovalRequiredError('appr-2', 'financial-sub');
        return {};
      },
    });
    const tc: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'q', persona: 'financial' },
    };
    const { provider } = scriptedProvider([{ content: '', toolCalls: [tc] }]);

    const initial = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });
    expect(initial.pausedState!.approvalId).toBe('appr-1');

    const resumed = await resumeAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      pausedState: initial.pausedState!,
    });
    expect(resumed.finishReason).toBe('approval_required');
    expect(resumed.pausedState).toBeDefined();
    expect(resumed.pausedState!.approvalId).toBe('appr-2');
    expect(resumed.pausedState!.persona).toBe('financial-sub');
  });

  it('preserves token usage across bail + resume', async () => {
    const { tool: gated } = gatedVaultTool({
      approvalId: 'appr-1',
      persona: 'financial',
      resultOnSecondCall: {},
    });
    const tools = new ToolRegistry();
    tools.register(gated);
    const tc: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'q', persona: 'financial' },
    };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [tc] },
      { content: 'ok', toolCalls: [] },
    ]);

    const initial = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });
    // Initial run: 1 LLM call (input=7, output=11 from the harness).
    expect(initial.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
    expect(initial.pausedState!.usage).toEqual({ inputTokens: 7, outputTokens: 11 });

    const resumed = await resumeAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      pausedState: initial.pausedState!,
    });
    // Resume adds another LLM call for the final answer turn.
    expect(resumed.usage).toEqual({ inputTokens: 14, outputTokens: 22 });
  });

  it('respects AbortSignal during resume', async () => {
    const { tool: gated } = gatedVaultTool({
      approvalId: 'appr-1',
      persona: 'financial',
      resultOnSecondCall: {},
    });
    const tools = new ToolRegistry();
    tools.register(gated);
    const tc: ToolCall = {
      id: 'tc-1',
      name: 'vault_search',
      arguments: { query: 'q', persona: 'financial' },
    };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [tc] },
      { content: 'should not arrive', toolCalls: [] },
    ]);

    const initial = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'q',
    });

    const controller = new AbortController();
    controller.abort();
    const resumed = await resumeAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      pausedState: initial.pausedState!,
      options: { signal: controller.signal },
    });
    expect(resumed.finishReason).toBe('cancelled');
  });
});
