/**
 * runAgenticTurn — multi-turn tool-use loop.
 *
 * Covers:
 *   - No-tool-call path (LLM responds with pure text on first turn)
 *   - One-tool-call path (LLM calls geocode, sees result, answers)
 *   - Multi-step path (geocode → search_provider_services → query_service → answer)
 *   - maxIterations / maxToolCalls budget caps
 *   - Tool failure is surfaced to the LLM without throwing out of the loop
 *   - Transcript preserves tool-call round-trips
 */

import { runAgenticTurn } from '../../src/reasoning/agentic_loop';
import { ToolRegistry, type AgentTool } from '../../src/reasoning/tool_registry';

import type {
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';

/**
 * Scripted provider — the test specifies an ordered list of responses
 * that the provider returns in sequence, regardless of input. Each entry
 * is either a final-answer response (tool_calls empty) or a tool-use
 * response (tool_calls non-empty).
 */
function scriptedProvider(script: Partial<ChatResponse>[]): {
  provider: LLMProvider;
  calls: { messages: number; hasTools: boolean }[];
} {
  let i = 0;
  const calls: { messages: number; hasTools: boolean }[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(messages, options?: ChatOptions) {
      calls.push({ messages: messages.length, hasTools: (options?.tools?.length ?? 0) > 0 });
      const step = script[i] ?? { content: '(end of script)', toolCalls: [] };
      i++;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 20 },
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

function echoTool(): AgentTool {
  return {
    name: 'echo',
    description: 'Echo the input',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (args) => ({ echoed: args.text }),
  };
}

function failingTool(): AgentTool {
  return {
    name: 'fail',
    description: 'Always fails',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      throw new Error('kaboom');
    },
  };
}

/**
 * A terminal fire-and-forget tool (e.g. `query_service`). `runs` records each
 * execution. `failFirst` makes the first call throw (to test that a FAILED
 * terminal dispatch does NOT end the turn).
 */
function terminalDispatchTool(runs: string[], opts: { failFirst?: boolean } = {}): AgentTool {
  let calls = 0;
  return {
    name: 'dispatch',
    description: 'Fire-and-forget dispatch',
    parameters: { type: 'object', properties: {}, required: [] },
    terminal: true,
    execute: async () => {
      calls += 1;
      if (opts.failFirst === true && calls === 1) throw new Error('dispatch failed');
      runs.push('dispatch');
      return { status: 'pending' };
    },
  };
}

describe('runAgenticTurn — no-tool-call path', () => {
  it('returns the final text when the LLM answers directly', async () => {
    const { provider, calls } = scriptedProvider([{ content: 'The answer is 42.', toolCalls: [] }]);
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: 'You are a helpful assistant.',
      userMessage: 'What is the answer?',
    });

    expect(result.answer).toBe('The answer is 42.');
    expect(result.finishReason).toBe('completed');
    expect(result.toolCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].hasTools).toBe(true); // tool defs are always exposed
  });
});

describe('runAgenticTurn — terminal tool (fire-and-forget convergence)', () => {
  it('ends the turn after a SUCCESSFUL terminal dispatch — no further iterations', async () => {
    const runs: string[] = [];
    // The provider would keep calling `dispatch` forever; the terminal flag
    // must stop the loop after the first successful dispatch (otherwise it
    // burns to max_iterations and the ask is wrongly marked failed).
    const { provider, calls } = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'dispatch', arguments: {} }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'dispatch', arguments: {} }] }, // must NOT be reached
      { content: '', toolCalls: [{ id: 'c3', name: 'dispatch', arguments: {} }] },
    ]);
    const tools = new ToolRegistry();
    tools.register(terminalDispatchTool(runs));

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: 's',
      userMessage: 'find me a salon',
      options: { maxIterations: 6 },
    });

    expect(result.finishReason).toBe('completed'); // NOT max_iterations
    expect(runs).toHaveLength(1); // dispatched exactly once
    expect(calls).toHaveLength(1); // provider consulted once — loop did not re-iterate
    expect(result.toolCalls).toHaveLength(1);
  });

  it('skips tool calls batched AFTER the terminal one in the same response', async () => {
    const runs: string[] = [];
    // One response batches [dispatch, dispatch] — only the first runs, then
    // the turn ends (one fire-and-forget action per turn).
    const { provider } = scriptedProvider([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'dispatch', arguments: {} },
          { id: 'c2', name: 'dispatch', arguments: {} },
        ],
      },
    ]);
    const tools = new ToolRegistry();
    tools.register(terminalDispatchTool(runs));

    const result = await runAgenticTurn({ provider, tools, systemPrompt: 's', userMessage: 'u' });
    expect(result.finishReason).toBe('completed');
    expect(runs).toHaveLength(1); // the 2nd batched dispatch never ran
  });

  it('a FAILED terminal dispatch does NOT end the turn — the loop continues', async () => {
    const runs: string[] = [];
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'dispatch', arguments: {} }] }, // throws
      { content: 'Sorry, I could not reach that service.', toolCalls: [] }, // normal answer
    ]);
    const tools = new ToolRegistry();
    tools.register(terminalDispatchTool(runs, { failFirst: true }));

    const result = await runAgenticTurn({ provider, tools, systemPrompt: 's', userMessage: 'u' });
    expect(result.finishReason).toBe('completed');
    expect(result.answer).toBe('Sorry, I could not reach that service.');
    expect(runs).toHaveLength(0); // the dispatch never succeeded
  });
});

describe('runAgenticTurn — single tool call', () => {
  it('executes the tool and feeds the result back to the LLM', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'hi' } };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [toolCall] },
      { content: 'The echo returned "hi".', toolCalls: [] },
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'Echo hi please',
    });

    expect(result.answer).toBe('The echo returned "hi".');
    expect(result.finishReason).toBe('completed');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].outcome).toEqual({
      success: true,
      result: { echoed: 'hi' },
    });
  });

  it('preserves tool round-trip on the transcript', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'x' } };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [toolCall] },
      { content: 'done', toolCalls: [] },
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'hi',
    });

    // Transcript: user → assistant(toolCalls) → tool(result) → assistant(final)
    expect(result.transcript.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.transcript[1].toolCalls).toEqual([toolCall]);
    expect(result.transcript[2].toolCallId).toBe('c1');
    expect(result.transcript[2].toolName).toBe('echo');
    const toolBody = JSON.parse(result.transcript[2].content);
    expect(toolBody).toEqual({ result: { echoed: 'x' } });
  });
});

describe('runAgenticTurn — multi-step chain', () => {
  it('chains three tool calls then answers (service-query shape)', async () => {
    const geoCall: ToolCall = { id: 'c1', name: 'geocode', arguments: { address: 'Castro' } };
    const searchCall: ToolCall = {
      id: 'c2',
      name: 'search_provider_services',
      arguments: { capability: 'eta_query', lat: 37.77, lng: -122.41 },
    };
    const queryCall: ToolCall = {
      id: 'c3',
      name: 'query_service',
      arguments: {
        operator_did: 'did:plc:bus',
        capability: 'eta_query',
        params: { route_id: '42', location: { lat: 37.77, lng: -122.41 } },
      },
    };
    const { provider, calls } = scriptedProvider([
      { content: '', toolCalls: [geoCall] },
      { content: '', toolCalls: [searchCall] },
      { content: '', toolCalls: [queryCall] },
      { content: 'Asking Bus 42…', toolCalls: [] },
    ]);

    const tools = new ToolRegistry();
    tools.register({
      name: 'geocode',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { address: { type: 'string' } },
        required: ['address'],
      },
      execute: async () => ({ lat: 37.77, lng: -122.41 }),
    });
    tools.register({
      name: 'search_provider_services',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { capability: { type: 'string' } },
        required: ['capability'],
      },
      execute: async () => [{ did: 'did:plc:bus', name: 'Bus 42', capabilities: ['eta_query'] }],
    });
    tools.register({
      name: 'query_service',
      description: 'x',
      parameters: {
        type: 'object',
        properties: {
          operator_did: { type: 'string' },
          capability: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['operator_did', 'capability', 'params'],
      },
      execute: async () => ({ task_id: 't1', status: 'pending' }),
    });

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'when does Bus 42 reach Castro?',
    });

    expect(result.answer).toBe('Asking Bus 42…');
    expect(result.finishReason).toBe('completed');
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      'geocode',
      'search_provider_services',
      'query_service',
    ]);
    expect(calls).toHaveLength(4); // 3 tool-emitting + 1 final
  });
});

describe('runAgenticTurn — budget caps', () => {
  it('stops after maxIterations without completing', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'x' } };
    // Script never produces a final answer — always returns the tool call.
    const { provider } = scriptedProvider(
      Array.from({ length: 20 }, () => ({ content: '', toolCalls: [toolCall] })),
    );
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'loop forever',
      options: { maxIterations: 3, maxToolCalls: 100 },
    });

    expect(result.finishReason).toBe('max_iterations');
    // 3 iterations * 1 tool call each = 3 logged calls.
    expect(result.toolCalls.length).toBe(3);
  });

  it('stops after maxToolCalls with a budget message', async () => {
    const mkCalls = (n: number): ToolCall[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        name: 'echo',
        arguments: { text: `${i}` },
      }));
    const { provider } = scriptedProvider([
      { content: '', toolCalls: mkCalls(5) }, // 5 calls in one iteration
      { content: '', toolCalls: mkCalls(5) }, // another 5 — should trigger cap
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: '...',
      options: { maxIterations: 10, maxToolCalls: 7 },
    });

    expect(result.finishReason).toBe('max_tool_calls');
    expect(result.toolCalls.length).toBe(7);
    expect(result.answer).toMatch(/budget|try again/i);
  });
});

describe('runAgenticTurn — error handling', () => {
  it('surfaces tool failure in the transcript; loop continues normally', async () => {
    const failCall: ToolCall = { id: 'c1', name: 'fail', arguments: {} };
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [failCall] },
      { content: 'the tool failed, sorry', toolCalls: [] },
    ]);
    const tools = new ToolRegistry();
    tools.register(failingTool());

    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'x',
    });

    expect(result.finishReason).toBe('completed');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].outcome).toMatchObject({
      success: false,
      error: 'kaboom',
    });
    // Tool result in transcript carries the error, not the success payload.
    const toolMsg = result.transcript[2];
    expect(JSON.parse(toolMsg.content)).toEqual({ error: 'kaboom' });
  });

  it('returns provider_error finishReason when chat() throws', async () => {
    const provider: LLMProvider = {
      name: 't',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      chat: async () => {
        throw new Error('timeout');
      },
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    const result = await runAgenticTurn({
      provider,
      tools: new ToolRegistry(),
      systemPrompt: '',
      userMessage: 'hi',
    });
    expect(result.finishReason).toBe('provider_error');
  });

  // P1.2 residual — an SDK error's `.message` can echo the failing
  // request body (prompt + any vault content the prompt references).
  // The user-facing `providerErrorMessage` must never carry that raw
  // text; only a known-safe classifier template or a ctor-only
  // generic should escape the catch block.
  it('does NOT echo the raw err.message into providerErrorMessage (P1.2 residual)', async () => {
    const PROMPT_LEAK_SENTINEL = 'SENTINEL_PROMPT_FRAGMENT_DO_NOT_LEAK_8a3f';
    const provider: LLMProvider = {
      name: 't',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      chat: async () => {
        // Simulate an SDK error whose message embeds the request body.
        // No classifier pattern matches this string, so the unclassified
        // path is exercised.
        throw new Error(`request failed: ${PROMPT_LEAK_SENTINEL}`);
      },
      // eslint-disable-next-line require-yield -- interface-satisfying stub; the test path never iterates it
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    const result = await runAgenticTurn({
      provider,
      tools: new ToolRegistry(),
      systemPrompt: '',
      userMessage: 'hi',
    });
    expect(result.finishReason).toBe('provider_error');
    expect(result.providerErrorMessage).toBeDefined();
    expect(result.providerErrorMessage).not.toContain(PROMPT_LEAK_SENTINEL);
    // The unclassified-fallback should be the ctor-only line.
    expect(result.providerErrorMessage).toContain('Error');
    expect(result.providerErrorMessage).toContain('provider unavailable');
  });

  // Classified path — a recognised vendor signal (e.g. "rate limit")
  // SHOULD produce the actionable template, not the generic fallback.
  it('uses the classifier template when the err.message matches a known vendor signal', async () => {
    const provider: LLMProvider = {
      name: 't',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      chat: async () => {
        throw new Error('429 Too Many Requests — rate limit exceeded for project xyz');
      },
      // eslint-disable-next-line require-yield -- interface-satisfying stub; the test path never iterates it
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    const result = await runAgenticTurn({
      provider,
      tools: new ToolRegistry(),
      systemPrompt: '',
      userMessage: 'hi',
    });
    expect(result.finishReason).toBe('provider_error');
    // The rate-limit template hedges toward credits (the @google/genai
    // wrapper makes 429-rate-limit vs 429-credits indistinguishable).
    expect(result.providerErrorMessage).toMatch(/rate limit/i);
    expect(result.providerErrorKind).toBe('rate_limited');
    // Project / id fragments from the raw text must not leak through.
    expect(result.providerErrorMessage).not.toContain('project xyz');
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }] },
      { content: 'ignored', toolCalls: [] },
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool());
    controller.abort();
    const result = await runAgenticTurn({
      provider,
      tools,
      systemPrompt: '',
      userMessage: 'x',
      options: { signal: controller.signal },
    });
    expect(result.finishReason).toBe('cancelled');
  });
});

describe('runAgenticTurn — never logs vault/tool content to console (SEC P1.3)', () => {
  it('keeps PII out of console: model content, tool args, and tool outputs are not logged', async () => {
    // A unique sentinel standing in for vault PII. It rides in the model
    // content, the tool-call arguments, AND the tool output (echo returns it).
    const MARKER = 'PII-SENTINEL-7f3a9c-123-45-6789';
    const toolCall: ToolCall = { id: 'c1', name: 'echo', arguments: { text: MARKER } };
    const { provider } = scriptedProvider([
      { content: MARKER, toolCalls: [toolCall] },
      { content: `the answer mentions ${MARKER}`, toolCalls: [] },
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool()); // echo returns { echoed: MARKER } → output carries PII

    const logged: string[] = [];
    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = sinks.map((m) =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    try {
      const result = await runAgenticTurn({
        provider,
        tools,
        systemPrompt: '',
        userMessage: 'echo it',
      });
      expect(result.finishReason).toBe('completed');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // The loop logs metadata ([agentic_loop] start/iter/tool), but none of it
    // may contain the sentinel that appeared in content / tool args / output.
    expect(logged.filter((line) => line.includes(MARKER))).toEqual([]);
    // Sanity: the loop DID log (so we're actually exercising the log path).
    expect(logged.some((l) => l.includes('[agentic_loop]'))).toBe(true);
  });
});
