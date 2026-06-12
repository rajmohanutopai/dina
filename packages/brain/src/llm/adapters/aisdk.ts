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

import type { LanguageModel, ModelMessage, ToolCallPart, ToolSet } from 'ai';
import type { ReasoningPart as AIReasoningPart } from '@ai-sdk/provider-utils';
import { generateText, tool as defineTool, jsonSchema } from 'ai';
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ReasoningPart,
  ToolDefinition,
  ToolCall,
  StreamChunk,
  EmbedOptions,
  EmbedResponse,
} from './provider';

export interface AISDKAdapterOptions {
  /** Model handle from `@ai-sdk/openai` or `@ai-sdk/google`. */
  model: LanguageModel;
  /** Provider label surfaced on `LLMProvider.name`. */
  name: string;
  /**
   * Override the auto-detected OpenAI reasoning effort. Set this
   * when the catalog pseudo-id implies a specific thinking mode
   * (e.g. `gpt-5.5+thinking` → `'high'`). When unset, the adapter
   * falls back to `lowestSupportedOpenAIEffort(modelId)` — the
   * cheapest effort the model accepts.
   *
   * Ignored when the underlying model is not OpenAI.
   */
  openaiReasoningEffort?: 'none' | 'low' | 'minimal' | 'medium' | 'high' | 'xhigh';
}

export class AISDKAdapter implements LLMProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly model: LanguageModel;
  private readonly openaiReasoningEffort: AISDKAdapterOptions['openaiReasoningEffort'];

  constructor(options: AISDKAdapterOptions) {
    this.model = options.model;
    this.name = options.name;
    this.openaiReasoningEffort = options.openaiReasoningEffort;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const { system, messages: aiMessages } = toAISDKMessages(messages, options.systemPrompt);

    // Reasoning-effort resolution:
    //
    //   1. Constructor override (`openaiReasoningEffort`) — set by
    //      `createLLMProvider` when the catalog pseudo-id implies a
    //      mode (e.g. `gpt-5.5+thinking` → `'high'`).
    //   2. Model-id-aware floor (`lowestSupportedOpenAIEffort`) —
    //      cheapest value the model accepts. Each gpt-5+ variant has
    //      its OWN floor; verified live against /v1/responses on
    //      2026-05-22:
    //
    //        - gpt-5.5         → 'none'    (0 reasoning tokens)
    //        - gpt-5.5-pro     → 'medium'  (none/low/minimal rejected)
    //        - gpt-5-mini/nano → 'minimal' (none + low rejected)
    //
    //   3. None — no override; SDK uses its default. Used for
    //      models we don't recognise and for non-OpenAI providers
    //      (which ignore the `openai` namespace anyway).
    // `LanguageModel` is a union of (string | LanguageModelV3). The
    // string form is OpenAI's auto-discovery shorthand; the v3 form
    // is the instance returned by `openai('gpt-5.5')`. Both expose
    // the model id, just at different paths — pull it via a narrow
    // helper so the effort lookup works in either shape.
    const modelId =
      typeof this.model === 'string' ? this.model : this.model.modelId;
    const effort =
      this.openaiReasoningEffort ?? lowestSupportedOpenAIEffort(modelId);
    // For non-OpenAI OR-routed models (Gemini, Qwen, Anthropic via
    // OR, etc.) the adapter does NOT force `effort: 'none'`. An
    // earlier version did to drop the upstream's default reasoning
    // tokens (gpt-5.5 burns 10, qwen3.6-flash burns 108 for a
    // 4-token reply), but in practice that crippled multi-step
    // tool-use — Gemini-3.5-flash with reasoning OFF couldn't plan
    // search_vault → PeerLens → answer sequences and hit
    // `max_iterations` after 4 minutes of looping (verified
    // 2026-05-22). Letting the upstream's default reasoning effort
    // through costs more per turn but each turn actually converges.
    // Users who want minimum cost can pick a non-thinking explicit
    // catalog entry in the picker.
    const providerOptions: NonNullable<Parameters<typeof generateText>[0]['providerOptions']> =
      effort !== null ? { openai: { reasoning: { effort } } } : {};

    const result = await generateText({
      model: this.model,
      system,
      messages: aiMessages,
      tools: options.tools !== undefined ? toAISDKTools(options.tools) : undefined,
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      abortSignal: options.signal,
      providerOptions,
      // The default is 2 retries with exponential backoff — fine for a
      // transient blip, terrible for a 429 quota or a bad key (the
      // call cycles 3× across ~20s before surfacing to the user). Cap
      // at 1 retry so quota / auth errors fail fast and the friendly
      // message in `useChatAsk.humaniseAskError` reaches the chat
      // bubble in a few seconds, not half a minute. Genuine network
      // blips still get one retry.
      maxRetries: 1,
    });

    // Preserve `providerMetadata` on each tool call verbatim — opaque to
    // Brain but load-bearing for some providers (Gemini 3.x thinking
    // models stamp `thoughtSignature` here; the signature MUST be
    // re-sent on the next turn or the API rejects with "Function call
    // is missing a thought_signature in functionCall parts"). Dropping
    // this field is what forced the earlier `@google/genai` swap for
    // Gemini; the fix here lets future providers route through AISDKAdapter
    // safely. See `LLMProvider.ToolCall.providerMetadata` contract.
    const toolCalls: ToolCall[] = result.toolCalls.map((tc) => {
      const call: ToolCall = {
        id: tc.toolCallId,
        name: tc.toolName,
        arguments: (tc.input ?? {}) as Record<string, unknown>,
      };
      if (tc.providerMetadata !== undefined) {
        call.providerMetadata = tc.providerMetadata as Record<string, unknown>;
      }
      return call;
    });

    // Capture reasoning items so the agentic loop can echo them back
    // on the next turn. OpenAI gpt-5+ and Anthropic Claude Opus 4.7
    // (extended thinking) reject the next request when a `function_call`
    // item is sent without its paired `reasoning` item — see
    // `ChatMessage.reasoning` for the cross-provider rationale.
    const reasoning: ReasoningPart[] = (result.reasoning ?? []).map((r) => {
      const part: ReasoningPart = { text: r.text };
      if (r.providerMetadata !== undefined) {
        part.providerMetadata = r.providerMetadata as Record<string, unknown>;
      }
      return part;
    });

    // Token telemetry for cost calibration — metadata ONLY (counts +
    // provider + RESOLVED model id), never prompt/response content. The
    // resolved id (e.g. `deepseek/deepseek-v4-flash`) is the only
    // unambiguous proof of which model OpenRouter actually billed —
    // `this.name` alone is just the provider ('openrouter'). Parity with
    // the GeminiGenaiAdapter's [LLM-USAGE] line.
    const resolvedModelId =
      typeof this.model === 'string'
        ? this.model
        : ((this.model as { modelId?: string }).modelId ?? this.name);
    const cachedTokens =
      (result.usage as { cachedInputTokens?: number }).cachedInputTokens ?? 0;
    console.log(
      `[LLM-USAGE] provider=${this.name} model=${resolvedModelId} in=${result.usage.inputTokens ?? 0} out=${result.usage.outputTokens ?? 0} cached=${cachedTokens} tools=${toolCalls.length}`,
    );

    return {
      content: result.text,
      toolCalls,
      ...(reasoning.length > 0 ? { reasoning } : {}),
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
      const hasToolCalls = m.toolCalls !== undefined && m.toolCalls.length > 0;
      const hasReasoning = m.reasoning !== undefined && m.reasoning.length > 0;
      if (hasToolCalls || hasReasoning) {
        // Reasoning parts MUST precede their paired tool-call parts in
        // the request payload — OpenAI's `/v1/responses` rejects with
        // "function_call without required reasoning item" when the
        // order is reversed or the reasoning is missing. Anthropic's
        // extended-thinking mode has the same expectation. See
        // `ChatMessage.reasoning` for the cross-provider write-up.
        const reasoningParts = (m.reasoning ?? []).map((r): AIReasoningPart => {
          const part: AIReasoningPart = { type: 'reasoning', text: r.text };
          if (r.providerMetadata !== undefined) {
            part.providerOptions =
              r.providerMetadata as unknown as AIReasoningPart['providerOptions'];
          }
          return part;
        });
        const toolCallParts = (m.toolCalls ?? []).map((tc): ToolCallPart => {
          const part: ToolCallPart = {
            type: 'tool-call',
            toolCallId: tc.id ?? tc.name,
            toolName: tc.name,
            input: tc.arguments,
          };
          // Re-stamp the provider-specific metadata we preserved
          // from the original response so it round-trips verbatim.
          // The AI SDK surfaces metadata as `providerMetadata` on
          // responses but expects it as `providerOptions` on
          // requests (same payload, different field name — naming
          // asymmetry in the SDK itself).
          //
          // The shape-assertion is safe: the payload was generated
          // BY the SDK originally, so it's structurally a valid
          // `ProviderOptions` (= `Record<string, JSONObject>`) —
          // the round-trip is source-preserving.
          if (tc.providerMetadata !== undefined) {
            part.providerOptions =
              tc.providerMetadata as unknown as ToolCallPart['providerOptions'];
          }
          return part;
        });
        out.push({
          role: 'assistant',
          content: [
            ...reasoningParts,
            ...(m.content !== '' ? [{ type: 'text' as const, text: m.content }] : []),
            ...toolCallParts,
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

/**
 * Return the lowest `reasoning.effort` each OpenAI gpt-5+ model
 * supports — the cheapest option that doesn't trigger an
 * `Unsupported value` 400. Returns `null` for non-OpenAI models or
 * OpenAI ids we don't have a mapping for, so the caller skips the
 * override and inherits the SDK default.
 *
 * The supported-values matrix was probed live against /v1/responses
 * on 2026-05-22; if a vendor relaxes their floor later, the worst
 * outcome is a slightly higher-than-needed effort being requested.
 *
 * Also recognises the OpenRouter-style `openai/<model>` prefix —
 * OR forwards the upstream model's effort floor identically, so the
 * mapping is shared.
 */
export function lowestSupportedOpenAIEffort(
  modelId: string,
): 'none' | 'minimal' | 'medium' | null {
  // OR namespaces OpenAI ids as `openai/gpt-...`. Strip the prefix
  // so the same matchers below cover both direct + routed calls.
  const id = modelId.startsWith('openai/')
    ? modelId.slice('openai/'.length)
    : modelId;
  // gpt-5.5-pro is reasoning-only; lowest it accepts is `medium`.
  // Check this BEFORE the gpt-5.5 prefix so we match the more
  // specific id first.
  if (id.startsWith('gpt-5.5-pro')) return 'medium';
  if (id.startsWith('gpt-5.5')) return 'none';
  if (id.startsWith('gpt-5-mini') || id.startsWith('gpt-5-nano')) {
    return 'minimal';
  }
  if (id.startsWith('gpt-5-pro')) return 'medium';
  // gpt-5 base model: same floor as 5.5 base (none) per current
  // vendor docs.
  if (id.startsWith('gpt-5')) return 'none';
  return null;
}
