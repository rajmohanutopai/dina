/**
 * Contract test for the /remember agentic runtime. Uses a scripted
 * LLM provider to verify the loop's wiring: tools are registered,
 * the system prompt is rendered with installed personas, and the
 * side-effects collector captures every tool call. Real LLM
 * behaviour is out of scope (covered by integration runs).
 */

import { resetReminderState, listByPersona } from '@dina/core/reminders';
import { clearVaults, storeItem } from '@dina/core';

import { setAccessiblePersonas, resetReasoningProvider } from '../../src/vault_context/assembly';
import { buildRememberRuntime } from '../../src/composition/remember_runtime';
import type {
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';

function scripted(script: Array<Partial<ChatResponse>>): {
  provider: LLMProvider;
  systemPromptSeen: string[];
} {
  const systemPromptSeen: string[] = [];
  let i = 0;
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(_messages, opts?: ChatOptions) {
      // agentic_loop passes systemPrompt via ChatOptions, not as a
      // message in the transcript.
      if (opts?.systemPrompt !== undefined) {
        systemPromptSeen.push(opts.systemPrompt);
      }
      const step = script[i] ?? { content: '', toolCalls: [] };
      i++;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 1 },
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
  return { provider, systemPromptSeen };
}

describe('buildRememberRuntime', () => {
  // Reset every process-global the runtime touches so each test starts
  // clean: the reminder service map, the in-process vault, the search
  // backend, and the accessible-persona allowlist (baseline = none; the
  // tests that exercise vault_search opt in explicitly).
  beforeEach(() => {
    resetReminderState();
    clearVaults();
    resetReasoningProvider();
    setAccessiblePersonas([]);
  });

  it('renders persona list + today + timezone into the system prompt', async () => {
    const { provider, systemPromptSeen } = scripted([{ content: 'ok', toolCalls: [] }]);
    const { run } = buildRememberRuntime({
      llm: provider,
      personas: [
        { name: 'general', description: 'everyday notes' },
        { name: 'finance', description: 'budgets and money' },
      ],
      today: '2026-05-18',
      timezone: 'Asia/Kolkata',
    });

    await run({ memoryText: 'random thing' });

    const sys = systemPromptSeen[0] ?? '';
    expect(sys).toContain('general — everyday notes');
    expect(sys).toContain('finance — budgets and money');
    expect(sys).toContain('2026-05-18');
    expect(sys).toContain('Asia/Kolkata');
    // Recall nudge must stay — it's what makes the loop search the vault to
    // enrich reminders ("Emma's birthday" + prior "Emma loves dinosaurs").
    expect(sys).toContain('vault_search');
  });

  it('captures tool calls into the side-effects collector', async () => {
    const tcs: ToolCall[] = [
      { id: 't1', name: 'route_to_persona', arguments: { persona: 'finance' } },
      {
        id: 't2',
        name: 'link_to_person',
        arguments: {
          canonicalName: 'Emma',
          surface: 'Emma',
          surfaceType: 'name',
          relationshipHint: 'daughter',
          sourceExcerpt: 'Emma is my daughter',
        },
      },
      {
        id: 't3',
        name: 'bind_preference',
        arguments: {
          subjectKind: 'person',
          subject: 'Emma',
          preference: 'loves dinosaurs',
        },
      },
    ];
    const { provider } = scripted([
      { toolCalls: tcs },
      { content: 'Saved.', toolCalls: [] },
    ]);
    const { run } = buildRememberRuntime({
      llm: provider,
      personas: [{ name: 'general' }, { name: 'finance' }],
    });

    const result = await run({
      memoryText: 'Emma is my daughter and loves dinosaurs',
    });

    expect(result.text).toBe('Saved.');
    expect(result.toolNames).toEqual([
      'route_to_persona',
      'link_to_person',
      'bind_preference',
    ]);
    expect(result.sideEffects.routes).toEqual([
      { primary: 'finance', secondary: [] },
    ]);
    expect(result.sideEffects.people).toHaveLength(1);
    expect(result.sideEffects.people[0]?.canonicalName).toBe('Emma');
    expect(result.sideEffects.preferences).toHaveLength(1);
    expect(result.sideEffects.preferences[0]?.preference).toBe('loves dinosaurs');
  });

  it('threads sourceItemId + routed persona into schedule_reminder (birthday fix)', async () => {
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const { provider } = scripted([
      {
        toolCalls: [
          { id: 't1', name: 'route_to_persona', arguments: { persona: 'health' } },
          // NOTE: no `persona` arg on schedule_reminder — the runtime must
          // fall back to the routed persona ('health'), not 'general'.
          {
            id: 't2',
            name: 'schedule_reminder',
            arguments: { message: "Emma's birthday is coming up", due_at: dueAt },
          },
        ],
      },
      { content: "I'll remind you before Emma's birthday.", toolCalls: [] },
    ]);
    const { run } = buildRememberRuntime({
      llm: provider,
      personas: [{ name: 'general' }, { name: 'health' }],
    });

    const result = await run({
      memoryText: "Emma's birthday is on Nov 7",
      sourceItemId: 'stage-xyz',
    });

    expect(result.toolNames).toEqual(['route_to_persona', 'schedule_reminder']);

    // The reminder must land in the ROUTED persona ('health'), carry the
    // staging id (so the chat "Reminders set" card renders), and exist
    // exactly once — not silently default to 'general'.
    const created = listByPersona('health');
    expect(created).toHaveLength(1);
    expect(created[0]?.source_item_id).toBe('stage-xyz');
    expect(created[0]?.message).toBe("Emma's birthday is coming up");
    expect(listByPersona('general')).toHaveLength(0);
  });

  it('exposes vault_search so the loop can recall prior memories to enrich (dinosaur fix)', async () => {
    setAccessiblePersonas(['general']); // opt in to vault access for this test
    // A fact the user saved in an EARLIER memory.
    storeItem('general', {
      type: 'user_memory',
      summary: 'Emma loves dinosaurs',
      body: 'Emma loves dinosaurs',
    });

    // Capture every message the provider sees so we can prove the
    // vault_search result (the dinosaur fact) gets fed back into the loop
    // — i.e. the recall tool is registered AND surfaces prior memories.
    const messagesSeen: Array<{ role: string; content: unknown }> = [];
    let i = 0;
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(messages: Array<{ role: string; content: unknown }>) {
        messagesSeen.push(...messages);
        const step = i++;
        if (step === 0) {
          // First turn: recall what we already know about Emma.
          return {
            content: '',
            toolCalls: [{ id: 's1', name: 'vault_search', arguments: { query: 'Emma' } }],
            model: 'test',
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'tool_use' as const,
          };
        }
        return {
          content: 'Saved — and Emma loves dinosaurs.',
          toolCalls: [],
          model: 'test',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'end' as const,
        };
      },
      async *stream() {
        throw new Error('not used');
      },
      async embed() {
        throw new Error('not used');
      },
    };

    const { run } = buildRememberRuntime({ llm: provider, personas: [{ name: 'general' }] });
    const result = await run({ memoryText: "Emma's birthday is on Nov 7", sourceItemId: 'stage-1' });

    expect(result.toolNames).toContain('vault_search');
    // The recall result must have been fed back into the loop — without the
    // tool registered the loop couldn't surface "Emma loves dinosaurs" and
    // the model could never enrich the reminder with it.
    const allText = messagesSeen
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(allText).toMatch(/Emma loves dinosaurs/);
  });

  it('D2D arrival: renders sender context (relatedMemories) + schedules an enriched arrival reminder', async () => {
    // For a D2D arrival the staging drain resolves the sender → person and
    // feeds their subject-linked memories into the loop via `relatedMemories`
    // (drain.ts → recallSenderSubjectMemories; that recall is covered by
    // subject_recall.test). This proves the agentic loop (a) SEES that sender
    // context and (b) schedules a reminder for the arrival, linked to the
    // D2D item — i.e. enrichment + reminders work on the Talk/D2D path.
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    let userMsgSeen = '';
    let i = 0;
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(messages: Array<{ role: string; content: unknown }>) {
        const user = messages.find((m) => m.role === 'user');
        if (user !== undefined && typeof user.content === 'string') userMsgSeen += user.content;
        if (i++ === 0) {
          return {
            content: '',
            toolCalls: [
              { id: 'r1', name: 'route_to_persona', arguments: { persona: 'general' } },
              {
                id: 'r2',
                name: 'schedule_reminder',
                arguments: {
                  message: 'Alonso arriving at 4pm — have a matcha latte ready',
                  due_at: dueAt,
                },
              },
            ],
            model: 'test',
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'tool_use' as const,
          };
        }
        return {
          content: "I'll have a matcha ready.",
          toolCalls: [],
          model: 'test',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'end' as const,
        };
      },
      async *stream() {
        throw new Error('not used');
      },
      async embed() {
        throw new Error('not used');
      },
    };

    const { run } = buildRememberRuntime({ llm: provider, personas: [{ name: 'general' }] });
    const result = await run({
      memoryText: "I'm coming over at 4pm",
      sourceItemId: 'd2d-1',
      // Exactly what the drain hands in for a D2D arrival: the sender's
      // recalled subject memories.
      relatedMemories: ['Alonso prefers matcha lattes'],
    });

    // Enrichment: the sender's recalled memory reached the loop's input.
    expect(userMsgSeen).toMatch(/matcha/i);
    // Reminder: the loop scheduled an arrival reminder, enriched with the
    // sender context, linked to the D2D item.
    expect(result.toolNames).toContain('schedule_reminder');
    const reminders = listByPersona('general');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source_item_id).toBe('d2d-1');
    expect(reminders[0]?.message).toMatch(/matcha/i);
  });

  it("returns empty side effects when the LLM doesn't call any tools", async () => {
    const { provider } = scripted([{ content: 'just stored', toolCalls: [] }]);
    const { run } = buildRememberRuntime({
      llm: provider,
      personas: [{ name: 'general' }],
    });

    const result = await run({ memoryText: 'some random thought' });

    expect(result.text).toBe('just stored');
    expect(result.toolNames).toEqual([]);
    expect(result.sideEffects.routes).toEqual([]);
    expect(result.sideEffects.people).toEqual([]);
    expect(result.sideEffects.preferences).toEqual([]);
  });

  it('renders metadata trailer when type / source / sender / subject are present', async () => {
    let userMessageSeen = '';
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(messages: Array<{ role: string; content: unknown }>) {
        const user = messages.find((m) => m.role === 'user');
        if (user !== undefined && typeof user.content === 'string') {
          userMessageSeen = user.content;
        }
        return {
          content: '',
          toolCalls: [],
          model: 'test',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'end',
        };
      },
      async *stream() {
        throw new Error('not used');
      },
      async embed() {
        throw new Error('not used');
      },
    };
    const { run } = buildRememberRuntime({
      llm: provider,
      personas: [{ name: 'general' }],
    });
    await run({
      memoryText: 'budget tight',
      metadata: { type: 'email_thread', source: 'gmail', sender: 'alice@example.com' },
    });
    expect(userMessageSeen).toContain('budget tight');
    expect(userMessageSeen).toContain('[metadata:');
    expect(userMessageSeen).toContain('type=email_thread');
    expect(userMessageSeen).toContain('source=gmail');
    expect(userMessageSeen).toContain('sender=alice@example.com');
  });
});
