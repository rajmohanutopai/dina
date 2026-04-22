/**
 * T3.5 — Gemini LLM adapter: chat, structured output, embed, tool calling.
 *
 * Tests use a mock Gemini client — no real API calls.
 *
 * Source: ARCHITECTURE.md Task 3.5
 */

import {
  GeminiAdapter,
  type GeminiClient,
  type GeminiModel,
  type GeminiResult,
  type GeminiEmbedResult,
} from '../../../src/llm/adapters/gemini';
import type { StreamChunk, ToolDefinition } from '../../../src/llm/adapters/provider';

function createMockModel(chatResult: GeminiResult, embedResult?: GeminiEmbedResult): GeminiModel {
  return {
    generateContent: jest.fn().mockResolvedValue(chatResult),
    embedContent: jest
      .fn()
      .mockResolvedValue(embedResult ?? { embedding: { values: [0.1, 0.2, 0.3] } }),
  };
}

function createMockClient(model: GeminiModel): GeminiClient & { lastModelParams?: any } {
  const client: any = {
    getGenerativeModel: jest.fn().mockReturnValue(model),
  };
  return client;
}

const TEXT_RESULT: GeminiResult = {
  response: {
    text: () => 'The answer is 42.',
    candidates: [
      {
        content: { parts: [{ text: 'The answer is 42.' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
};

const TOOL_RESULT: GeminiResult = {
  response: {
    text: () => '',
    candidates: [
      {
        content: {
          parts: [
            { text: 'Searching...', functionCall: undefined },
            {
              text: undefined,
              functionCall: { name: 'vault_search', args: { query: 'birthday' } },
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
  },
};

describe('GeminiAdapter', () => {
  describe('chat', () => {
    it('returns text content from response', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const result = await adapter.chat([
        { role: 'user', content: 'What is the meaning of life?' },
      ]);

      expect(result.content).toBe('The answer is 42.');
      expect(result.model).toBe('gemini-3.1-pro-preview');
      expect(result.finishReason).toBe('end');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it('extracts tool calls from response', async () => {
      const model = createMockModel(TOOL_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const result = await adapter.chat([{ role: 'user', content: 'Search for birthday' }]);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('vault_search');
      expect(result.toolCalls[0].arguments).toEqual({ query: 'birthday' });
      expect(result.finishReason).toBe('tool_use');
    });

    it('passes system instruction as top-level param', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }], {
        systemPrompt: 'You are a helpful assistant',
      });

      const getModel = client.getGenerativeModel as jest.Mock;
      expect(getModel.mock.calls[0][0].systemInstruction).toBe('You are a helpful assistant');
    });

    it('maps assistant role to model role', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      await adapter.chat([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ]);

      const genContent = model.generateContent as jest.Mock;
      const contents = genContent.mock.calls[0][0].contents;
      expect(contents[0].role).toBe('user');
      expect(contents[1].role).toBe('model');
      expect(contents[2].role).toBe('user');
    });

    it('filters system messages from contents array', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      await adapter.chat([
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ]);

      const genContent = model.generateContent as jest.Mock;
      const contents = genContent.mock.calls[0][0].contents;
      expect(contents).toHaveLength(1);
      expect(contents[0].role).toBe('user');
    });

    it('passes tools as functionDeclarations', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const tools: ToolDefinition[] = [
        {
          name: 'vault_search',
          description: 'Search the vault',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ];

      await adapter.chat([{ role: 'user', content: 'Search' }], { tools });

      const genContent = model.generateContent as jest.Mock;
      const toolsParam = genContent.mock.calls[0][0].tools;
      expect(toolsParam).toHaveLength(1);
      expect(toolsParam[0].functionDeclarations[0].name).toBe('vault_search');
    });

    it('uses custom model', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client, 'gemini-2.5-pro');

      await adapter.chat([{ role: 'user', content: 'Hi' }]);

      const getModel = client.getGenerativeModel as jest.Mock;
      expect(getModel.mock.calls[0][0].model).toBe('gemini-2.5-pro');
    });

    it('passes responseSchema in generationConfig', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const schema = {
        type: 'object',
        properties: { persona: { type: 'string' }, confidence: { type: 'number' } },
        required: ['persona', 'confidence'],
      };

      await adapter.chat([{ role: 'user', content: 'Classify this' }], { responseSchema: schema });

      const genContent = model.generateContent as jest.Mock;
      const config = genContent.mock.calls[0][0].generationConfig;
      expect(config.responseMimeType).toBe('application/json');
      expect(config.responseSchema).toEqual(schema);
    });

    it('does NOT set responseMimeType when no schema provided', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      await adapter.chat([{ role: 'user', content: 'Hello' }]);

      const genContent = model.generateContent as jest.Mock;
      const config = genContent.mock.calls[0][0].generationConfig;
      expect(config.responseMimeType).toBeUndefined();
      expect(config.responseSchema).toBeUndefined();
    });

    it('maps MAX_TOKENS finish reason', async () => {
      const result: GeminiResult = {
        response: {
          text: () => 'partial...',
          candidates: [
            {
              content: { parts: [{ text: 'partial...' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50, totalTokenCount: 60 },
        },
      };
      const model = createMockModel(result);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const res = await adapter.chat([{ role: 'user', content: 'test' }]);
      expect(res.finishReason).toBe('max_tokens');
    });
  });

  describe('stream', () => {
    it('yields text and done chunks', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Hi' }])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'text', text: 'The answer is 42.' });
      expect(chunks[1]).toEqual({ type: 'done' });
    });

    it('yields tool_use chunks', async () => {
      const model = createMockModel(TOOL_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream([{ role: 'user', content: 'Search' }])) {
        chunks.push(chunk);
      }

      const toolChunk = chunks.find((c) => c.type === 'tool_use');
      expect(toolChunk).toBeTruthy();
      expect(toolChunk!.toolCall!.name).toBe('vault_search');
    });
  });

  describe('embed', () => {
    it('returns embedding as Float64Array', async () => {
      const embedResult: GeminiEmbedResult = {
        embedding: { values: [0.1, 0.2, 0.3, 0.4, 0.5] },
      };
      const model = createMockModel(TEXT_RESULT, embedResult);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      const result = await adapter.embed('Hello world');

      expect(result.embedding).toBeInstanceOf(Float64Array);
      expect(result.embedding.length).toBe(5);
      expect(result.dimensions).toBe(5);
      expect(result.model).toBe('embedding-001');
      expect(result.embedding[0]).toBeCloseTo(0.1);
    });

    it('uses custom embed model', async () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client, undefined, 'text-embedding-004');

      await adapter.embed('test');

      const getModel = client.getGenerativeModel as jest.Mock;
      // Last call should be for the embed model
      const lastCall = getModel.mock.calls[getModel.mock.calls.length - 1];
      expect(lastCall[0].model).toBe('text-embedding-004');
    });

    it('throws when embedding has no values', async () => {
      const embedResult: GeminiEmbedResult = { embedding: { values: [] } };
      const model = createMockModel(TEXT_RESULT, embedResult);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      await expect(adapter.embed('test')).rejects.toThrow('no data');
    });
  });

  describe('properties', () => {
    it('reports correct capabilities', () => {
      const model = createMockModel(TEXT_RESULT);
      const client = createMockClient(model);
      const adapter = new GeminiAdapter(client);

      expect(adapter.name).toBe('gemini');
      expect(adapter.supportsStreaming).toBe(true);
      expect(adapter.supportsToolCalling).toBe(true);
      expect(adapter.supportsEmbedding).toBe(true);
    });
  });
});
