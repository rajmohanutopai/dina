/**
 * Multi-domain context-synthesis contract test — proves the agentic
 * loop can pull `find_person` + cross-persona `vault_search` (general +
 * finance) into a single answer, exactly the path the Emma scenario
 * needs.
 *
 * This is a CONTRACT test in the sense of `feedback_test_strategy`:
 * the bug class we close is "the LLM has the wrong tools available
 * for cross-domain synthesis". We do NOT test Gemini's specific
 * wording — that's a scenario test and would be flaky across model
 * versions. We test the SHAPE of what the loop produces given a
 * scripted LLM:
 *
 *   1. The agentic loop happily routes `find_person` calls through
 *      to the people repo (via the in-process path).
 *   2. The same loop calls `vault_search` and observes that the fan-
 *      out walks every persona in `accessiblePersonas` — including
 *      finance, which the lite stack used to silently skip.
 *   3. The final text the loop returns is whatever the LLM emitted.
 *      The test doesn't inspect content quality — only that the
 *      tool sequence was available + executed cleanly.
 *
 * Three variants:
 *   - rich-budget — finance vault contains a roomy budget item; the
 *     LLM script picks premium suggestions.
 *   - tight-budget — finance vault contains a modest budget; the
 *     LLM script picks modest suggestions.
 *   - no-budget — finance vault is empty; the LLM asks for a budget.
 *
 * All three share the same plumbing assertions; the difference is in
 * the scripted LLM's final text + which vault items were returned.
 */

import { runAgenticTurn } from '../../src/reasoning/agentic_loop';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import { createFindPersonTool } from '../../src/reasoning/people_tool';
import { createVaultSearchTool } from '../../src/reasoning/vault_tool';
import {
  setAccessiblePersonas,
  setPeopleReadBackend,
} from '../../src/vault_context/assembly';
import {
  clearVaults,
  createPersona,
  resetPersonaState,
  setPeopleRepository,
  storeItem,
} from '@dina/core';
import type {
  ApplyExtractionResponse,
  ExtractionResult,
  PeopleRepository,
  Person,
  PersonSurface,
} from '@dina/core';
import type {
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emmaPerson(): Person {
  const s: PersonSurface[] = [
    {
      id: 1,
      personId: 'p-emma',
      surface: 'Emma',
      normalizedSurface: 'emma',
      surfaceType: 'name',
      status: 'confirmed',
      confidence: 'high',
      sourceItemId: 'src-emma-1',
      sourceExcerpt: 'Emma is my daughter',
      extractorVersion: 'test-1',
      createdFrom: 'llm',
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return {
    personId: 'p-emma',
    canonicalName: 'Emma',
    contactDid: '',
    relationshipHint: 'daughter',
    status: 'confirmed',
    createdFrom: 'llm',
    createdAt: 0,
    updatedAt: 0,
    surfaces: s,
  };
}

class EmmaRepo implements PeopleRepository {
  listPeople(): Person[] {
    return [emmaPerson()];
  }
  applyExtraction(_: ExtractionResult): ApplyExtractionResponse {
    return { created: 0, updated: 0, conflicts: [], skipped: false };
  }
  getPerson(id: string): Person | null {
    return id === 'p-emma' ? emmaPerson() : null;
  }
  findByContactDid(): Person | null {
    return null;
  }
  confirmPerson(): boolean {
    return false;
  }
  rejectPerson(): boolean {
    return false;
  }
  confirmSurface(): boolean {
    return false;
  }
  rejectSurface(): boolean {
    return false;
  }
  detachSurface(): boolean {
    return false;
  }
  mergePeople(): void {}
  deletePerson(): boolean {
    return false;
  }
  linkContact(): boolean {
    return false;
  }
  upsertContactPerson(): string {
    return '';
  }
  resolveConfirmedSurfaces() {
    return new Map();
  }
  clearExcerptsForItem(): number {
    return 0;
  }
  garbageCollect(): number {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Scripted LLM (records every tool call the loop dispatched)
// ---------------------------------------------------------------------------

function scriptedProvider(script: Array<Partial<ChatResponse>>): {
  provider: LLMProvider;
  toolCalls: ToolCall[];
} {
  let i = 0;
  const toolCalls: ToolCall[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(_messages, _options?: ChatOptions) {
      const step = script[i] ?? { content: '(end of script)', toolCalls: [] };
      i++;
      const calls = step.toolCalls ?? [];
      toolCalls.push(...calls);
      return {
        content: step.content ?? '',
        toolCalls: calls,
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: calls.length > 0 ? 'tool_use' : 'end',
      };
    },
    async *stream() {
      throw new Error('not used');
    },
    async embed() {
      throw new Error('not used');
    },
  };
  return { provider, toolCalls };
}

// ---------------------------------------------------------------------------
// Suite — one beforeEach prepares the personas + people graph + vault
// fixture. Each test then runs the loop with its own LLM script and
// asserts the tool sequence + final text shape.
// ---------------------------------------------------------------------------

describe('agentic synthesis — people graph + finance vault', () => {
  function buildTools(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(createFindPersonTool());
    reg.register(createVaultSearchTool());
    return reg;
  }

  beforeEach(() => {
    // Pass `finance` explicitly — it's not in the default test
    // persona set (which uses `financial`); lite's persona convention
    // uses `finance`. `general` is in the defaults; we list both so
    // the registered repos line up with `setAccessiblePersonas` below.
    clearVaults(['general', 'finance']);
    resetPersonaState();
    setPeopleReadBackend(null);
    setPeopleRepository(new EmmaRepo());
    createPersona('general', 'default');
    createPersona('finance', 'locked');
    // ALL personas open for an in-app user (memory:
    // user-vs-agent-persona-access). This is what the brain-server
    // boot does too — mirrors Core's registry without isOpen filter.
    setAccessiblePersonas(['general', 'finance']);
    storeItem('general', {
      type: 'user_memory',
      summary: 'Emma loves dinosaurs',
      body: 'Emma loves dinosaurs',
    });
  });

  afterEach(() => {
    setPeopleRepository(null);
  });

  it('rich-budget variant — loop calls find_person, fans out vault_search across general + finance, returns final text', async () => {
    storeItem('finance', {
      type: 'user_memory',
      summary: 'Monthly toy budget: $250',
      body: 'Monthly toy budget: $250 — comfortable splurge OK',
    });

    const { provider, toolCalls } = scriptedProvider([
      {
        toolCalls: [{ id: 't1', name: 'find_person', arguments: { name: 'Emma' } }],
      },
      {
        toolCalls: [{ id: 't2', name: 'vault_search', arguments: { query: 'Emma dinosaurs' } }],
      },
      {
        toolCalls: [
          {
            id: 't3',
            name: 'vault_search',
            arguments: { query: 'toy budget', persona: 'finance' },
          },
        ],
      },
      {
        content:
          'Your daughter Emma loves dinosaurs. With a $250 monthly toy budget you can comfortably look at premium options like a large LEGO Jurassic World set or a high-end dinosaur encyclopedia.',
        toolCalls: [],
      },
    ]);

    const result = await runAgenticTurn({
      provider,
      tools: buildTools(),
      systemPrompt: 'You are Dina.',
      userMessage: 'What should I get Emma for her birthday?',
    });

    const names = toolCalls.map((c) => c.name);
    expect(names).toContain('find_person');
    expect(names).toContain('vault_search');
    // The agentic loop didn't silently drop the finance vault_search —
    // it routed the persona='finance' arg through.
    const financeCall = toolCalls.find(
      (c) => c.name === 'vault_search' && (c.arguments as { persona?: string }).persona === 'finance',
    );
    expect(financeCall).toBeDefined();

    expect(result.answer).toContain('Emma');
    expect(result.answer).toContain('$250');
    expect(result.finishReason).toBe('completed');
  });

  it('tight-budget variant — final text reflects modest budget, same tool sequence', async () => {
    storeItem('finance', {
      type: 'user_memory',
      summary: 'Monthly toy budget: $25',
      body: 'Monthly toy budget: $25 — tight this quarter',
    });

    const { provider, toolCalls } = scriptedProvider([
      { toolCalls: [{ id: 't1', name: 'find_person', arguments: { name: 'Emma' } }] },
      {
        toolCalls: [
          { id: 't2', name: 'vault_search', arguments: { query: 'toy budget', persona: 'finance' } },
        ],
      },
      {
        content:
          "Emma's your daughter and loves dinosaurs. With a $25 budget, a small dinosaur figurine set or a used encyclopedia would fit well.",
        toolCalls: [],
      },
    ]);

    const result = await runAgenticTurn({
      provider,
      tools: buildTools(),
      systemPrompt: 'You are Dina.',
      userMessage: 'What should I get Emma for her birthday?',
    });

    expect(toolCalls.map((c) => c.name)).toEqual(['find_person', 'vault_search']);
    expect(result.answer).toContain('$25');
    expect(result.answer.toLowerCase()).toContain('emma');
  });

  it('no-budget variant — finance vault empty, loop still runs find_person + general vault_search and final text asks for budget', async () => {
    // No finance item stored.
    const { provider, toolCalls } = scriptedProvider([
      { toolCalls: [{ id: 't1', name: 'find_person', arguments: { name: 'Emma' } }] },
      {
        toolCalls: [
          { id: 't2', name: 'vault_search', arguments: { query: 'toy budget', persona: 'finance' } },
        ],
      },
      {
        content:
          "I see Emma's your daughter and loves dinosaurs, but I don't have a budget recorded. What price range works for you?",
        toolCalls: [],
      },
    ]);

    const result = await runAgenticTurn({
      provider,
      tools: buildTools(),
      systemPrompt: 'You are Dina.',
      userMessage: 'What should I get Emma for her birthday?',
    });

    expect(toolCalls.map((c) => c.name)).toContain('find_person');
    expect(result.answer.toLowerCase()).toContain('budget');
  });

  it('finance vault is searched even when not explicitly named — the fan-out covers every accessible persona', async () => {
    storeItem('finance', {
      type: 'user_memory',
      summary: 'Monthly toy budget: $100',
      body: 'Monthly toy budget: $100',
    });

    // The LLM script uses ONLY a generic `vault_search` (no persona arg)
    // — the tool's default fan-out should still walk finance.
    const { provider } = scriptedProvider([
      {
        toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'Emma' } }],
      },
      { content: 'done', toolCalls: [] },
    ]);

    const result = await runAgenticTurn({
      provider,
      tools: buildTools(),
      systemPrompt: 'You are Dina.',
      userMessage: 'Tell me about Emma and her budget.',
    });

    // The tool result is on the transcript — verify finance was
    // walked. We don't assert the budget item matched the query "Emma"
    // — keyword FTS5 won't bridge "Emma → budget", which is exactly the
    // limitation that motivates the `find_person` + scoped follow-up
    // search pattern. Here we just check that the fan-out *visits*
    // finance so a later, better-scoped query against finance could
    // succeed.
    const toolResultMsg = result.transcript.find(
      (m) => m.role === 'tool' && (m.content as string).includes('personas_searched'),
    );
    expect(toolResultMsg).toBeDefined();
    const body = toolResultMsg!.content as string;
    expect(body).toContain('"finance"');
    expect(body).toContain('"general"');
  });
});
