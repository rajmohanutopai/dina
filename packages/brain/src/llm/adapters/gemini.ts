/**
 * Gemini LLM adapter — wraps Google Generative AI SDK.
 *
 * Features:
 *   - Chat completion with system instruction support
 *   - Streaming with text chunks
 *   - Structured JSON output (via responseMimeType)
 *   - Embedding via embedding-001 (768 dimensions)
 *   - Lite model support (gemini-2.5-flash for lightweight tasks)
 *   - Tool calling via functionDeclarations
 *
 * Gemini API differences from OpenAI/Claude:
 *   - System prompt is a top-level `systemInstruction`, not a message role
 *   - Messages use 'user'/'model' roles (not 'user'/'assistant')
 *   - Tool definitions use `functionDeclarations` format
 *   - Embeddings use a separate `embedContent` method
 *
 * Source: ARCHITECTURE.md Task 3.5
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

/**
 * Minimal Gemini SDK client interface for injection.
 */
export interface GeminiClient {
  getGenerativeModel(params: { model: string; systemInstruction?: string }): GeminiModel;
}

export interface GeminiModel {
  generateContent(request: GeminiRequest): Promise<GeminiResult>;
  embedContent(request: GeminiEmbedRequest): Promise<GeminiEmbedResult>;
}

/** One part of a Gemini message — text, function call, or function response. */
export type GeminiRequestPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiRequest {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiRequestPart[] }>;
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
}

export interface GeminiResult {
  response: {
    text(): string;
    candidates?: Array<{
      content: { parts: Array<GeminiPart> };
      finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'OTHER';
    }>;
    usageMetadata?: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      totalTokenCount: number;
    };
  };
}

export type GeminiPart =
  | { text: string; functionCall?: undefined }
  | { text?: undefined; functionCall: { name: string; args: Record<string, unknown> } };

export interface GeminiEmbedRequest {
  content: { parts: Array<{ text: string }> };
}

export interface GeminiEmbedResult {
  embedding: { values: number[] };
}

import { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_TOKENS as MAX_TOKENS } from '../../constants';
import { safeCall, GEMINI_TIMEOUT_MS } from './safety';

const DEFAULT_CHAT_MODEL = DEFAULT_GEMINI_MODEL;
const DEFAULT_EMBED_MODEL = 'embedding-001'; // Gemini-specific, not shared
const DEFAULT_MAX_TOKENS = MAX_TOKENS;

export class GeminiAdapter implements LLMProvider {
  readonly name = 'gemini';
  readonly supportsStreaming = true;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = true;

  private readonly client: GeminiClient;
  private readonly defaultModel: string;
  private readonly defaultEmbedModel: string;

  constructor(client: GeminiClient, defaultModel?: string, defaultEmbedModel?: string) {
    this.client = client;
    this.defaultModel = defaultModel ?? DEFAULT_CHAT_MODEL;
    this.defaultEmbedModel = defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const modelName = options?.model ?? this.defaultModel;

    // Extract system instruction
    const systemInstruction =
      options?.systemPrompt ?? messages.find((m) => m.role === 'system')?.content;

    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    // Map messages to Gemini's content shape. Three cases beyond plain text:
    //   - assistant + toolCalls  → role='model' with functionCall parts
    //   - role='tool'            → role='user'  with functionResponse part
    //   - system                 → filtered (already surfaced as systemInstruction)
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          // Tool result round-trip. `content` carries the JSON-stringified
          // result; `toolName` is the tool that was invoked.
          let parsed: unknown;
          try {
            parsed = JSON.parse(m.content);
          } catch {
            parsed = { result: m.content };
          }
          return {
            role: 'user' as const,
            parts: [
              {
                functionResponse: {
                  name: m.toolName ?? '',
                  response: parsed as Record<string, unknown>,
                },
              },
            ],
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const parts: GeminiRequestPart[] = [];
          if (m.content !== '') parts.push({ text: m.content });
          for (const tc of m.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
          return {
            role: 'model' as const,
            parts,
          };
        }
        return {
          role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
          parts: [{ text: m.content }],
        };
      });

    const request: GeminiRequest = {
      contents,
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature,
        // Structured JSON output — when a responseSchema is provided, set the
        // MIME type to application/json so Gemini returns guaranteed-valid JSON.
        ...(options?.responseSchema
          ? {
              responseMimeType: 'application/json',
              responseSchema: options.responseSchema,
            }
          : {}),
      },
    };

    if (options?.tools && options.tools.length > 0) {
      request.tools = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    // PC-BRAIN-18: 180s timeout for Gemini pro-class models. Chat
    // turns that use tools / multi-step reasoning routinely take
    // longer than the shared 60s default; bumping the per-provider
    // value here keeps other adapters on the safer default.
    const result = await safeCall(() => model.generateContent(request), GEMINI_TIMEOUT_MS);
    return mapGeminiResponse(result, modelName);
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

  async embed(text: string, options?: EmbedOptions): Promise<EmbedResponse> {
    const modelName = options?.model ?? this.defaultEmbedModel;
    const model = this.client.getGenerativeModel({ model: modelName });

    // PC-BRAIN-18: embed calls share the Gemini timeout so embedding
    // 30-day batches of vault items never aborts mid-run.
    const result = await safeCall(
      () => model.embedContent({ content: { parts: [{ text }] } }),
      GEMINI_TIMEOUT_MS,
    );

    if (!result.embedding || !result.embedding.values || result.embedding.values.length === 0) {
      throw new Error('Gemini embedding returned no data');
    }

    const raw = result.embedding.values;
    return {
      embedding: new Float64Array(raw),
      model: modelName,
      dimensions: raw.length,
    };
  }
}

function mapGeminiResponse(result: GeminiResult, modelName: string): ChatResponse {
  const response = result.response;
  const candidate = response.candidates?.[0];

  let content = '';
  const toolCalls: ToolCall[] = [];

  if (candidate) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}`, // Synthetic ID — Gemini doesn't provide one
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
      }
    }
  } else {
    // Fallback to response.text() if no candidates structure
    content = response.text();
  }

  const finishReason =
    candidate?.finishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : toolCalls.length > 0
        ? 'tool_use'
        : 'end';

  const usage = response.usageMetadata ?? {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  };

  return {
    content,
    toolCalls,
    model: modelName,
    usage: {
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
    },
    finishReason,
  };
}

/**
 * Create a Gemini adapter from an API key.
 */
export function createGeminiAdapter(apiKey: string, model?: string): GeminiAdapter {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(apiKey);
  return new GeminiAdapter(client, model);
}
