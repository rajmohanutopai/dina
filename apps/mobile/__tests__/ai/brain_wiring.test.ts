/**
 * brain_wiring — the bridge between the Settings-side BYOK provider
 * and Brain's chat orchestrator. Review finding #2 made this module
 * exist; review finding #6 flagged the safety-parity claim and the
 * dropped 60s timeout. This suite pins those invariants.
 *
 * We don't hit a real LLM. Instead, we register a mock `LanguageModel`
 * via the `registerBrainReasoningLLM` convenience export (which uses
 * the same timed wrapper as the keychain path) and assert what the
 * orchestrator + timeout wrapper actually do with it.
 */

import type { LanguageModel } from 'ai';
import { registerBrainReasoningLLM } from '../../src/ai/brain_wiring';
import { resetReasoningLLM } from '../../../brain/src/pipeline/chat_reasoning';
import { resetChatDefaults } from '../../../brain/src/chat/orchestrator';

// A minimal LanguageModel-alike. The `ai` SDK's `generateText` reads a
// small set of fields — we stub enough for our wrapper's one call path.
// The mock records what it was called with so the tests can assert
// system/prompt round-trip + abort-signal timeout behaviour.
function makeMockModel(
  behaviour: {
    onCall?: (args: {
      system: string | undefined;
      prompt: string | undefined;
      signal?: AbortSignal;
    }) => void;
    response?: string;
    delayMs?: number;
  } = {},
): LanguageModel {
  const response = behaviour.response ?? 'mocked-answer';
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async (opts: unknown) => {
      const o = opts as { prompt?: unknown; abortSignal?: AbortSignal };
      // Pull the system string and the user prompt out of the message array.
      const prompt = Array.isArray(o.prompt) ? o.prompt : [];
      const systemMsg = prompt.find((m: { role: string }) => m.role === 'system');
      const userMsg = prompt.find((m: { role: string }) => m.role === 'user');
      const userText =
        userMsg !== undefined && Array.isArray((userMsg as { content: unknown[] }).content)
          ? ((userMsg as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
          : '';
      behaviour.onCall?.({
        system: systemMsg !== undefined ? (systemMsg as { content: string }).content : undefined,
        prompt: userText,
        signal: o.abortSignal,
      });
      if (behaviour.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, behaviour.delayMs);
          o.abortSignal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          });
        });
      }
      return {
        content: [{ type: 'text', text: response }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        response: { id: 'mock', timestamp: new Date(), modelId: 'mock-model' },
        request: {},
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error('not implemented in mock');
    },
  } as unknown as LanguageModel;
}

beforeEach(() => {
  resetReasoningLLM();
  resetChatDefaults();
});

describe('registerBrainReasoningLLM — Brain orchestrator sees our provider', () => {
  it('passes query + context through to the registered model', async () => {
    const seen: Array<{ system: string | undefined; prompt: string | undefined }> = [];
    const model = makeMockModel({
      onCall: (args) => seen.push({ system: args.system, prompt: args.prompt }),
      response: 'from mock',
    });
    registerBrainReasoningLLM('openai', model);

    // Pull the registered lambda back via the chat_reasoning module —
    // it's private, so we exercise it indirectly by invoking it via
    // the same module-level ref. Import-order friendly: reason() is
    // what actually calls the registered LLM in production.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pipeline = require('../../../brain/src/pipeline/chat_reasoning') as {
      reason: (req: {
        query: string;
        persona: string;
        provider: string;
      }) => Promise<{ answer: string }>;
    };
    const result = await pipeline.reason({
      query: 'what time is it',
      persona: 'general',
      provider: 'openai',
    });
    expect(result.answer).toContain('from mock');
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toBe('what time is it');
    // System block includes vault context assembled by the pipeline.
    expect(typeof seen[0].system).toBe('string');
  });
});

describe('makeTimedReasoningLLM — abort-signal timeout survives a stalled call (#6)', () => {
  // Exercise the timed wrapper directly. We drive real time via a
  // small custom timeout override rather than jest.useFakeTimers()
  // because fake timers also intercept the AI SDK's internal
  // setTimeouts, which hangs in cross-realm promise plumbing.
  it('aborts the underlying call when the timeout elapses', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeTimedReasoningLLM } =
      require('../../src/ai/brain_wiring') as typeof import('../../src/ai/brain_wiring');

    let capturedSignal: AbortSignal | undefined;
    const model = makeMockModel({
      onCall: (args) => {
        capturedSignal = args.signal;
      },
      // Stall forever unless aborted. If the timeout was dropped
      // this test hangs (jest 5s default fails noisily rather than
      // silently passing).
      delayMs: 30_000,
    });

    // Override the real timeout: swap setTimeout briefly so the
    // wrapper fires its abort ~immediately while the mock is still
    // stalled. We restore after.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms: number) =>
      originalSetTimeout(fn, 10)) as typeof globalThis.setTimeout;
    try {
      const fn = makeTimedReasoningLLM(model);
      await expect(fn('stall me', 'ctx')).rejects.toThrow(/Abort/i);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('returns the text unchanged on a successful call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeTimedReasoningLLM } =
      require('../../src/ai/brain_wiring') as typeof import('../../src/ai/brain_wiring');
    const model = makeMockModel({ response: 'hello world' });
    const fn = makeTimedReasoningLLM(model);
    const out = await fn('hi', 'system');
    expect(out).toBe('hello world');
  });
});
