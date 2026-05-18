/**
 * Contract test for the /remember agentic runtime. Uses a scripted
 * LLM provider to verify the loop's wiring: tools are registered,
 * the system prompt is rendered with installed personas, and the
 * side-effects collector captures every tool call. Real LLM
 * behaviour is out of scope (covered by integration runs).
 */

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
