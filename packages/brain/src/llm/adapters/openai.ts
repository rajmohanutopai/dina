/**
 * OpenAI LLM adapter — wraps OpenAI SDK.
 *
 * Features:
 *   - Chat completion with system prompt support
 *   - Streaming with text chunks
 *   - Tool calling (function calling)
 *   - Embedding via text-embedding-3-small (768 dimensions)
 *
 * The adapter is designed for injectable SDK client — in production,
 * the real openai SDK is injected; in tests, a mock is used.
 *
 * Source: ARCHITECTURE.md Task 3.4
 */

import type {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  StreamChunk,
  ChatOptions,
  EmbedOptions,
  EmbedResponse,
  ToolDefinition,
  ToolCall,
} from './provider';

/**
 * Minimal subset of the OpenAI SDK client interface.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(params: OpenAIChatParams): Promise<OpenAIChatResponse>;
    };
  };
  embeddings: {
    create(params: OpenAIEmbedParams): Promise<OpenAIEmbedResponse>;
  };
}

export interface OpenAIChatParams {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }>;
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  stream?: boolean;
  /** Structured output: { type: "json_object" } forces valid JSON responses. */
  response_format?: { type: 'json_object' | 'text' };
}

export interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIEmbedParams {
  model: string;
  input: string;
  dimensions?: number;
}

export interface OpenAIEmbedResponse {
  model: string;
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_EMBED_MODEL as EMBED_MODEL,
  DEFAULT_MAX_TOKENS as MAX_TOKENS,
} from '../../constants';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../../../../core/src/constants';
import { safeCall } from './safety';

const DEFAULT_CHAT_MODEL = DEFAULT_OPENAI_MODEL;
const DEFAULT_EMBED_MODEL = EMBED_MODEL;
const DEFAULT_MAX_TOKENS = MAX_TOKENS;
const DEFAULT_EMBED_DIMENSIONS = DEFAULT_EMBEDDING_DIMENSIONS;

export class OpenAIAdapter implements LLMProvider {
  readonly name = 'openai';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = true;

  private readonly client: OpenAIClient;
  private readonly defaultModel: string;
  private readonly defaultEmbedModel: string;

  constructor(client: OpenAIClient, defaultModel?: string, defaultEmbedModel?: string) {
    this.client = client;
    this.defaultModel = defaultModel ?? DEFAULT_CHAT_MODEL;
    this.defaultEmbedModel = defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Build messages array (OpenAI supports system role natively).
    // Tool-role messages become `role: 'tool'` entries with `tool_call_id`.
    // Assistant messages with prior toolCalls carry a `tool_calls` field so
    // OpenAI sees the prior invocation before the tool response.
    const apiMessages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }> = [];

    if (options?.systemPrompt) {
      apiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'tool') {
        apiMessages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        apiMessages.push({
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
        continue;
      }
      apiMessages.push({ role: m.role, content: m.content });
    }

    const params: OpenAIChatParams = {
      model,
      messages: apiMessages,
      max_tokens: maxTokens,
      temperature: options?.temperature,
      // Structured JSON output: when a responseSchema is provided, instruct
      // OpenAI to return valid JSON (response_format: { type: "json_object" }).
      ...(options?.responseSchema ? { response_format: { type: 'json_object' as const } } : {}),
    };

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await safeCall(() => this.client.chat.completions.create(params));

    return mapChatResponse(response);
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    // Non-streaming fallback: call chat and yield the full result
    const response = await this.chat(messages, options);

    if (response.content) {
      yield { type: 'text', text: response.content };
    }

    for (const tc of response.toolCalls) {
      yield { type: 'tool_use', toolCall: tc };
    }

    yield { type: 'done' };
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbedResponse> {
    const model = options?.model ?? this.defaultEmbedModel;
    const dimensions = options?.dimensions ?? DEFAULT_EMBED_DIMENSIONS;

    const response = await safeCall(() =>
      this.client.embeddings.create({
        model,
        input: text,
        dimensions,
      }),
    );

    if (!response.data || response.data.length === 0) {
      throw new Error('OpenAI embedding returned no data');
    }

    const raw = response.data[0].embedding;
    const embedding = new Float64Array(raw);

    return {
      embedding,
      model: response.model,
      dimensions: raw.length,
    };
  }
}

function mapChatResponse(response: OpenAIChatResponse): ChatResponse {
  const choice = response.choices[0];
  if (!choice) {
    return {
      content: '',
      toolCalls: [],
      model: response.model,
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
      finishReason: 'error',
    };
  }

  const content = choice.message.content ?? '';
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJSON(tc.function.arguments),
  }));

  const finishReason =
    choice.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end';

  return {
    content,
    toolCalls,
    model: response.model,
    usage: {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    },
    finishReason,
  };
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

/**
 * Create an OpenAI adapter from an API key.
 *
 * In production, this imports and instantiates the real OpenAI SDK.
 * For testing, use the constructor directly with a mock client.
 */
export function createOpenAIAdapter(apiKey: string, model?: string): OpenAIAdapter {
  const { default: OpenAI } = require('openai');
  const client = new OpenAI({ apiKey });
  return new OpenAIAdapter(client, model);
}
