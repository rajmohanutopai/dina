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
  expect((seen[0] as { openai: { reasoningEffort?: string } }).openai.reasoningEffort).toBe(
    'minimal',
  );
});

it('sends nothing for a provider it does not know', async () => {
  const { model, seen } = capture('claude-haiku-4-5');
  const adapter = new AISDKAdapter({ model, name: 'claude' });
  await adapter.chat([{ role: 'user', content: 'x' }], { reasoning: 'low' });
  expect(seen[0] ?? {}).toEqual({});
});

describe('the model each call names (TODO #10: lite tier ignored)', () => {
  function track() {
    const used: string[] = [];
    const build = (id: string) =>
      new MockLanguageModelV3({
        modelId: id,
        doGenerate: async () => {
          used.push(id);
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          } as never;
        },
      });
    return { used, build };
  }

  it('runs the named model when it can build one, and the default otherwise', async () => {
    const { used, build } = track();
    const adapter = new AISDKAdapter({ model: build('big'), modelFor: build, name: 'openrouter' });
    await adapter.chat([{ role: 'user', content: 'x' }], { model: 'small' });
    await adapter.chat([{ role: 'user', content: 'x' }]);
    await adapter.chat([{ role: 'user', content: 'x' }], { model: 'big' });
    expect(used).toEqual(['small', 'big', 'big']);
  });

  it('keeps the default model when it has no way to build another', async () => {
    const { used, build } = track();
    const adapter = new AISDKAdapter({ model: build('big'), name: 'openrouter' });
    await adapter.chat([{ role: 'user', content: 'x' }], { model: 'small' });
    expect(used).toEqual(['big']);
  });

  it('applies the pinned effort to the default model only', async () => {
    const seen: unknown[] = [];
    const build = (id: string) =>
      new MockLanguageModelV3({
        modelId: id,
        doGenerate: async (opts) => {
          seen.push(opts.providerOptions);
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          } as never;
        },
      });
    const adapter = new AISDKAdapter({
      model: build('gpt-5.5'),
      modelFor: build,
      name: 'openai',
      openaiReasoningEffort: 'high',
    });
    await adapter.chat([{ role: 'user', content: 'x' }]);
    await adapter.chat([{ role: 'user', content: 'x' }], { model: 'gpt-5-mini' });
    expect((seen[0] as { openai: { reasoning: { effort: string } } }).openai.reasoning.effort).toBe(
      'high',
    );
    expect((seen[1] as { openai: { reasoning: { effort: string } } }).openai.reasoning.effort).toBe(
      'minimal',
    );
  });
});
