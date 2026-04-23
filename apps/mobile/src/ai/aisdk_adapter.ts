/**
 * AI-SDK → Brain LLMProvider adapter.
 *
 * Brain's agentic loop (`runAgenticTurn`) consumes an `LLMProvider` that
 * implements `chat(messages, {tools, …})`. The app holds BYOK API keys and
 * instantiates models through Vercel's AI SDK (`@ai-sdk/openai`,
 * `@ai-sdk/google`). This adapter bridges the two: given an AI-SDK
 * `LanguageModel`, it exposes the Brain-side `LLMProvider` interface so the
 * multi-turn tool-use loop + the single-shot `reason()` both get the same
 * provider wiring.
 *
 * Only `chat()` is implemented. `stream()` throws because the agentic
 * loop never streams — switching to it needs a real AI-SDK `streamText`
 * integration, not a naive `chat()` wrapper. `embed()` throws because
 * the AI-SDK chat SDK doesn't implement embeddings; Brain's embedding
 * pipeline registers a dedicated provider through
 * `registerCloudProvider` / `registerLocalProvider`. Both error messages
 * below point callers at the right seam instead of silently falling
 * back (review finding #7).
 */

import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { generateText, tool as defineTool, jsonSchema } from 'ai';
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ToolDefinition,
  ToolCall,
  StreamChunk,
  EmbedOptions,
  EmbedResponse,
} from '@dina/brain/src/llm/adapters/provider';

export interface AISDKAdapterOptions {
  /** Model handle from `@ai-sdk/openai` or `@ai-sdk/google`. */
  model: LanguageModel;
  /** Provider label surfaced on `LLMProvider.name`. */
  name: string;
}

export class AISDKAdapter implements LLMProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly model: LanguageModel;

  constructor(options: AISDKAdapterOptions) {
    this.model = options.model;
    this.name = options.name;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const { system, messages: aiMessages } = toAISDKMessages(messages, options.systemPrompt);

    const result = await generateText({
      model: this.model,
      system,
      messages: aiMessages,
      tools: options.tools !== undefined ? toAISDKTools(options.tools) : undefined,
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      abortSignal: options.signal,
    });

    const toolCalls: ToolCall[] = result.toolCalls.map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: (tc.input ?? {}) as Record<string, unknown>,
    }));

    return {
      content: result.text,
      toolCalls,
      model: this.name,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      finishReason: mapFinishReason(result.finishReason, toolCalls.length),
    };
  }

  stream(): AsyncIterable<StreamChunk> {
    throw new Error(
      'AISDKAdapter.stream() is not implemented. Use chat() for non-streaming turns, ' +
        'or build a dedicated streaming adapter around AI-SDK streamText() — do NOT try ' +
        'to shim it on top of chat().',
    );
  }

  embed(_text: string, _options?: EmbedOptions): Promise<EmbedResponse> {
    return Promise.reject(
      new Error(
        "AISDKAdapter.embed() is not supported. Embeddings go through Brain's embedding " +
          'pipeline via registerLocalProvider / registerCloudProvider in ' +
          'brain/src/embedding/generation.ts — register an embedding-specific provider ' +
          'there instead of routing through the AI-SDK chat adapter.',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Brain ChatMessage[] → AI SDK ModelMessage[]
// ---------------------------------------------------------------------------

/**
 * Convert Brain's `ChatMessage` transcript into the AI SDK's `ModelMessage`
 * shape. System-role entries are pulled out because `generateText` takes the
 * system prompt separately; the rest keep their order so multi-turn tool
 * transcripts round-trip correctly (assistant-with-toolCalls → tool-result
 * → next assistant turn).
 *
 * Multiple system entries are joined with blank-line separators (review
 * finding #8). The previous `system ?? m.content` form took only the
 * first system block and silently dropped every subsequent one — which
 * matters because Brain's pipeline layers system-level instructions
 * (persona context, guard-scan hints, density-disclosure rules) as
 * separate blocks and expects every one to reach the LLM.
 */
function toAISDKMessages(
  messages: ChatMessage[],
  overrideSystem: string | undefined,
): { system: string | undefined; messages: ModelMessage[] } {
  const systemParts: string[] = overrideSystem !== undefined ? [overrideSystem] : [];
  const out: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content !== '') systemParts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: [
            ...(m.content !== '' ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({
              type: 'tool-call' as const,
              toolCallId: tc.id ?? tc.name,
              toolName: tc.name,
              input: tc.arguments,
            })),
          ],
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }
    if (m.role === 'tool') {
      const parsed = safeParseJSON(m.content);
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId ?? m.toolName ?? '',
            toolName: m.toolName ?? '',
            // ModelMessage's tool-result output requires a JSON-serialisable
            // value. When the content wasn't valid JSON we fall back to the
            // string body (still valid JSON once wrapped).
            output: { type: 'json', value: parsed as Parameters<typeof JSON.stringify>[0] },
          },
        ],
      });
      continue;
    }
  }

  const system = systemParts.length === 0 ? undefined : systemParts.join('\n\n');
  return { system, messages: out };
}

// ---------------------------------------------------------------------------
// Brain ToolDefinition[] → AI SDK tools record
// ---------------------------------------------------------------------------

/**
 * AI SDK's `generateText` wants tools as a `Record<name, Tool>` — a tool has
 * `{description, inputSchema}` plus optional `execute`. We stamp tools
 * WITHOUT `execute` so the SDK surfaces raw tool calls in its result;
 * Brain's loop runs them through the ToolRegistry itself.
 *
 * `inputSchema` accepts a JSON Schema via the `jsonSchema()` helper.
 */
function toAISDKTools(defs: ToolDefinition[]): ToolSet {
  const out: ToolSet = {};
  for (const def of defs) {
    out[def.name] = defineTool({
      description: def.description,
      inputSchema: jsonSchema(def.parameters),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(
  reason: string | undefined,
  toolCallCount: number,
): ChatResponse['finishReason'] {
  if (toolCallCount > 0) return 'tool_use';
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'error':
    case 'content-filter':
      return 'error';
    case 'tool-calls':
      return 'tool_use';
    case 'stop':
    case 'other':
    case 'unknown':
    default:
      return 'end';
  }
}

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
