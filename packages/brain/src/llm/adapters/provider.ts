/**
 * LLM Provider interface — common contract for all LLM adapters.
 *
 * All adapters (Claude, OpenAI, Gemini, OpenRouter) implement this
 * interface. The router selects the provider; the adapter handles
 * the SDK-specific details.
 *
 * Source: ARCHITECTURE.md Tasks 3.3–3.6
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Assistant-role messages that issued tool calls carry them here so the
   * next-turn request round-trips correctly (Gemini/Anthropic/OpenAI all
   * need the prior functionCall block before the functionResponse).
   */
  toolCalls?: ToolCall[];
  /** For role='tool': the tool call this result corresponds to. */
  toolCallId?: string;
  /** For role='tool': the tool that was invoked. */
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Tool call ID for multi-turn correlation (matching Python/Go round-trip). */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque per-provider metadata the adapter needs to echo back verbatim
   * on the next turn. Gemini 3.x thinking models stamp each `functionCall`
   * with a `thoughtSignature` the client MUST replay — without it the
   * next `generateContent` rejects with "Function call is missing a
   * thought_signature in functionCall parts". Other providers ignore
   * this field.
   *
   * Shape is adapter-private; nothing above `LLMProvider` reads it.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
}

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface EmbedResponse {
  embedding: Float64Array;
  model: string;
  dimensions: number;
}

/**
 * Common LLM provider interface.
 *
 * All methods accept an AbortSignal for cancellation.
 */
export interface LLMProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsEmbedding: boolean;

  /** Send a chat completion request. */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a chat completion. Yields chunks as they arrive. */
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk>;

  /** Generate an embedding vector from text. */
  embed(text: string, options?: EmbedOptions): Promise<EmbedResponse>;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  signal?: AbortSignal;
  /**
   * JSON schema for structured output (Gemini's response_schema).
   * When set, the response is guaranteed to match this schema.
   * Ignored by providers that don't support structured output.
   */
  responseSchema?: Record<string, unknown>;
}

export interface EmbedOptions {
  model?: string;
  dimensions?: number;
  signal?: AbortSignal;
}
