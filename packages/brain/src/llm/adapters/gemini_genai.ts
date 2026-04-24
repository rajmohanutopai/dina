/**
 * Gemini LLM adapter on top of Google's own `@google/genai` SDK.
 *
 * This is the Gemini branch of Brain's `LLMProvider` surface. OpenAI and
 * Claude stay on `AISDKAdapter`; Gemini moves here because the Vercel
 * AI SDK (as of `@ai-sdk/google` v3.0.64) does NOT round-trip the
 * `thoughtSignature` blob Gemini 3.x thinking models stamp onto every
 * `functionCall` part — without the round-trip, the second agentic
 * turn rejects with:
 *
 *     Function call is missing a thought_signature in functionCall parts.
 *     This is required for tools to work correctly … Additional data,
 *     function call `default_api:<tool>`, position N.
 *
 * `@google/genai` carries the signature on the `Part` itself
 * (`part.thoughtSignature`), so preserving the part verbatim when we
 * replay the transcript fixes the round-trip. We stash the signature on
 * the returned `ToolCall.providerMetadata.thoughtSignature` and re-stamp
 * it on the way out.
 *
 * The root import `@google/genai` resolves per bundler condition —
 * Metro / RN picks the `browser` export (fetch-based web build, no
 * `fs`/`http`/`google-auth-library`); Node picks the `node` build
 * (ships `google-auth-library` + `protobufjs` which we don't
 * exercise on an API-key client). Both surface the same types for
 * the API-key path we use, so one import string works everywhere.
 */

import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbedOptions,
  EmbedResponse,
  LLMProvider,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from './provider';
import { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_TOKENS } from '../../constants';

/**
 * Shape of our `ToolCall.providerMetadata` when this adapter is in play.
 * Other providers leave `providerMetadata` unset; we only read it when
 * the previous-turn message came through *this* adapter (name check on
 * every toolCall round-trip would be over-engineered — an unknown blob
 * just passes through harmlessly).
 */
interface GeminiToolCallMetadata {
  thoughtSignature?: string;
}

export interface GeminiGenaiAdapterOptions {
  /** Gemini API key from BYOK / env. */
  apiKey: string;
  /** Default model id (e.g. `gemini-3.1-pro-preview`). */
  defaultModel?: string;
  /**
   * Override the SDK instance — used by tests that want to intercept
   * `models.generateContent` without standing up a real HTTPS target.
   */
  client?: GoogleGenAI;
}

export class GeminiGenaiAdapter implements LLMProvider {
  readonly name = 'gemini';
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor(options: GeminiGenaiAdapterOptions) {
    this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
    this.defaultModel = options.defaultModel ?? DEFAULT_GEMINI_MODEL;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const model = options.model ?? this.defaultModel;
    const systemInstruction =
      options.systemPrompt ??
      messages.find((m) => m.role === 'system' && m.content !== '')?.content;

    const contents = toGeminiContents(messages);
    const tools =
      options.tools && options.tools.length > 0 ? [toFunctionDeclarations(options.tools)] : undefined;

    const response = await this.client.models.generateContent({
      model,
      contents,
      config: {
        // `systemInstruction` accepts string | Part | Content | Content[];
        // plain string matches how we built the prompt upstream.
        ...(systemInstruction !== undefined ? { systemInstruction } : {}),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(tools !== undefined ? { tools } : {}),
        // Native Gemini structured-output: set the MIME type when the
        // caller supplied a JSON schema so we get guaranteed-valid JSON
        // back (removes the need for fence-stripping in the parser).
        ...(options.responseSchema !== undefined
          ? {
              responseMimeType: 'application/json',
              // `responseSchema` in `@google/genai` is a plain JSONSchema —
              // matches what our callers pass today.
              responseSchema: options.responseSchema as unknown as Record<string, unknown>,
            }
          : {}),
        abortSignal: options.signal,
      },
    });

    return mapResponse(response, model);
  }

  stream(): AsyncIterable<StreamChunk> {
    throw new Error(
      'GeminiGenaiAdapter.stream() is not implemented. Use chat() for non-streaming turns, ' +
        'or build a dedicated streaming adapter around `generateContentStream` — do NOT shim it on top of chat().',
    );
  }

  embed(_text: string, _options?: EmbedOptions): Promise<EmbedResponse> {
    return Promise.reject(
      new Error(
        "GeminiGenaiAdapter.embed() is not supported. Embeddings go through Brain's embedding " +
          'pipeline via registerLocalProvider / registerCloudProvider in ' +
          'packages/brain/src/embedding/generation.ts — register an embedding-specific provider ' +
          'there instead of routing through the Gemini chat adapter.',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Brain `ChatMessage[]` ↔ Gemini `Content[]`
// ---------------------------------------------------------------------------

/**
 * Convert our transcript into Gemini's `Content[]`. Three cases:
 *
 *   - `system`  → filtered out; surfaced through `config.systemInstruction`.
 *   - `tool`    → `role='user'` with a `functionResponse` part.
 *   - `assistant` + `toolCalls` → `role='model'` with one `functionCall`
 *     part per call, re-stamping `thoughtSignature` from
 *     `ToolCall.providerMetadata` so Gemini 3.x thinking models can
 *     resume their thought chain.
 *
 * Plain text turns (`user` / `assistant` without toolCalls) round-trip as
 * a single `{text}` part.
 */
function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        parsed = { result: m.content };
      }
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              // `id` here is what the Gemini API uses to match the
              // response back to its originating call when the
              // `functionCall` in the prior turn carried an `id`.
              id: m.toolCallId,
              name: m.toolName ?? '',
              response: parsed as Record<string, unknown>,
            },
          },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const parts: Part[] = [];
      if (m.content !== '') parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        const meta = (tc.providerMetadata as GeminiToolCallMetadata | undefined) ?? {};
        const functionCall: FunctionCall = {
          name: tc.name,
          args: tc.arguments,
          ...(tc.id !== undefined ? { id: tc.id } : {}),
        };
        const part: Part = { functionCall };
        // The load-bearing line: echo the signature back verbatim. If
        // `meta.thoughtSignature` is absent (non-thinking model or an
        // older round-trip that dropped it), we just omit the field and
        // the API accepts the request for non-thinking models.
        if (typeof meta.thoughtSignature === 'string' && meta.thoughtSignature !== '') {
          part.thoughtSignature = meta.thoughtSignature;
        }
        parts.push(part);
      }
      out.push({ role: 'model', parts });
      continue;
    }

    // Plain text turn.
    out.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  return out;
}

/**
 * Brain `ToolDefinition[]` → Gemini's single-tool-block with function
 * declarations. We always collapse into one `{functionDeclarations: […]}`
 * entry because all our tools are client-executed functions (no Google
 * Search, no code-execution, etc.).
 */
function toFunctionDeclarations(defs: ToolDefinition[]): {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parametersJsonSchema: Record<string, unknown>;
  }>;
} {
  return {
    functionDeclarations: defs.map((t) => ({
      name: t.name,
      description: t.description,
      // `parametersJsonSchema` accepts plain JSON Schema; the older
      // `parameters` field wants Gemini's bespoke `Schema` type which
      // needs per-field type conversion. Our tool registry already
      // produces JSON Schema so the "json" field is the direct fit.
      parametersJsonSchema: t.parameters,
    })),
  };
}

// ---------------------------------------------------------------------------
// Gemini `GenerateContentResponse` → Brain `ChatResponse`
// ---------------------------------------------------------------------------

function mapResponse(response: GenerateContentResponse, model: string): ChatResponse {
  const candidate = response.candidates?.[0];
  let content = '';
  const toolCalls: ToolCall[] = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text !== undefined && part.text !== '' && part.thought !== true) {
        content += part.text;
      }
      if (part.functionCall !== undefined) {
        const fc = part.functionCall;
        // Synthetic id when the SDK didn't stamp one — the agentic loop
        // uses this as a correlation key when it emits the paired
        // `functionResponse` back. Must be stable within the call.
        const id = fc.id ?? `call_${toolCalls.length}`;
        const providerMetadata: GeminiToolCallMetadata = {};
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          providerMetadata.thoughtSignature = part.thoughtSignature;
        }
        toolCalls.push({
          id,
          name: fc.name ?? '',
          arguments: (fc.args ?? {}) as Record<string, unknown>,
          ...(Object.keys(providerMetadata).length > 0
            ? { providerMetadata: providerMetadata as Record<string, unknown> }
            : {}),
        });
      }
    }
  }

  const usage = response.usageMetadata ?? {};
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;

  const finishReason: ChatResponse['finishReason'] =
    candidate?.finishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : toolCalls.length > 0
        ? 'tool_use'
        : 'end';

  return {
    content,
    toolCalls,
    model,
    usage: { inputTokens, outputTokens },
    finishReason,
  };
}
