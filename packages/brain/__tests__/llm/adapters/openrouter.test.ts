/**
 * T3.6 — OpenRouter LLM adapter: chat via OpenAI-compatible API.
 *
 * Tests use a mock fetch — no real API calls.
 *
 * Source: ARCHITECTURE.md Task 3.6
 */

import { OpenRouterAdapter, type OpenRouterConfig } from '../../../src/llm/adapters/openrouter';
import type { StreamChunk, ToolDefinition } from '../../../src/llm/adapters/provider';

/** Create a mock fetch that returns a canned JSON response. */
function createMockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const mockFetch = async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    calls.push({ url: url as string, init: init! });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as globalThis.Response;
  };

  return { mockFetch, calls };
}

function makeConfig(mockFetch: any, model?: string): OpenRouterConfig {
  return {
    apiKey: 'sk-or-test-key-123456',
    defaultModel: model ?? 'auto',
    fetch: mockFetch,
  };
}

const TEXT_RESPONSE = {
  id: 'gen-001',
  model: 'openai/gpt-4o',
  choices: [
    {
      message: { role: 'assistant', content: 'Hello from OpenRouter!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
};

const TOOL_RESPONSE = {
  id: 'gen-002',
  model: 'anthropic/claude-sonnet-4-6',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'vault_search', arguments: '{"query":"test"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
};

describe('OpenRouterAdapter', () => {
  describe('chat', () => {
    it('returns text content from response', async () => {
      const { mockFetch } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      const result = await adapter.chat([{ role: 'user', content: 'Hello' }]);

      expect(result.content).toBe('Hello from OpenRouter!');
      expect(result.model).toBe('openai/gpt-4o');
      expect(result.finishReason).toBe('end');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(5);
    });

    it('extracts tool calls', async () => {
      const { mockFetch } = createMockFetch(TOOL_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      const result = await adapter.chat([{ role: 'user', content: 'Search' }]);

      expect(result.finishReason).toBe('tool_use');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('vault_search');
      expect(result.toolCalls[0].arguments).toEqual({ query: 'test' });
    });

    it('sends correct auth headers', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-or-test-key-123456');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['HTTP-Referer']).toBe('https://dinakernel.com');
      expect(headers['X-Title']).toBe('Dina');
    });

    it('posts to correct URL', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('passes system prompt as first message', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Hello' }], { systemPrompt: 'You are helpful' });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('passes tools in OpenAI function format', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      const tools: ToolDefinition[] = [
        {
          name: 'search',
          description: 'Search',
          parameters: { type: 'object' },
        },
      ];

      await adapter.chat([{ role: 'user', content: 'test' }], { tools });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].function.name).toBe('search');
    });

    it('passes response_format when responseSchema is provided', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Classify this' }], {
        responseSchema: {
          type: 'object',
          properties: { persona: { type: 'string' } },
        },
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('does NOT set response_format when no schema provided', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Hello' }]);

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.response_format).toBeUndefined();
    });

    it('uses custom model', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch, 'anthropic/claude-sonnet-4-6'));

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.model).toBe('anthropic/claude-sonnet-4-6');
    });

    it('overrides model per-request', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await adapter.chat([{ role: 'user', content: 'Hi' }], { model: 'google/gemini-2.5-flash' });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.model).toBe('google/gemini-2.5-flash');
    });

    it('throws on HTTP error', async () => {
      const { mockFetch } = createMockFetch({ error: 'Rate limited' }, 429);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await expect(adapter.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        'OpenRouter HTTP 429',
      );
    });

    it('handles empty choices gracefully', async () => {
      const { mockFetch } = createMockFetch({
        ...TEXT_RESPONSE,
        choices: [],
      });
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      const result = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(result.content).toBe('');
      expect(result.finishReason).toBe('error');
    });

    it('uses custom base URL', async () => {
      const { mockFetch, calls } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter({
        apiKey: 'sk-or-test',
        baseURL: 'https://custom.api.com/v1',
        fetch: mockFetch as any,
      });

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      expect(calls[0].url).toBe('https://custom.api.com/v1/chat/completions');
    });
  });

  describe('stream', () => {
    it('yields text and done chunks', async () => {
      const { mockFetch } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Hi' }])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'text', text: 'Hello from OpenRouter!' });
      expect(chunks[1]).toEqual({ type: 'done' });
    });
  });

  describe('embed', () => {
    it('throws — OpenRouter does not support embeddings', async () => {
      const { mockFetch } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      await expect(adapter.embed('test')).rejects.toThrow('does not support embeddings');
    });
  });

  describe('properties', () => {
    it('reports correct capabilities', () => {
      const { mockFetch } = createMockFetch(TEXT_RESPONSE);
      const adapter = new OpenRouterAdapter(makeConfig(mockFetch));

      expect(adapter.name).toBe('openrouter');
      expect(adapter.supportsStreaming).toBe(true);
      expect(adapter.supportsToolCalling).toBe(true);
      expect(adapter.supportsEmbedding).toBe(false);
    });
  });
});
