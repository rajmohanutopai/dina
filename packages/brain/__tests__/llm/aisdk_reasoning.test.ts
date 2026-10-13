/**
 * AISDKAdapter — a short decision asks the model for the lowest thinking
 * effort, under the key the OpenAI SDK reads (`reasoningEffort`).
 */

import { MockLanguageModelV3 } from 'ai/test';

import { AISDKAdapter } from '../../src/llm/adapters/aisdk';

function capture(modelId: string) {
  const seen: unknown[] = [];
  const model = new MockLanguageModelV3({
    modelId,
    doGenerate: async (opts) => {
      seen.push(opts.providerOptions);
      return {
        content: [{ type: 'text', text: '{"ids":[]}' }],
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never;
    },
  });
  return { model, seen };
}

it("asks OpenRouter for 'none' on a short decision, and for nothing otherwise", async () => {
  const { model, seen } = capture('deepseek/deepseek-v4.1-flash');
  const adapter = new AISDKAdapter({ model, name: 'openrouter' });
  await adapter.chat([{ role: 'user', content: 'x' }], { reasoning: 'low' });
  await adapter.chat([{ role: 'user', content: 'x' }]);
  expect(seen[0]).toEqual({ openai: { reasoningEffort: 'none' } });
  expect(seen[1] ?? {}).toEqual({});
});

it("uses an OpenAI model's own lowest effort", async () => {
  const { model, seen } = capture('gpt-5-mini');
  const adapter = new AISDKAdapter({ model, name: 'openai' });
  await adapter.chat([{ role: 'user', content: 'x' }], { reasoning: 'low' });
  expect((seen[0] as { openai: { reasoningEffort?: string } }).openai.reasoningEffort).toBe('minimal');
});

it('sends nothing for a provider it does not know', async () => {
  const { model, seen } = capture('claude-haiku-4-5');
  const adapter = new AISDKAdapter({ model, name: 'claude' });
  await adapter.chat([{ role: 'user', content: 'x' }], { reasoning: 'low' });
  expect(seen[0] ?? {}).toEqual({});
});
