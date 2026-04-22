/**
 * makeAgenticAskHandler — wraps runAgenticTurn into an AskCommandHandler.
 */

import {
  makeAgenticAskHandler,
  DEFAULT_ASK_SYSTEM_PROMPT,
  formatIntentHintBlock,
} from '../../src/reasoning/ask_handler';
import { ToolRegistry, type AgentTool } from '../../src/reasoning/tool_registry';
import type { ChatResponse, LLMProvider, ToolCall } from '../../src/llm/adapters/provider';
import { IntentClassifier, type IntentClassification } from '../../src/reasoning/intent_classifier';
import type { TocEntry } from '../../../core/src/memory/domain';

function scriptedProvider(script: Array<Partial<ChatResponse>>): LLMProvider {
  let i = 0;
  return {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat() {
      const step = script[i] ?? { content: '(end)', toolCalls: [] };
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
      throw new Error('nope');
    },
    async embed() {
      throw new Error('nope');
    },
  };
}

function queryServiceTool(taskId: string): AgentTool {
  return {
    name: 'query_service',
    description: 'Dispatch query.',
    parameters: {
      type: 'object',
      properties: {
        operator_did: { type: 'string' },
        capability: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['operator_did', 'capability', 'params'],
    },
    execute: async () => ({
      task_id: taskId,
      query_id: 'q-1',
      to_did: 'did:plc:bus',
      service_name: 'Bus 42',
      deduped: false,
      status: 'pending',
    }),
  };
}

describe('makeAgenticAskHandler', () => {
  it('returns final text + no sources when LLM answers without tool calls', async () => {
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([{ content: 'Hi there!', toolCalls: [] }]),
      tools: new ToolRegistry(),
    });
    const result = await handler('say hi');
    expect(result.response).toBe('Hi there!');
    expect(result.sources).toEqual([]);
  });

  it('surfaces task_ids from successful query_service calls as sources', async () => {
    const qCall: ToolCall = {
      id: 'c1',
      name: 'query_service',
      arguments: { operator_did: 'did:plc:bus', capability: 'eta_query', params: {} },
    };
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [qCall] },
        { content: 'Asking Bus 42…', toolCalls: [] },
      ]),
      tools: (() => {
        const r = new ToolRegistry();
        r.register(queryServiceTool('svc-q-99'));
        return r;
      })(),
    });
    const result = await handler('when is bus 42?');
    expect(result.response).toBe('Asking Bus 42…');
    expect(result.sources).toEqual(['svc-q-99']);
  });

  it('never surfaces sources from failed query_service calls', async () => {
    const qCall: ToolCall = {
      id: 'c1',
      name: 'query_service',
      arguments: { operator_did: 'did:plc:bus', capability: 'eta_query', params: {} },
    };
    const failingQueryTool: AgentTool = {
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
      execute: async () => {
        throw new Error('AppView down');
      },
    };
    const tools = new ToolRegistry();
    tools.register(failingQueryTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [qCall] },
        { content: 'could not reach the service', toolCalls: [] },
      ]),
      tools,
    });
    const result = await handler('ask');
    expect(result.sources).toEqual([]);
  });

  it('onTurn trace fires with usage + tool-call summary', async () => {
    const traces: Array<Record<string, unknown>> = [];
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([{ content: 'ok', toolCalls: [] }]),
      tools: new ToolRegistry(),
      onTurn: (t) => traces.push(t),
    });
    await handler('hi');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      query: 'hi',
      answer: 'ok',
      finishReason: 'completed',
      tokens: { input: 10, output: 20 },
    });
  });

  // Architectural invariant: the default system prompt carries BEHAVIOUR
  // rules only. Tool names + parameters come through the provider's tool
  // channel (ToolRegistry → runAgenticTurn → provider.chat({tools})).
  // Baking tool names into the prompt would recreate the coupling this
  // refactor just removed — adding a new capability should be a registry
  // insertion, not a prose edit.
  it('default system prompt enumerates NO specific tool names', () => {
    const forbidden = [
      'geocode(',
      'search_provider_services(',
      'query_service(',
      'eta_query',
      'Bus 42',
    ];
    for (const needle of forbidden) {
      expect(DEFAULT_ASK_SYSTEM_PROMPT).not.toContain(needle);
    }
  });

  it('default system prompt carries the core behaviour rules', () => {
    // Keywords that MUST be present — these are the contract with the LLM.
    // If any of these disappear, the agent loses a safety property.
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toMatch(/never fabricate/i);
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toMatch(/acknowledge/i);
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toMatch(/asynchronous/i);
  });

  // -------------------------------------------------------------------
  // WM-BRAIN-04 + WM-BRAIN-05: intent-classifier wiring
  // -------------------------------------------------------------------

  function captureSystem(): {
    provider: LLMProvider;
    captured: { systemPrompt: string | undefined };
  } {
    const captured = { systemPrompt: undefined as string | undefined };
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(_msgs, opts) {
        captured.systemPrompt = opts?.systemPrompt;
        return {
          content: 'done',
          toolCalls: [],
          model: 'test',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'end',
        };
      },
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    return { provider, captured };
  }

  function makeClassifier(hint: IntentClassification | Error): IntentClassifier {
    return new IntentClassifier({
      llm: async () => {
        if (hint instanceof Error) throw hint;
        return JSON.stringify(hint);
      },
      tocFetcher: async () => [] as TocEntry[],
    });
  }

  it('does NOT append a Routing hint block when no classifier is supplied', async () => {
    const { provider, captured } = captureSystem();
    const handler = makeAgenticAskHandler({ provider, tools: new ToolRegistry() });
    await handler('hello');
    expect(captured.systemPrompt).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
    expect(captured.systemPrompt).not.toContain('Routing hint');
  });

  it('appends a Routing hint block when the classifier returns a non-default hint', async () => {
    const { provider, captured } = captureSystem();
    const hint: IntentClassification = {
      sources: ['vault', 'provider_services'],
      relevant_personas: ['health'],
      toc_evidence: { entity_matches: ['Dr Carl'] },
      temporal: 'live_state',
      reasoning_hint: 'check Dr Carl live state',
    };
    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
      intentClassifier: makeClassifier(hint),
    });
    await handler('what is Dr Carl up to?');
    const sys = captured.systemPrompt ?? '';
    expect(sys).toContain(DEFAULT_ASK_SYSTEM_PROMPT);
    expect(sys).toContain('Routing hint from the intent classifier');
    expect(sys).toContain('- sources: ["vault","provider_services"]');
    expect(sys).toContain('- temporal: live_state');
    expect(sys).toContain('- reasoning_hint: check Dr Carl live state');
    expect(sys).toContain('Dr Carl');
  });

  it('does NOT append a Routing hint block when the classifier returns the default', async () => {
    // Empty query → classifier shortcircuits to default() WITHOUT
    // calling the LLM, so the handler gets a default hint and the
    // prompt is left unchanged.
    const { provider, captured } = captureSystem();
    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
      intentClassifier: makeClassifier(IntentClassifier.default()),
    });
    await handler('hello');
    expect(captured.systemPrompt).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
  });

  it('appends the Path 1 / Path 2 routing block when sources includes provider_services', async () => {
    // Routing guidance: prefer `find_preferred_provider(category)`
    // for established service relationships (Path 1); go straight
    // to geocode + search_provider_services for public-facing
    // services (Path 2); fall through to Path 2 when Path 1
    // returns no candidates.
    const { provider, captured } = captureSystem();
    const hint: IntentClassification = {
      sources: ['provider_services'],
      relevant_personas: ['health'],
      toc_evidence: { entity_matches: ['Dr Carl'] },
      temporal: 'live_state',
      reasoning_hint: 'ask Dr Carl',
    };
    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
      intentClassifier: makeClassifier(hint),
    });
    await handler('is my appointment on?');
    const sys = captured.systemPrompt ?? '';
    expect(sys).toContain('Routing hint from the intent classifier');
    expect(sys).toContain('"provider_services"');

    expect(sys).toContain('Path 1:');
    expect(sys).toContain('find_preferred_provider(category) FIRST');
    expect(sys).toContain('Path 2:');
    expect(sys).toContain('search_provider_services(capability, lat, lng, q)');
    expect(sys).toMatch(/Fall-through/i);
  });

  it('PC-BRAIN-08: does NOT append the Path 1 / Path 2 block when provider_services is absent from sources', async () => {
    // A vault-only query doesn't need live-routing guidance — the
    // block is purely noise in that case and wastes tokens.
    const { provider, captured } = captureSystem();
    const hint: IntentClassification = {
      sources: ['vault'],
      relevant_personas: ['general'],
      toc_evidence: { entity_matches: ['Alice'] },
      temporal: 'static',
      reasoning_hint: 'pull alice thread',
    };
    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
      intentClassifier: makeClassifier(hint),
    });
    await handler('what did Alice say yesterday');
    const sys = captured.systemPrompt ?? '';
    // Base hint block still renders (non-default hint → non-empty block).
    expect(sys).toContain('Routing hint from the intent classifier');
    // Routing block absent.
    expect(sys).not.toContain('Path 1:');
    expect(sys).not.toContain('Path 2:');
    expect(sys).not.toContain('find_preferred_provider');
  });

  it('falls back to the plain system prompt when the classifier throws (fail-open)', async () => {
    const { provider, captured } = captureSystem();
    // Manually throw from inside `classify`: build a classifier whose
    // tocFetcher throws, then wrap `.classify` to rethrow (the
    // classifier's own fail-open would collapse errors to default()).
    const brokenClassifier = new IntentClassifier({
      llm: async () => '{}',
      tocFetcher: async () => [],
    });
    brokenClassifier.classify = async () => {
      throw new Error('boom');
    };

    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
      intentClassifier: brokenClassifier,
    });
    const result = await handler('hi');
    expect(result.response).toBe('done');
    // The handler catches the classifier exception and falls back to
    // IntentClassifier.default() — the formatter collapses the default
    // to an empty block, so the base prompt is used unchanged.
    expect(captured.systemPrompt).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
  });

  it('returns a fallback when the loop ends with empty answer (max_iterations)', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'echo', arguments: { text: 'x' } };
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'x',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async () => ({ text: 'x' }),
    });
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider(
        Array.from({ length: 20 }, () => ({ content: '', toolCalls: [toolCall] })),
      ),
      tools,
      loopOptions: { maxIterations: 2 },
    });
    const result = await handler('loop');
    expect(result.response).toMatch(/budget/i);
  });
});

// ---------------------------------------------------------------------------
// formatIntentHintBlock — pure formatter tests
// ---------------------------------------------------------------------------

describe('formatIntentHintBlock', () => {
  it('returns empty string for the conservative default', () => {
    expect(formatIntentHintBlock(IntentClassifier.default())).toBe('');
  });

  it('omits empty optional lines (relevant_personas, temporal, hint)', () => {
    const hint: IntentClassification = {
      sources: ['vault', 'general_knowledge'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    };
    const block = formatIntentHintBlock(hint);
    expect(block).toContain('- sources: ["vault","general_knowledge"]');
    expect(block).not.toContain('- relevant_personas');
    expect(block).not.toContain('- temporal');
    expect(block).not.toContain('- reasoning_hint');
    expect(block).not.toContain('- toc_evidence');
  });

  it('inlines toc_evidence as indented JSON when present', () => {
    const hint: IntentClassification = {
      sources: ['vault'],
      relevant_personas: ['health'],
      toc_evidence: {
        entity_matches: ['Dr Carl'],
        theme_matches: ['knee rehab'],
      },
      temporal: '',
      reasoning_hint: '',
    };
    const block = formatIntentHintBlock(hint);
    expect(block).toContain('- toc_evidence:');
    expect(block).toContain('    "entity_matches"'); // 4-space indent
    expect(block).toContain('"Dr Carl"');
    expect(block).toContain('"knee rehab"');
  });

  it('emits the Path 1 / Path 2 block on provider_services', () => {
    const hint: IntentClassification = {
      sources: ['provider_services'],
      relevant_personas: ['health'],
      toc_evidence: { entity_matches: ['Dr Carl'] },
      temporal: 'live_state',
      reasoning_hint: 'ask Dr Carl',
    };
    const block = formatIntentHintBlock(hint);
    expect(block).toContain('Path 1:');
    expect(block).toContain('find_preferred_provider(category) FIRST');
    expect(block).toContain('Path 2:');
    expect(block).toContain('search_provider_services(capability, lat, lng, q)');
    expect(block).toMatch(/Fall-through/);
    // Base hint block still renders.
    expect(block).toContain('Routing hint');
    expect(block).toContain('"provider_services"');
  });

  it('PC-BRAIN-08: does NOT emit the Path 1 / Path 2 block when sources lack provider_services', () => {
    const hint: IntentClassification = {
      sources: ['vault'],
      relevant_personas: ['general'],
      toc_evidence: { entity_matches: ['Alice'] },
      temporal: 'static',
      reasoning_hint: '',
    };
    const block = formatIntentHintBlock(hint);
    expect(block).not.toContain('Path 1:');
    expect(block).not.toContain('Path 2:');
    expect(block).not.toContain('find_preferred_provider');
    // The base hint is still emitted (non-default state).
    expect(block).toContain('Routing hint');
  });

  it('always appends the "advisory, not hard shortlisting" note', () => {
    const hint: IntentClassification = {
      sources: ['vault', 'provider_services'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    };
    expect(formatIntentHintBlock(hint)).toMatch(/advisory/);
  });
});
