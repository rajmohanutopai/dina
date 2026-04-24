/**
 * LLMRouter dispatch layer — tier picks + PII scrub round-trip +
 * cloud-consent gate.
 *
 * The router is the single seam every cloud LLM call goes through;
 * every knob (scrub, consent, tier, provider fan-in) is covered here.
 * The end-to-end Gemini run still lives in
 * `persona_classification_real_llm_100.test.ts`, but we don't need a
 * live API to verify the router's own logic.
 */

import {
  LLMRouter,
  RoutedLLMProvider,
  rehydrateResponse,
} from '../../src/llm/router_dispatch';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
} from '../../src/llm/adapters/provider';
import { CloudConsentError } from '../../../core/src/errors';

function makeStubProvider(overrides?: Partial<ChatResponse>): {
  provider: LLMProvider;
  lastMessages: () => ChatMessage[] | undefined;
  lastOptions: () => ChatOptions | undefined;
} {
  let lastMessages: ChatMessage[] | undefined;
  let lastOptions: ChatOptions | undefined;
  const chat = jest.fn(
    async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      lastMessages = messages;
      lastOptions = options;
      return {
        content: 'ok',
        toolCalls: [],
        model: 'stub',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'end',
        ...(overrides ?? {}),
      };
    },
  );
  const provider: LLMProvider = {
    name: 'stub',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat,
    stream: jest.fn(),
    embed: jest.fn(),
  };
  return {
    provider,
    lastMessages: () => lastMessages,
    lastOptions: () => lastOptions,
  };
}

describe('LLMRouter', () => {
  describe('tier selection', () => {
    it('picks the lite tier for classify', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await router.chat({
        taskType: 'classify',
        messages: [{ role: 'user', content: 'pick a vault' }],
      });
      expect(stub.lastOptions()?.model).toBe('gemini-3.1-flash-lite-preview');
    });

    it('picks the primary tier for reason', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await router.chat({
        taskType: 'reason',
        messages: [{ role: 'user', content: 'explain' }],
      });
      expect(stub.lastOptions()?.model).toBe('gemini-3.1-pro-preview');
    });

    it('honours an explicit modelOverride', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await router.chat({
        taskType: 'classify',
        messages: [{ role: 'user', content: 'hi' }],
        modelOverride: 'gemini-3.1-pro-preview',
      });
      expect(stub.lastOptions()?.model).toBe('gemini-3.1-pro-preview');
    });
  });

  describe('PII scrub + rehydrate', () => {
    it('scrubs outbound user messages before the provider sees them', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await router.chat({
        taskType: 'reason',
        messages: [
          { role: 'user', content: 'Email Sarah at sarah@example.com please' },
        ],
      });
      const sent = stub.lastMessages()?.[0].content ?? '';
      expect(sent).not.toContain('sarah@example.com');
      expect(sent).toMatch(/\[EMAIL_1\]/);
    });

    it('rehydrates the token in the response content', async () => {
      const stub = makeStubProvider({
        content: 'I will email [EMAIL_1] right away',
      });
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      const response = await router.chat({
        taskType: 'reason',
        messages: [{ role: 'user', content: 'Email sarah@example.com' }],
      });
      expect(response.content).toContain('sarah@example.com');
      expect(response.content).not.toMatch(/\[EMAIL_1\]/);
    });

    it('rehydrates tokens inside tool-call arguments (agentic path)', async () => {
      const stub = makeStubProvider({
        content: '',
        toolCalls: [
          {
            id: 'call_0',
            name: 'vault_search',
            arguments: { query: '[EMAIL_1] birthday' },
          },
        ],
        finishReason: 'tool_use',
      });
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      const response = await router.chat({
        taskType: 'reason',
        messages: [{ role: 'user', content: 'when is sarah@example.com birthday' }],
      });
      expect(response.toolCalls[0]!.arguments.query).toBe('sarah@example.com birthday');
    });

    it('passes through when the local path is active (no scrub)', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { local: stub.provider },
        config: {
          localAvailable: true,
          cloudProviders: [],
          sensitivePersonas: [],
          cloudConsentGranted: false,
        },
      });
      await router.chat({
        taskType: 'reason',
        messages: [{ role: 'user', content: 'sarah@example.com' }],
      });
      expect(stub.lastMessages()?.[0].content).toBe('sarah@example.com');
    });
  });

  describe('cloud-consent gate', () => {
    it('throws CloudConsentError on sensitive persona → cloud without consent', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: ['health', 'financial'],
          cloudConsentGranted: false,
        },
      });
      await expect(
        router.chat({
          taskType: 'reason',
          persona: 'health',
          messages: [{ role: 'user', content: 'medical query' }],
        }),
      ).rejects.toBeInstanceOf(CloudConsentError);
    });

    it('allows sensitive persona → cloud when consent is granted', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: ['health'],
          cloudConsentGranted: true,
        },
      });
      await expect(
        router.chat({
          taskType: 'reason',
          persona: 'health',
          messages: [{ role: 'user', content: 'medical query' }],
        }),
      ).resolves.toMatchObject({ content: 'ok' });
    });

    it('never gates non-sensitive personas', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: ['health'],
          cloudConsentGranted: false,
        },
      });
      await expect(
        router.chat({
          taskType: 'reason',
          persona: 'general',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).resolves.toMatchObject({ content: 'ok' });
    });
  });

  describe('misconfiguration', () => {
    it('throws when the selected provider has no instance', async () => {
      const router = new LLMRouter({
        providers: {},
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await expect(
        router.chat({
          taskType: 'classify',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(/no instance registered/);
    });

    it('rejects FTS-only tasks (they should never reach the LLM layer)', async () => {
      const stub = makeStubProvider();
      const router = new LLMRouter({
        providers: { gemini: stub.provider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: [],
          cloudConsentGranted: true,
        },
      });
      await expect(
        router.chat({
          taskType: 'fts_lookup',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(/FTS-only/);
    });
  });
});

describe('RoutedLLMProvider (LLMProvider adapter)', () => {
  it('forwards every chat() call to the router with the bound taskType', async () => {
    const stub = makeStubProvider();
    const router = new LLMRouter({
      providers: { gemini: stub.provider },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: [],
        cloudConsentGranted: true,
      },
    });
    const routed = new RoutedLLMProvider({ router, taskType: 'classify' });
    await routed.chat([{ role: 'user', content: 'hi' }]);
    expect(stub.lastOptions()?.model).toBe('gemini-3.1-flash-lite-preview');
  });

  it('threads ChatOptions.model through as modelOverride', async () => {
    const stub = makeStubProvider();
    const router = new LLMRouter({
      providers: { gemini: stub.provider },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: [],
        cloudConsentGranted: true,
      },
    });
    const routed = new RoutedLLMProvider({ router, taskType: 'classify' });
    await routed.chat([{ role: 'user', content: 'hi' }], {
      model: 'gemini-3.1-pro-preview',
    });
    expect(stub.lastOptions()?.model).toBe('gemini-3.1-pro-preview');
  });

  it('resolves persona via getter so the consent gate sees live state', async () => {
    const stub = makeStubProvider();
    const router = new LLMRouter({
      providers: { gemini: stub.provider },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: ['health'],
        cloudConsentGranted: false,
      },
    });
    let currentPersona: string | undefined = 'general';
    const routed = new RoutedLLMProvider({
      router,
      taskType: 'reason',
      persona: () => currentPersona,
    });
    // First call — persona is general, non-sensitive → passes.
    await expect(
      routed.chat([{ role: 'user', content: 'hi' }]),
    ).resolves.toMatchObject({ content: 'ok' });

    // Flip the getter; consent gate should now fire.
    currentPersona = 'health';
    await expect(
      routed.chat([{ role: 'user', content: 'medical' }]),
    ).rejects.toBeInstanceOf(CloudConsentError);
  });
});

describe('rehydrateResponse', () => {
  it('rehydrates tokens inside nested tool-call argument arrays + objects', () => {
    const entities = [
      { token: '[EMAIL_1]', value: 'a@b.com' },
      { token: '[PHONE_1]', value: '555-1234' },
    ];
    const response: ChatResponse = {
      content: 'Sending to [EMAIL_1]',
      toolCalls: [
        {
          id: 'call_0',
          name: 'compose',
          arguments: {
            to: '[EMAIL_1]',
            backup: ['[EMAIL_1]', 'plain@example.com'],
            meta: { phone: '[PHONE_1]' },
          },
        },
      ],
      model: 'stub',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'tool_use',
    };
    const out = rehydrateResponse(response, entities);
    expect(out.content).toBe('Sending to a@b.com');
    expect(out.toolCalls[0]!.arguments.to).toBe('a@b.com');
    expect((out.toolCalls[0]!.arguments.backup as string[])[0]).toBe('a@b.com');
    expect((out.toolCalls[0]!.arguments.meta as { phone: string }).phone).toBe('555-1234');
  });
});
