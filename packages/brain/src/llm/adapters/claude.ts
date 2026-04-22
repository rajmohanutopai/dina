/**
 * Claude LLM adapter — wraps Anthropic SDK.
 *
 * Features:
 *   - Chat completion with system prompt support
 *   - Streaming with text + tool_use chunks
 *   - Tool calling (function calling)
 *   - No embedding support (Anthropic doesn't offer embeddings)
 *
 * The adapter is designed for injectable SDK client — in production,
 * the real @anthropic-ai/sdk is injected; in tests, a mock is used.
 *
 * Source: ARCHITECTURE.md Task 3.3
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
 * Minimal subset of the Anthropic SDK client interface.
 * Allows injection of the real SDK or a mock.
 */
export interface AnthropicClient {
  messages: {
    create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  temperature?: number;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  stream?: boolean;
}

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage: { input_tokens: number; output_tokens: number };
}

import { DEFAULT_CLAUDE_MODEL, DEFAULT_MAX_TOKENS as MAX_TOKENS } from '../../constants';
import { safeCall } from './safety';
const DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL;
const DEFAULT_MAX_TOKENS = MAX_TOKENS;

export class ClaudeAdapter implements LLMProvider {
  readonly name = 'claude';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly client: AnthropicClient;
  private readonly defaultModel: string;

  constructor(client: AnthropicClient, defaultModel?: string) {
    this.client = client;
    this.defaultModel = defaultModel ?? DEFAULT_MODEL;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Separate system message from conversation
    const systemPrompt =
      options?.systemPrompt ?? messages.find((m) => m.role === 'system')?.content;
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Structured JSON output: when responseSchema is provided, use Claude's
    // prefilled assistant technique — append an assistant message starting with '{'
    // to force Claude to continue with valid JSON.
    if (options?.responseSchema && conversationMessages.length > 0) {
      const lastMsg = conversationMessages[conversationMessages.length - 1];
      // Only prefill if the last message is from the user
      if (lastMsg.role === 'user') {
        conversationMessages.push({ role: 'assistant', content: '{' });
      }
    }

    const params: AnthropicCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: conversationMessages,
      temperature: options?.temperature,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const response = await safeCall(() => this.client.messages.create(params));

    const result = mapResponse(response);

    // If we used prefilled assistant for structured output, prepend the '{' back
    // since Claude's response continues from where the prefill left off.
    if (options?.responseSchema && result.content && !result.content.trimStart().startsWith('{')) {
      result.content = '{' + result.content;
    }

    return result;
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    // For non-streaming fallback: call chat and yield the full result
    // Real streaming would use client.messages.stream() with SSE
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
    throw new Error('Claude does not support embeddings — use OpenAI or Gemini');
  }
}

function mapResponse(response: AnthropicMessageResponse): ChatResponse {
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  const finishReason =
    response.stop_reason === 'tool_use'
      ? 'tool_use'
      : response.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : 'end';

  return {
    content,
    toolCalls,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    finishReason,
  };
}

/**
 * Create a Claude adapter from an API key.
 *
 * In production, this imports and instantiates the real Anthropic SDK.
 * For testing, use the constructor directly with a mock client.
 */
export function createClaudeAdapter(apiKey: string, model?: string): ClaudeAdapter {
  // Lazy import to avoid requiring the SDK at module load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  return new ClaudeAdapter(client, model);
}
