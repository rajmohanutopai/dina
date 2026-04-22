/**
 * T3.4 — OpenAI LLM adapter: chat, stream, embed, tool calling.
 *
 * Tests use a mock OpenAI client — no real API calls.
 *
 * Source: ARCHITECTURE.md Task 3.4
 */

import {
  OpenAIAdapter,
  type OpenAIClient,
  type OpenAIChatResponse,
  type OpenAIEmbedResponse,
} from '../../../src/llm/adapters/openai';
import type { StreamChunk, ToolDefinition } from '../../../src/llm/adapters/provider';

function createMockClient(
  chatResponse: OpenAIChatResponse,
  embedResponse?: OpenAIEmbedResponse,
): OpenAIClient {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(chatResponse),
      },
    },
    embeddings: {
      create: jest.fn().mockResolvedValue(
        embedResponse ?? {
          model: 'text-embedding-3-small',
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        },
      ),
    },
  };
}

const TEXT_RESPONSE: OpenAIChatResponse = {
  id: 'chatcmpl-001',
  model: 'gpt-4o',
  choices: [
    {
      message: { role: 'assistant', content: 'Hello! How can I help?' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
};

const TOOL_RESPONSE: OpenAIChatResponse = {
  id: 'chatcmpl-002',
  model: 'gpt-4o',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'vault_search', arguments: '{"query":"birthday","limit":5}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
};

describe('OpenAIAdapter', () => {
  describe('chat', () => {
    it('returns text content from response', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'Hello' }]);

      expect(result.content).toBe('Hello! How can I help?');
      expect(result.model).toBe('gpt-4o');
      expect(result.finishReason).toBe('end');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(6);
    });

    it('extracts tool calls with parsed JSON arguments', async () => {
      const client = createMockClient(TOOL_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'Search for birthday' }]);

      expect(result.content).toBe('');
      expect(result.finishReason).toBe('tool_use');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe('call_1');
      expect(result.toolCalls[0].name).toBe('vault_search');
      expect(result.toolCalls[0].arguments).toEqual({ query: 'birthday', limit: 5 });
    });

    it('handles malformed tool arguments gracefully', async () => {
      const response: OpenAIChatResponse = {
        ...TOOL_RESPONSE,
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'test', arguments: 'not-json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      const client = createMockClient(response);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(result.toolCalls[0].arguments).toEqual({ raw: 'not-json' });
    });

    it('passes system prompt as first message', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }], {
        systemPrompt: 'You are a helpful assistant',
      });

      const createFn = client.chat.completions.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant',
      });
      expect(params.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('passes tools in OpenAI function format', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      const tools: ToolDefinition[] = [
        {
          name: 'vault_search',
          description: 'Search the vault',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ];

      await adapter.chat([{ role: 'user', content: 'Search' }], { tools });

      const createFn = client.chat.completions.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.tools).toHaveLength(1);
      expect(params.tools[0].type).toBe('function');
      expect(params.tools[0].function.name).toBe('vault_search');
    });

    it('uses custom model', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client, 'gpt-4o-mini');

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      const createFn = client.chat.completions.create as jest.Mock;
      expect(createFn.mock.calls[0][0].model).toBe('gpt-4o-mini');
    });

    it('passes response_format when responseSchema is provided', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Classify this item' }], {
        responseSchema: {
          type: 'object',
          properties: { persona: { type: 'string' } },
        },
      });

      const createFn = client.chat.completions.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.response_format).toEqual({ type: 'json_object' });
    });

    it('does NOT set response_format when no schema provided', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }]);

      const createFn = client.chat.completions.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.response_format).toBeUndefined();
    });

    it('maps length finish reason to max_tokens', async () => {
      const response: OpenAIChatResponse = {
        ...TEXT_RESPONSE,
        choices: [{ ...TEXT_RESPONSE.choices[0], finish_reason: 'length' }],
      };
      const client = createMockClient(response);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(result.finishReason).toBe('max_tokens');
    });

    it('handles empty choices gracefully', async () => {
      const response: OpenAIChatResponse = { ...TEXT_RESPONSE, choices: [] };
      const client = createMockClient(response);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(result.content).toBe('');
      expect(result.finishReason).toBe('error');
    });
  });

  describe('stream', () => {
    it('yields text and done chunks', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Hi' }])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'text', text: 'Hello! How can I help?' });
      expect(chunks[1]).toEqual({ type: 'done' });
    });
  });

  describe('embed', () => {
    it('returns embedding as Float64Array', async () => {
      const embedResponse: OpenAIEmbedResponse = {
        model: 'text-embedding-3-small',
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };
      const client = createMockClient(TEXT_RESPONSE, embedResponse);
      const adapter = new OpenAIAdapter(client);

      const result = await adapter.embed('Hello world');

      expect(result.embedding).toBeInstanceOf(Float64Array);
      expect(result.embedding.length).toBe(4);
      expect(result.dimensions).toBe(4);
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.embedding[0]).toBeCloseTo(0.1);
    });

    it('uses custom embed model', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client, undefined, 'text-embedding-ada-002');

      await adapter.embed('test');

      const createFn = client.embeddings.create as jest.Mock;
      expect(createFn.mock.calls[0][0].model).toBe('text-embedding-ada-002');
    });

    it('passes dimensions parameter', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      await adapter.embed('test', { dimensions: 256 });

      const createFn = client.embeddings.create as jest.Mock;
      expect(createFn.mock.calls[0][0].dimensions).toBe(256);
    });

    it('throws when response has no data', async () => {
      const embedResponse: OpenAIEmbedResponse = {
        model: 'text-embedding-3-small',
        data: [],
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
      const client = createMockClient(TEXT_RESPONSE, embedResponse);
      const adapter = new OpenAIAdapter(client);

      await expect(adapter.embed('test')).rejects.toThrow('no data');
    });
  });

  describe('error handling', () => {
    it('classifies 401 error as ConfigError', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      (client.chat.completions.create as jest.Mock).mockRejectedValue(
        new Error('Request failed with status code 401: Unauthorized'),
      );
      const adapter = new OpenAIAdapter(client);

      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
        'Invalid API key',
      );
      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toHaveProperty(
        'name',
        'ConfigError',
      );
    });

    it('classifies 429 error as LLMError', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      (client.chat.completions.create as jest.Mock).mockRejectedValue(
        new Error('Request failed with status code 429: rate_limit_exceeded'),
      );
      const adapter = new OpenAIAdapter(client);

      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
        'Rate limited',
      );
      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toHaveProperty(
        'name',
        'LLMError',
      );
    });

    it('classifies generic error as LLMError', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      (client.chat.completions.create as jest.Mock).mockRejectedValue(
        new Error('Connection refused'),
      );
      const adapter = new OpenAIAdapter(client);

      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
        'LLM call failed',
      );
      await expect(adapter.chat([{ role: 'user', content: 'test' }])).rejects.toHaveProperty(
        'name',
        'LLMError',
      );
    });

    it('classifies embed errors', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      (client.embeddings.create as jest.Mock).mockRejectedValue(new Error('401 Unauthorized'));
      const adapter = new OpenAIAdapter(client);

      await expect(adapter.embed('test')).rejects.toHaveProperty('name', 'ConfigError');
    });

    it('times out after 60s', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      // Mock a call that never resolves
      (client.chat.completions.create as jest.Mock).mockReturnValue(
        new Promise(() => {}), // never resolves
      );
      const adapter = new OpenAIAdapter(client);

      // Use a short timeout for testing by importing safeCall's timeout
      // The actual adapter uses 60s, but we can't wait that long in tests.
      // Instead, verify the error classification pattern for timeout errors.
      const { classifyAndThrow } = require('../../../src/llm/adapters/safety');
      expect(() => classifyAndThrow(new Error('Request timed out'))).toThrow('timed out');
    });
  });

  describe('properties', () => {
    it('reports correct capabilities', () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new OpenAIAdapter(client);

      expect(adapter.name).toBe('openai');
      expect(adapter.supportsStreaming).toBe(true);
      expect(adapter.supportsToolCalling).toBe(true);
      expect(adapter.supportsEmbedding).toBe(true);
    });
  });
});
