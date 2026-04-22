/**
 * Task 5.22 — LLM provider adapter + registry tests.
 */

import {
  LlmProviderRegistry,
  ProviderNotFoundError,
  ScriptedLlmProvider,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type LlmProviderAdapter,
  type LlmProviderEvent,
} from '../src/brain/llm_provider';

function baseChat(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'stub-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('ScriptedLlmProvider (task 5.22)', () => {
  it('throws without id', () => {
    expect(
      () => new ScriptedLlmProvider({ id: '' }),
    ).toThrow(/id/);
  });

  it('default chatHandler returns empty content', async () => {
    const p = new ScriptedLlmProvider({ id: 'stub' });
    const r = await p.chat(baseChat());
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('end');
    expect(r.toolCalls).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('default embedHandler returns zeros at 768 dims', async () => {
    const p = new ScriptedLlmProvider({ id: 'stub' });
    const r = await p.embed({ model: 'm', text: 'x' });
    expect(r.dimensions).toBe(768);
    expect(r.embedding).toHaveLength(768);
    expect(r.embedding.every((v) => v === 0)).toBe(true);
  });

  it('custom defaultDimensions honoured', async () => {
    const p = new ScriptedLlmProvider({ id: 'stub', defaultDimensions: 32 });
    const r = await p.embed({ model: 'm', text: 'x' });
    expect(r.dimensions).toBe(32);
  });

  it('chatHandler + embedHandler can be supplied', async () => {
    const p = new ScriptedLlmProvider({
      id: 'stub',
      chatHandler: (req) => ({
        content: `echo: ${req.messages[0]?.content}`,
        toolCalls: [],
        model: req.model,
        usage: { inputTokens: 1, outputTokens: 2 },
        finishReason: 'end',
      }),
      embedHandler: () => ({
        embedding: [1, 2, 3],
        model: 'e',
        dimensions: 3,
      }),
    });
    expect((await p.chat(baseChat())).content).toBe('echo: hi');
    expect((await p.embed({ model: 'e', text: 'x' })).embedding).toEqual([1, 2, 3]);
  });

  it('isLocal defaults to false + can be overridden', () => {
    expect(new ScriptedLlmProvider({ id: 'cloud' }).isLocal).toBe(false);
    expect(new ScriptedLlmProvider({ id: 'local', isLocal: true }).isLocal).toBe(true);
  });

  it('displayName defaults to id', () => {
    expect(new ScriptedLlmProvider({ id: 'my-provider' }).displayName).toBe('my-provider');
    expect(
      new ScriptedLlmProvider({ id: 'x', displayName: 'Pretty Name' }).displayName,
    ).toBe('Pretty Name');
  });
});

describe('LlmProviderRegistry (task 5.22)', () => {
  describe('register / unregister / has / size', () => {
    it('registers + reports has/size', () => {
      const reg = new LlmProviderRegistry();
      expect(reg.size()).toBe(0);
      reg.register(new ScriptedLlmProvider({ id: 'anthropic' }));
      reg.register(new ScriptedLlmProvider({ id: 'gemini' }));
      expect(reg.size()).toBe(2);
      expect(reg.has('anthropic')).toBe(true);
      expect(reg.has('missing')).toBe(false);
    });

    it('rejects duplicate id', () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      expect(() =>
        reg.register(new ScriptedLlmProvider({ id: 'x' })),
      ).toThrow(/already registered/);
    });

    it('rejects malformed adapter', () => {
      const reg = new LlmProviderRegistry();
      expect(() => reg.register(null as unknown as LlmProviderAdapter)).toThrow();
      expect(() =>
        reg.register({ id: '' } as unknown as LlmProviderAdapter),
      ).toThrow(/id/);
    });

    it('unregister removes + returns true; false for unknown', () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      expect(reg.unregister('x')).toBe(true);
      expect(reg.unregister('x')).toBe(false);
      expect(reg.has('x')).toBe(false);
    });

    it('fires registered + unregistered events', () => {
      const events: LlmProviderEvent[] = [];
      const reg = new LlmProviderRegistry({ onEvent: (e) => events.push(e) });
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      reg.unregister('x');
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['registered', 'unregistered']);
    });
  });

  describe('get / list', () => {
    it('get returns the adapter or null', () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      expect(reg.get('x')?.id).toBe('x');
      expect(reg.get('missing')).toBeNull();
    });

    it('list returns sorted info tuples', () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'zeta' }));
      reg.register(new ScriptedLlmProvider({ id: 'alpha', isLocal: true }));
      reg.register(new ScriptedLlmProvider({ id: 'beta', displayName: 'Beta Prov' }));
      expect(reg.list()).toEqual([
        { id: 'alpha', displayName: 'alpha', isLocal: true },
        { id: 'beta', displayName: 'Beta Prov', isLocal: false },
        { id: 'zeta', displayName: 'zeta', isLocal: false },
      ]);
    });
  });

  describe('chat + embed dispatch', () => {
    it('dispatches chat + bumps stats', async () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      await reg.chat('x', baseChat());
      expect(reg.statsFor('x')).toEqual({
        chatCalls: 1,
        chatFailures: 0,
        embedCalls: 0,
        embedFailures: 0,
      });
    });

    it('dispatches embed + bumps stats', async () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      await reg.embed('x', { model: 'm', text: 't' });
      expect(reg.statsFor('x')?.embedCalls).toBe(1);
    });

    it('unknown id throws ProviderNotFoundError', async () => {
      const reg = new LlmProviderRegistry();
      await expect(reg.chat('missing', baseChat())).rejects.toBeInstanceOf(
        ProviderNotFoundError,
      );
    });

    it('adapter throw bumps failure stats + re-throws', async () => {
      const reg = new LlmProviderRegistry();
      const chatHandler = (_req: ChatRequest): Promise<ChatResponse> => {
        throw new Error('provider exploded');
      };
      reg.register(new ScriptedLlmProvider({ id: 'bad', chatHandler }));
      await expect(reg.chat('bad', baseChat())).rejects.toThrow(/provider exploded/);
      expect(reg.statsFor('bad')?.chatFailures).toBe(1);
      expect(reg.statsFor('bad')?.chatCalls).toBe(0);
    });

    it('embed adapter throw bumps embedFailures', async () => {
      const reg = new LlmProviderRegistry();
      const embedHandler = (_req: EmbedRequest): Promise<EmbedResponse> => {
        throw new Error('embed down');
      };
      reg.register(new ScriptedLlmProvider({ id: 'bad', embedHandler }));
      await expect(
        reg.embed('bad', { model: 'x', text: 'y' }),
      ).rejects.toThrow(/embed down/);
      expect(reg.statsFor('bad')?.embedFailures).toBe(1);
    });
  });

  describe('events', () => {
    it('fires chat_started + chat_ok', async () => {
      const events: LlmProviderEvent[] = [];
      const reg = new LlmProviderRegistry({ onEvent: (e) => events.push(e) });
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      await reg.chat('x', { ...baseChat(), requestId: 'req-1' });
      const chatEvents = events.filter((e) => e.kind.startsWith('chat_'));
      expect(chatEvents.map((e) => e.kind)).toEqual(['chat_started', 'chat_ok']);
    });

    it('fires chat_failed on throw', async () => {
      const events: LlmProviderEvent[] = [];
      const reg = new LlmProviderRegistry({ onEvent: (e) => events.push(e) });
      reg.register(
        new ScriptedLlmProvider({
          id: 'bad',
          chatHandler: () => {
            throw new Error('oh no');
          },
        }),
      );
      await reg.chat('bad', baseChat()).catch(() => {});
      const failed = events.find((e) => e.kind === 'chat_failed') as Extract<
        LlmProviderEvent,
        { kind: 'chat_failed' }
      >;
      expect(failed.error).toMatch(/oh no/);
      expect(failed.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('embed events fire parallel shape', async () => {
      const events: LlmProviderEvent[] = [];
      const reg = new LlmProviderRegistry({ onEvent: (e) => events.push(e) });
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      await reg.embed('x', { model: 'm', text: 't', requestId: 'req-e' });
      const kinds = events.filter((e) => e.kind.startsWith('embed_')).map((e) => e.kind);
      expect(kinds).toEqual(['embed_started', 'embed_ok']);
    });
  });

  describe('stats isolation', () => {
    it('statsFor returns copies — mutation doesn\'t leak', async () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      await reg.chat('x', baseChat());
      const s = reg.statsFor('x');
      if (s) s.chatCalls = 999;
      expect(reg.statsFor('x')?.chatCalls).toBe(1);
    });

    it('statsFor for unknown id → null', () => {
      const reg = new LlmProviderRegistry();
      expect(reg.statsFor('missing')).toBeNull();
    });

    it('allStats returns all provider stats', async () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'x' }));
      reg.register(new ScriptedLlmProvider({ id: 'y' }));
      await reg.chat('x', baseChat());
      const all = reg.allStats();
      expect(all.x?.chatCalls).toBe(1);
      expect(all.y?.chatCalls).toBe(0);
    });
  });

  describe('realistic multi-provider setup', () => {
    it('local + cloud side by side', async () => {
      const reg = new LlmProviderRegistry();
      reg.register(new ScriptedLlmProvider({ id: 'local', isLocal: true }));
      reg.register(new ScriptedLlmProvider({ id: 'anthropic' }));
      reg.register(new ScriptedLlmProvider({ id: 'gemini' }));
      const locals = reg.list().filter((p) => p.isLocal);
      const clouds = reg.list().filter((p) => !p.isLocal);
      expect(locals.map((p) => p.id)).toEqual(['local']);
      expect(clouds.map((p) => p.id)).toEqual(['anthropic', 'gemini']);
    });
  });
});
