/**
 * AISDKAdapter — the bridge between Brain's `LLMProvider` interface
 * and Vercel's AI SDK. Covers the three seams flagged in review #2's
 * #7 + #8:
 *
 *   - stream() / embed() point callers at the right alternative
 *     instead of silently half-working
 *   - toAISDKMessages joins multiple system blocks (they used to be
 *     silently discarded after the first one)
 *   - finish reason mapping: 'length' → max_tokens, tool calls flip
 *     'stop' to 'tool_use', etc.
 */

import type { LanguageModel } from 'ai';
import { AISDKAdapter } from '../../src/ai/aisdk_adapter';

function makeMock(opts: {
  onCall?: (prompt: unknown) => void;
  finishReason?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>;
  text?: string;
}): LanguageModel {
  const contentParts: Array<Record<string, unknown>> = [];
  if (opts.text !== undefined) contentParts.push({ type: 'text', text: opts.text });
  for (const tc of opts.toolCalls ?? []) {
    contentParts.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
  }
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async (params: unknown) => {
      opts.onCall?.((params as { prompt: unknown }).prompt);
      return {
        content: contentParts.length > 0 ? contentParts : [{ type: 'text', text: opts.text ?? '' }],
        finishReason: opts.finishReason ?? 'stop',
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        response: { id: 'mock', timestamp: new Date(), modelId: 'mock-model' },
        request: {},
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error('not implemented');
    },
  } as unknown as LanguageModel;
}

describe('AISDKAdapter — unsupported surfaces point at the right alternative (#7)', () => {
  it('stream() throws with a message that names the correct alternative', () => {
    const adapter = new AISDKAdapter({ model: makeMock({}), name: 'openai' });
    expect(() => adapter.stream()).toThrow(/streamText/);
  });

  it("embed() rejects with a message pointing at Brain's embedding pipeline", async () => {
    const adapter = new AISDKAdapter({ model: makeMock({}), name: 'openai' });
    await expect(adapter.embed('some text')).rejects.toThrow(
      /registerLocalProvider|registerCloudProvider/,
    );
  });
});

describe('AISDKAdapter — multiple system messages are joined, not discarded (#8)', () => {
  it('joins every system entry with blank-line separators', async () => {
    const calls: unknown[] = [];
    const adapter = new AISDKAdapter({
      model: makeMock({ onCall: (p) => calls.push(p), text: 'ok' }),
      name: 'openai',
    });
    await adapter.chat([
      { role: 'system', content: 'block A — persona context' },
      { role: 'system', content: 'block B — guard-scan hints' },
      { role: 'user', content: 'hello' },
    ]);
    // generateText was called with the prompt array; the system block is
    // threaded through as the first entry (role: 'system') built from
    // the joined system string.
    expect(calls).toHaveLength(1);
    const prompt = calls[0] as Array<{ role: string; content: string | Array<{ text?: string }> }>;
    const system = prompt.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    const sys =
      typeof system!.content === 'string'
        ? system!.content
        : (system!.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
    // Both blocks are present; the second wasn't dropped.
    expect(sys).toContain('block A');
    expect(sys).toContain('block B');
  });

  it('prefers options.systemPrompt but still folds extra system messages in', async () => {
    const calls: unknown[] = [];
    const adapter = new AISDKAdapter({
      model: makeMock({ onCall: (p) => calls.push(p), text: 'ok' }),
      name: 'openai',
    });
    await adapter.chat(
      [
        { role: 'system', content: 'pipeline-layer note' },
        { role: 'user', content: 'q' },
      ],
      { systemPrompt: 'top-level instruction' },
    );
    const prompt = calls[0] as Array<{ role: string; content: string | Array<{ text?: string }> }>;
    const system = prompt.find((m) => m.role === 'system');
    const sys =
      typeof system!.content === 'string'
        ? system!.content
        : (system!.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
    expect(sys).toContain('top-level instruction');
    expect(sys).toContain('pipeline-layer note');
  });
});

describe('AISDKAdapter — finish reason mapping', () => {
  it('maps length → max_tokens', async () => {
    const adapter = new AISDKAdapter({
      model: makeMock({ finishReason: 'length', text: 'truncated' }),
      name: 'openai',
    });
    const res = await adapter.chat([{ role: 'user', content: 'hi' }]);
    expect(res.finishReason).toBe('max_tokens');
  });

  it('maps stop with tool calls → tool_use (so the agentic loop keeps iterating)', async () => {
    const adapter = new AISDKAdapter({
      model: makeMock({
        finishReason: 'stop',
        toolCalls: [{ toolCallId: 'c1', toolName: 'geocode', input: { address: 'SF' } }],
      }),
      name: 'openai',
    });
    const res = await adapter.chat([{ role: 'user', content: 'hi' }]);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('geocode');
  });

  it('maps plain stop (no tool calls) → end', async () => {
    const adapter = new AISDKAdapter({
      model: makeMock({ finishReason: 'stop', text: 'final' }),
      name: 'openai',
    });
    const res = await adapter.chat([{ role: 'user', content: 'hi' }]);
    expect(res.finishReason).toBe('end');
  });
});
