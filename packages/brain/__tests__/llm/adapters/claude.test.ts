/**
 * T3.3 — Claude LLM adapter: chat, stream, tool calling.
 *
 * Tests use a mock Anthropic client — no real API calls.
 *
 * Source: ARCHITECTURE.md Task 3.3
 */

import {
  ClaudeAdapter,
  type AnthropicClient,
  type AnthropicMessageResponse,
} from '../../../src/llm/adapters/claude';
import type { ChatMessage, StreamChunk, ToolDefinition } from '../../../src/llm/adapters/provider';

function createMockClient(response: AnthropicMessageResponse): AnthropicClient {
  return {
    messages: {
      create: jest.fn().mockResolvedValue(response),
    },
  };
}

const TEXT_RESPONSE: AnthropicMessageResponse = {
  id: 'msg_001',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'The answer is 42.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const TOOL_RESPONSE: AnthropicMessageResponse = {
  id: 'msg_002',
  model: 'claude-sonnet-4-6',
  content: [
    { type: 'text', text: 'Let me search for that.' },
    {
      type: 'tool_use',
      id: 'call_1',
      name: 'vault_search',
      input: { query: 'birthday', limit: 5 },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 15, output_tokens: 20 },
};

describe('ClaudeAdapter', () => {
  describe('chat', () => {
    it('returns text content from response', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      const result = await adapter.chat([
        { role: 'user', content: 'What is the meaning of life?' },
      ]);

      expect(result.content).toBe('The answer is 42.');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.finishReason).toBe('end');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it('extracts tool calls from response', async () => {
      const client = createMockClient(TOOL_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: "When is Emma's birthday?" }]);

      expect(result.content).toBe('Let me search for that.');
      expect(result.finishReason).toBe('tool_use');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('vault_search');
      expect(result.toolCalls[0].arguments).toEqual({ query: 'birthday', limit: 5 });
    });

    it('passes system prompt as separate param', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }], {
        systemPrompt: 'You are a helpful assistant',
      });

      const createFn = client.messages.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.system).toBe('You are a helpful assistant');
      expect(params.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('filters system messages from conversation array', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      await adapter.chat([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ]);

      const createFn = client.messages.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      // System message extracted from array becomes system param
      expect(params.system).toBe('You are helpful');
      expect(params.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('passes tools in Anthropic format', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      const tools: ToolDefinition[] = [
        {
          name: 'vault_search',
          description: 'Search the vault',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ];

      await adapter.chat([{ role: 'user', content: 'Search' }], { tools });

      const createFn = client.messages.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      expect(params.tools).toHaveLength(1);
      expect(params.tools[0].name).toBe('vault_search');
      expect(params.tools[0].input_schema).toBeTruthy();
    });

    it('uses custom model when specified', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client, 'claude-haiku-4-5');

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      const createFn = client.messages.create as jest.Mock;
      expect(createFn.mock.calls[0][0].model).toBe('claude-haiku-4-5');
    });

    it('overrides model per-request', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hi' }], { model: 'claude-opus-4-6' });

      const createFn = client.messages.create as jest.Mock;
      expect(createFn.mock.calls[0][0].model).toBe('claude-opus-4-6');
    });

    it('uses prefilled assistant message for structured output', async () => {
      // Claude returns JSON without the leading '{' since we prefilled it
      const jsonResponse: AnthropicMessageResponse = {
        id: 'msg_json',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'text',
            text: '"persona": "health", "confidence": 0.9, "reason": "Medical content"}',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 20 },
      };
      const client = createMockClient(jsonResponse);
      const adapter = new ClaudeAdapter(client);

      const result = await adapter.chat(
        [{ role: 'user', content: 'Classify this medical report' }],
        {
          responseSchema: {
            type: 'object',
            properties: { persona: { type: 'string' } },
          },
        },
      );

      // Should prepend '{' back to form valid JSON
      expect(result.content.charAt(0)).toBe('{');
      // Verify the API was called with prefilled assistant message
      const createFn = client.messages.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      const lastMsg = params.messages[params.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('{');
    });

    it('does NOT prefill when no responseSchema provided', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }]);

      const createFn = client.messages.create as jest.Mock;
      const params = createFn.mock.calls[0][0];
      // No assistant prefill message
      expect(params.messages.every((m: { role: string }) => m.role !== 'assistant')).toBe(true);
    });

    it('does NOT double-prepend { when response already starts with {', async () => {
      const jsonResponse: AnthropicMessageResponse = {
        id: 'msg_json2',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '{"persona": "health"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const client = createMockClient(jsonResponse);
      const adapter = new ClaudeAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'Classify' }], {
        responseSchema: { type: 'object' },
      });

      // Should NOT have '{{' at start
      expect(result.content.startsWith('{{')).toBe(false);
      expect(result.content.charAt(0)).toBe('{');
    });

    it('maps max_tokens stop reason', async () => {
      const response: AnthropicMessageResponse = {
        ...TEXT_RESPONSE,
        stop_reason: 'max_tokens',
      };
      const client = createMockClient(response);
      const adapter = new ClaudeAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(result.finishReason).toBe('max_tokens');
    });
  });

  describe('stream', () => {
    it('yields text and done chunks', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Hi' }])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'text', text: 'The answer is 42.' });
      expect(chunks[1]).toEqual({ type: 'done' });
    });

    it('yields tool_use chunks for tool responses', async () => {
      const client = createMockClient(TOOL_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Search' }])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3); // text + tool_use + done
      expect(chunks[0].type).toBe('text');
      expect(chunks[1].type).toBe('tool_use');
      expect(chunks[1].toolCall!.name).toBe('vault_search');
      expect(chunks[2].type).toBe('done');
    });
  });

  describe('embed', () => {
    it('throws — Claude does not support embeddings', async () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      await expect(adapter.embed('test')).rejects.toThrow('does not support embeddings');
    });
  });

  describe('properties', () => {
    it('reports correct capabilities', () => {
      const client = createMockClient(TEXT_RESPONSE);
      const adapter = new ClaudeAdapter(client);

      expect(adapter.name).toBe('claude');
      expect(adapter.supportsStreaming).toBe(true);
      expect(adapter.supportsToolCalling).toBe(true);
      expect(adapter.supportsEmbedding).toBe(false);
    });
  });
});
