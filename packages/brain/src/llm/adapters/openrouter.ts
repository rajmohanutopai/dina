/**
 * OpenRouter LLM adapter — HTTP client wrapper.
 *
 * OpenRouter provides an OpenAI-compatible API that routes to many models
 * (Claude, GPT, Llama, Mixtral, etc.). It's the universal fallback provider.
 *
 * Features:
 *   - Chat completion via OpenAI-compatible endpoint
 *   - Streaming (via SSE, same as OpenAI format)
 *   - Tool calling (model-dependent)
 *   - No native embedding (use OpenAI or Gemini for embeddings)
 *   - Model routing: specify any model via "provider/model" format
 *
 * API: POST https://openrouter.ai/api/v1/chat/completions
 * Auth: Authorization: Bearer {API_KEY}
 * Headers: HTTP-Referer, X-Title for ranking
 *
 * Source: ARCHITECTURE.md Task 3.6
 */

import type {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  StreamChunk,
  ChatOptions,
  EmbedOptions,
  EmbedResponse,
  ToolCall,
} from './provider';

import {
  OPENROUTER_BASE_URL as OR_BASE,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_APP_NAME,
  OPENROUTER_APP_URL,
  DEFAULT_MAX_TOKENS as MAX_TOKENS,
} from '../../constants';
import { safeCall } from './safety';

const OPENROUTER_BASE_URL = OR_BASE;
const DEFAULT_MODEL = DEFAULT_OPENROUTER_MODEL;
const DEFAULT_MAX_TOKENS = MAX_TOKENS;

export interface OpenRouterConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  appName?: string;
  appURL?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Raw response from OpenRouter (OpenAI-compatible format).
 */
interface OpenRouterResponse {
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

export class OpenRouterAdapter implements LLMProvider {
  readonly name = 'openrouter';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly appName: string;
  private readonly appURL: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? OPENROUTER_BASE_URL).replace(/\/$/, '');
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.appName = config.appName ?? OPENROUTER_APP_NAME;
    this.appURL = config.appURL ?? OPENROUTER_APP_URL;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

    const apiMessages: Array<{ role: string; content: string }> = [];

    if (options?.systemPrompt) {
      apiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      max_tokens: maxTokens,
      temperature: options?.temperature,
      // Structured JSON output: OpenRouter uses the OpenAI-compatible response_format.
      // When a responseSchema is provided, request guaranteed JSON output.
      ...(options?.responseSchema ? { response_format: { type: 'json_object' } } : {}),
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await safeCall(() =>
      this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.appURL,
          'X-Title': this.appName,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      }),
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    return mapResponse(data);
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const response = await this.chat(messages, options);

    if (response.content) {
      yield { type: 'text', text: response.content };
    }

    for (const tc of response.toolCalls) {
      yield { type: 'tool_use', toolCall: tc };
    }

    yield { type: 'done' };
  }

  async embed(_text: string, _options?: EmbedOptions): Promise<EmbedResponse> {
    throw new Error('OpenRouter does not support embeddings — use OpenAI or Gemini');
  }
}

function mapResponse(data: OpenRouterResponse): ChatResponse {
  const choice = data.choices[0];
  if (!choice) {
    return {
      content: '',
      toolCalls: [],
      model: data.model,
      usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
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
    model: data.model,
    usage: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
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
