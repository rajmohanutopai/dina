/**
 * makeAgenticAskHandler — wraps runAgenticTurn into an AskCommandHandler.
 */

import {
  makeAgenticAskHandler,
  DEFAULT_ASK_SYSTEM_PROMPT,
  formatCurrentTimeBlock,
  formatIntentHintBlock,
} from '../../src/reasoning/ask_handler';
import { ToolRegistry, type AgentTool } from '../../src/reasoning/tool_registry';
import type { ChatResponse, LLMProvider, ToolCall } from '../../src/llm/adapters/provider';
import { IntentClassifier, type IntentClassification } from '../../src/reasoning/intent_classifier';
import type { TocEntry } from '@dina/core';

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

  it('surfaces a missing-capability notice when provider search returns zero candidates', async () => {
    const searchCall: ToolCall = {
      id: 'search-1',
      name: 'search_provider_services',
      arguments: { capability: 'com.acme.widget_price' },
    };
    const searchTool: AgentTool = {
      name: 'search_provider_services',
      description: 'Search providers.',
      parameters: {
        type: 'object',
        properties: { capability: { type: 'string' } },
        required: ['capability'],
      },
      execute: async () => [],
    };
    const tools = new ToolRegistry();
    tools.register(searchTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [searchCall] },
        { content: 'No Dina service is serving that yet.', toolCalls: [] },
      ]),
      tools,
    });

    const result = await handler('who serves com.acme.widget_price?');

    expect(result.response).toBe('No Dina service is serving that yet.');
    expect(result.missingCapabilities).toHaveLength(1);
    expect(result.missingCapabilities![0]).toMatchObject({
      capability: 'com.acme.widget_price',
      query: 'who serves com.acme.widget_price?',
    });
  });

  it('prefers an explicit capability in the Ask over a guessed provider-search capability', async () => {
    const searchCall: ToolCall = {
      id: 'search-1',
      name: 'search_provider_services',
      arguments: { capability: 'eta_query' },
    };
    const searchTool: AgentTool = {
      name: 'search_provider_services',
      description: 'Search providers.',
      parameters: {
        type: 'object',
        properties: { capability: { type: 'string' } },
        required: ['capability'],
      },
      execute: async () => [],
    };
    const tools = new ToolRegistry();
    tools.register(searchTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [searchCall] },
        { content: 'No Dina service is serving that yet.', toolCalls: [] },
      ]),
      tools,
    });

    const result = await handler('who serves com.acme.widget_price?');

    expect(result.missingCapabilities).toHaveLength(1);
    expect(result.missingCapabilities![0]).toMatchObject({
      capability: 'com.acme.widget_price',
    });
  });

  it('surfaces a missing-capability notice from normal Ask discovery when no capability is covered', async () => {
    const discoveryCall: ToolCall = {
      id: 'discover-1',
      name: 'search_capabilities',
      arguments: { intent: 'who serves com.acme.widget_price?' },
    };
    const discoveryTool: AgentTool = {
      name: 'search_capabilities',
      description: 'Discover capabilities.',
      parameters: {
        type: 'object',
        properties: { intent: { type: 'string' } },
        required: ['intent'],
      },
      execute: async () => ({ capabilities: [] }),
    };
    const tools = new ToolRegistry();
    tools.register(discoveryTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [discoveryCall] },
        { content: 'No Dina service is serving that yet.', toolCalls: [] },
      ]),
      tools,
    });

    const result = await handler('who serves com.acme.widget_price?');

    expect(result.missingCapabilities).toHaveLength(1);
    expect(result.missingCapabilities![0]).toMatchObject({
      capability: 'com.acme.widget_price',
      query: 'who serves com.acme.widget_price?',
    });
  });

  it('surfaces a missing-capability notice when provider search rejects an open capability', async () => {
    const searchCall: ToolCall = {
      id: 'search-1',
      name: 'search_provider_services',
      arguments: { capability: 'com.acme.widget_price' },
    };
    const searchTool: AgentTool = {
      name: 'search_provider_services',
      description: 'Search providers.',
      parameters: {
        type: 'object',
        properties: { capability: { type: 'string' } },
        required: ['capability'],
      },
      execute: async () => {
        throw new Error('AppView responded 400');
      },
    };
    const tools = new ToolRegistry();
    tools.register(searchTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [searchCall] },
        { content: 'No Dina service is serving that yet.', toolCalls: [] },
      ]),
      tools,
    });

    const result = await handler('who serves com.acme.widget_price?');

    expect(result.missingCapabilities).toHaveLength(1);
    expect(result.missingCapabilities![0]).toMatchObject({
      capability: 'com.acme.widget_price',
    });
  });

  it('falls back to a missing-capability notice when Ask service discovery loops out', async () => {
    const discoveryCall: ToolCall = {
      id: 'discover-1',
      name: 'search_capabilities',
      arguments: { intent: 'who serves com.acme.widget_price?' },
    };
    const discoveryTool: AgentTool = {
      name: 'search_capabilities',
      description: 'Discover capabilities.',
      parameters: {
        type: 'object',
        properties: { intent: { type: 'string' } },
        required: ['intent'],
      },
      execute: async () => {
        throw new Error('AppView responded 400');
      },
    };
    const tools = new ToolRegistry();
    tools.register(discoveryTool);
    const handler = makeAgenticAskHandler({
      provider: scriptedProvider([
        { content: '', toolCalls: [discoveryCall] },
        { content: '', toolCalls: [discoveryCall] },
      ]),
      tools,
      loopOptions: { maxIterations: 2 },
    });

    const result = await handler('who serves com.acme.widget_price?');

    expect(result.response).toMatch(/reasoning budget/);
    expect(result.missingCapabilities).toHaveLength(1);
    expect(result.missingCapabilities![0]).toMatchObject({
      capability: 'com.acme.widget_price',
    });
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

  // Python-parity port: `DEFAULT_ASK_SYSTEM_PROMPT` is now
  // `VAULT_CONTEXT` — the full Python PROMPT_VAULT_CONTEXT_SYSTEM.
  // That prompt enumerates tool names (vault_search,
  // find_preferred_provider, etc.), source-trust rules, tiered content
  // loading, and the /remember pointer. The old "tool-agnostic,
  // behaviour-rules-only" invariant is intentionally superseded —
  // Python doesn't do tool-agnostic and prescriptive routing out-
  // performed tool-agnostic on the 110-scenario classifier run.
  it('default system prompt carries the Python-parity contract', () => {
    // Required safety keywords — if any of these disappear the agent
    // loses a safety property.
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toMatch(/never fabricate/i);
    // Source-trust provenance rules (ported from Python verbatim).
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('sender_trust');
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('contact_ring1');
    // Tiered content loading (content_l0 / content_l1).
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('content_l0');
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('content_l1');
    // Routing-hint awareness — classifier output gets read first.
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('Routing hint from the intent classifier');
    // /remember pointer (read-only-ness handled gracefully).
    expect(DEFAULT_ASK_SYSTEM_PROMPT).toContain('/remember');
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
    // MT-15-I3: handler now prepends a Current-context block (now_iso /
    // timezone / weekday) for relative-time grounding. The base prompt
    // is preserved verbatim BELOW the block, so contains-check it.
    expect(captured.systemPrompt).toContain(DEFAULT_ASK_SYSTEM_PROMPT);
    // The prompt body itself REFERENCES the "Routing hint" block
    // (Python-parity instruction: read the hint first). The dynamic
    // hint suffix `formatIntentHintBlock` appends uses bullet lines
    // like `- sources: [...]` — that's the discriminator for "a real
    // hint block was appended" vs "the prompt just talks about them".
    expect(captured.systemPrompt).not.toMatch(/- sources: \[/);
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
    // MT-15-I3: handler now prepends a Current-context block (now_iso /
    // timezone / weekday) for relative-time grounding. The base prompt
    // is preserved verbatim BELOW the block, so contains-check it.
    expect(captured.systemPrompt).toContain(DEFAULT_ASK_SYSTEM_PROMPT);
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
    // PROVIDER_SERVICES_ROUTING_BLOCK absent (the Path 1 / Path 2 block
    // is only appended when `sources` includes provider_services — see
    // `formatIntentHintBlock` in ask_handler.ts).
    expect(sys).not.toContain('Path 1:');
    expect(sys).not.toContain('Path 2:');
    // `find_preferred_provider` is in the Python-parity base prompt's
    // tool enumeration now, so we can't assert its absence here —
    // absence of `Path 1:` / `Path 2:` is the proper signal that the
    // provider-services ROUTING BLOCK wasn't appended.
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
    // MT-15-I3: handler now prepends a Current-context block (now_iso /
    // timezone / weekday) for relative-time grounding. The base prompt
    // is preserved verbatim BELOW the block, so contains-check it.
    expect(captured.systemPrompt).toContain(DEFAULT_ASK_SYSTEM_PROMPT);
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

// ---------------------------------------------------------------------------
// formatCurrentTimeBlock — MT-15-I3 lock-in
//
// The agentic loop MUST inject the current time so tools that need
// temporal grounding (`schedule_reminder`, "is it past business hours",
// etc.) can resolve relative phrases without a clarification round-trip.
// These tests pin the block's structure so a future refactor doesn't
// silently drop the time injection.
// ---------------------------------------------------------------------------

describe('formatCurrentTimeBlock (MT-15-I3)', () => {
  // Pinned UTC instant: 2026-05-06T17:34:00.000Z (a Wednesday).
  const FIXED_NOW_MS = Date.UTC(2026, 4, 6, 17, 34, 0);

  it('emits an ISO-8601 now plus a timezone and weekday line', () => {
    const block = formatCurrentTimeBlock(() => FIXED_NOW_MS);
    // Header must explicitly steer the LLM toward using these for
    // relative-time resolution — otherwise it can ignore them.
    expect(block).toMatch(/Current context/);
    expect(block).toMatch(/relative time/i);
    expect(block).toMatch(/now_iso: 2026-05-06T17:34:00\.000Z/);
    expect(block).toMatch(/timezone: /);
    expect(block).toMatch(/weekday: Wednesday/);
  });

  it('uses Date.now when no clock injected (smoke check, no value pin)', () => {
    // Default-clock path. Verifies the function works without an
    // injected nowMsFn. We don't assert the exact ISO since "now"
    // moves; just that the output looks like the expected shape.
    const block = formatCurrentTimeBlock();
    expect(block).toMatch(/now_iso: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(block).toMatch(/timezone: /);
  });

  it('handler prepends the time block to the system prompt on every turn', async () => {
    // Capture the system prompt the LLM saw — proves the block
    // landed in the wire request, not just in a helper that's never
    // called. This is the regression-protection assertion.
    let seenSystemPrompt = '';
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(_msgs, opts) {
        seenSystemPrompt = (opts as { systemPrompt?: string } | undefined)?.systemPrompt ?? '';
        return {
          content: 'ok',
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
    const handler = makeAgenticAskHandler({
      provider,
      tools: new ToolRegistry(),
    });
    await handler('what time is it');
    expect(seenSystemPrompt).toMatch(/Current context/);
    expect(seenSystemPrompt).toMatch(/now_iso: \d{4}-\d{2}-\d{2}T/);
    // The base system prompt must still be there underneath — we're
    // PREPENDING, not replacing.
    expect(seenSystemPrompt).toContain(DEFAULT_ASK_SYSTEM_PROMPT.slice(0, 80));
  });
});
