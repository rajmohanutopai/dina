/**
 * LLM router (dispatch layer) — the single seam every cloud LLM call
 * goes through.
 *
 * Port of `brain/src/service/llm_router.py::LLMRouter.route`. The
 * existing `router.ts::routeTask` is the decision function Python's
 * `_pick_provider` returns; this file is the orchestrator that wraps
 * a decision with:
 *
 *   1. Task-type → tier mapping (classify / guard_scan / etc. → lite;
 *      reason / plan → primary or heavy).
 *   2. Cloud-consent gate (throws `CloudConsentError` when the persona
 *      is sensitive and no local LLM is available AND consent hasn't
 *      been granted).
 *   3. Mandatory PII scrub on outbound messages to any cloud provider
 *      (Python's cloud-wide policy — structural PII never leaves the
 *      device in plain-text).
 *   4. Rehydration of scrubbed tokens in the response content + every
 *      tool-call's arguments. Tool args matter: the LLM sees
 *      `[PERSON_1]` in a scrubbed prompt and may echo it into a tool
 *      call (`vault_search({query: "[PERSON_1] birthday"})`). The
 *      tool is a vault search over the user's REAL names — without
 *      rehydration it misses every hit.
 *   5. Provider dispatch + usage accounting.
 *
 * Above this layer, callers still program against `LLMProvider`
 * (e.g. `runAgenticTurn` + `createGeminiClassifier`). The
 * `RoutedLLMProvider` below adapts the router back to that interface
 * by binding a task_type at construction.
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbedOptions,
  EmbedResponse,
  LLMProvider,
  StreamChunk,
  ToolCall,
} from './adapters/provider';
import {
  isFTSOnly,
  isLightweightTask,
  type ProviderName,
  type RouterConfig,
  type TaskType,
} from './router';
import { getProviderTiers } from './provider_config';
import { CloudConsentError } from '../../../core/src/errors';
import {
  scrubPII,
  rehydratePII,
  type PIIMatch,
} from '../../../core/src/pii/patterns';

export interface LLMRouterOptions {
  /**
   * Per-provider LLMProvider instances. Keys must match `ProviderName`.
   * The router chooses which one to call based on `routeTask`'s
   * decision; the rest sit idle.
   */
  providers: Partial<Record<ProviderName, LLMProvider>>;
  config: RouterConfig;
}

export interface RouterChatArgs {
  taskType: TaskType;
  /** The persona whose data this call touches. Required for the
   *  cloud-consent gate — omit only for provider-neutral calls. */
  persona?: string;
  messages: ChatMessage[];
  tools?: ChatOptions['tools'];
  systemPrompt?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Explicit model pin — bypasses tier-auto-pick. Used by
   * cost-sensitive callers that need a specific model (e.g. a
   * downstream summariser that wants `gemini-3.1-flash-preview`
   * regardless of the classify/reason split). Leave unset in the
   * hot path so the tier system decides.
   */
  modelOverride?: string;
}

type PIIEntity = PIIMatch & { token: string };

/**
 * Central router. Not an `LLMProvider` itself — it has a different
 * call shape (explicit `taskType`). Wrap it with `RoutedLLMProvider`
 * when you need the narrower `LLMProvider` surface.
 */
export class LLMRouter {
  private readonly providers: Partial<Record<ProviderName, LLMProvider>>;
  private readonly config: RouterConfig;

  constructor(options: LLMRouterOptions) {
    this.providers = options.providers;
    this.config = options.config;
  }

  /**
   * Dispatch a chat request. Applies tier selection, consent gating,
   * PII scrubbing, and response rehydration end-to-end.
   */
  async chat(args: RouterChatArgs): Promise<ChatResponse> {
    // FTS-only tasks never reach here — callers shouldn't route them
    // through the LLM. Throw loudly so the call site gets fixed.
    if (isFTSOnly(args.taskType)) {
      throw new Error(
        `LLMRouter: task "${args.taskType}" is FTS-only; do not route through the LLM layer`,
      );
    }

    const { providerName, requiresScrubbing } = this.pickProvider(args.persona);
    const provider = this.providers[providerName];
    if (provider === undefined) {
      throw new Error(
        `LLMRouter: provider "${providerName}" selected but no instance registered — wire one in the constructor's \`providers\` map`,
      );
    }

    const model = this.pickModel(args.taskType, providerName, args.modelOverride);

    // Scrub every message going out to a cloud provider. Keep the
    // entity map keyed by token so we can rehydrate response text +
    // tool-call arguments on the return path.
    const entities: PIIEntity[] = [];
    const scrubbedMessages = requiresScrubbing
      ? this.scrubMessages(args.messages, entities)
      : args.messages;
    const scrubbedSystemPrompt =
      requiresScrubbing && args.systemPrompt !== undefined
        ? this.scrubText(args.systemPrompt, entities)
        : args.systemPrompt;

    const response = await provider.chat(scrubbedMessages, {
      model,
      tools: args.tools,
      systemPrompt: scrubbedSystemPrompt,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
      responseSchema: args.responseSchema,
    });

    if (entities.length === 0) return response;
    return rehydrateResponse(response, entities);
  }

  // -------------------------------------------------------------------------
  // Decision helpers
  // -------------------------------------------------------------------------

  private pickProvider(persona: string | undefined): {
    providerName: ProviderName;
    requiresScrubbing: boolean;
  } {
    // 1. Local LLM wins — no scrubbing needed (data stays on device).
    if (this.config.localAvailable) {
      return { providerName: 'local', requiresScrubbing: false };
    }

    // 2. No cloud providers registered — nothing to route to.
    if (this.config.cloudProviders.length === 0) {
      throw new Error(
        'LLMRouter: no providers configured (neither local nor cloud) — register one before routing',
      );
    }

    // 3. Cloud provider selected — enforce consent gate for sensitive
    //    personas. Matches Python: missing consent throws, caller's
    //    UX layer handles the prompt-the-user flow.
    const providerName = this.config.cloudProviders[0]!;
    const isSensitive =
      persona !== undefined && this.config.sensitivePersonas.includes(persona);
    if (isSensitive && this.config.cloudConsentGranted !== true) {
      throw new CloudConsentError(
        persona!,
        `Cloud LLM consent required: persona "${persona}" is sensitive and no local LLM is available`,
      );
    }

    // 4. Every cloud call gets scrubbed. No persona-based opt-out;
    //    scrubbing is cloud-wide (matches Python's policy —
    //    otherwise structured PII leaks in "general" persona calls).
    return { providerName, requiresScrubbing: true };
  }

  private pickModel(
    taskType: TaskType,
    providerName: ProviderName,
    override: string | undefined,
  ): string | undefined {
    if (override !== undefined && override !== '') return override;
    if (providerName === 'none') return undefined;
    const tiers = getProviderTiers(providerName);
    return isLightweightTask(taskType) ? tiers.lite : tiers.primary;
  }

  // -------------------------------------------------------------------------
  // PII scrub / rehydrate helpers
  // -------------------------------------------------------------------------

  private scrubMessages(
    messages: ChatMessage[],
    entitySink: PIIEntity[],
  ): ChatMessage[] {
    return messages.map((m) => {
      const nextContent = m.content !== '' ? this.scrubText(m.content, entitySink) : '';
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
        return {
          ...m,
          content: nextContent,
          toolCalls: m.toolCalls.map((tc) => ({
            ...tc,
            arguments: scrubRecord(tc.arguments, entitySink, (text, sink) =>
              this.scrubText(text, sink),
            ),
          })),
        };
      }
      return { ...m, content: nextContent };
    });
  }

  private scrubText(text: string, entitySink: PIIEntity[]): string {
    const { scrubbed, entities } = scrubPII(text);
    for (const e of entities) entitySink.push(e);
    return scrubbed;
  }
}

// ---------------------------------------------------------------------------
// Response rehydration — outside the class so it's easy to unit-test in
// isolation with no `LLMProvider` instance in hand.
// ---------------------------------------------------------------------------

export function rehydrateResponse(
  response: ChatResponse,
  entities: Array<{ token: string; value: string }>,
): ChatResponse {
  const content = response.content === '' ? response.content : rehydratePII(response.content, entities);
  const toolCalls: ToolCall[] = response.toolCalls.map((tc) => ({
    ...tc,
    arguments: rehydrateRecord(tc.arguments, entities),
  }));
  return { ...response, content, toolCalls };
}

function rehydrateRecord(
  value: Record<string, unknown>,
  entities: Array<{ token: string; value: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = rehydrateValue(v, entities);
  }
  return out;
}

function rehydrateValue(
  value: unknown,
  entities: Array<{ token: string; value: string }>,
): unknown {
  if (typeof value === 'string') return rehydratePII(value, entities);
  if (Array.isArray(value)) return value.map((v) => rehydrateValue(v, entities));
  if (value !== null && typeof value === 'object') {
    return rehydrateRecord(value as Record<string, unknown>, entities);
  }
  return value;
}

function scrubRecord(
  value: Record<string, unknown>,
  sink: PIIEntity[],
  scrub: (text: string, sink: PIIEntity[]) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = scrubValue(v, sink, scrub);
  }
  return out;
}

function scrubValue(
  value: unknown,
  sink: PIIEntity[],
  scrub: (text: string, sink: PIIEntity[]) => string,
): unknown {
  if (typeof value === 'string') return scrub(value, sink);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, sink, scrub));
  if (value !== null && typeof value === 'object') {
    return scrubRecord(value as Record<string, unknown>, sink, scrub);
  }
  return value;
}

// ---------------------------------------------------------------------------
// LLMProvider adapter — lets callers keep using `LLMProvider` interface
// without knowing about the router. Binds a task_type + persona at
// construction so `.chat(messages, options)` maps to the right route.
// ---------------------------------------------------------------------------

export interface RoutedLLMProviderOptions {
  router: LLMRouter;
  taskType: TaskType;
  /** Persona for the consent gate. `() => string | undefined` lets
   *  callers read live state (e.g. "current default persona") without
   *  rebuilding the provider on every persona switch. */
  persona?: string | (() => string | undefined);
  /** Provider label returned by `LLMProvider.name`. Used by telemetry;
   *  purely cosmetic. */
  label?: string;
}

export class RoutedLLMProvider implements LLMProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly router: LLMRouter;
  private readonly taskType: TaskType;
  private readonly personaRef: string | (() => string | undefined) | undefined;

  constructor(options: RoutedLLMProviderOptions) {
    this.router = options.router;
    this.taskType = options.taskType;
    this.personaRef = options.persona;
    this.name = options.label ?? `routed:${options.taskType}`;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const persona = typeof this.personaRef === 'function' ? this.personaRef() : this.personaRef;
    return this.router.chat({
      taskType: this.taskType,
      persona,
      messages,
      tools: options.tools,
      systemPrompt: options.systemPrompt,
      responseSchema: options.responseSchema,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: options.signal,
      // `ChatOptions.model` is a legacy override. The router normally
      // picks the tier-correct model; respecting `model` here keeps
      // callers that explicitly pinned a model (classifier's lite
      // override during the tier rollout) working.
      modelOverride: options.model,
    });
  }

  stream(): AsyncIterable<StreamChunk> {
    throw new Error(
      'RoutedLLMProvider.stream() is not implemented. Stream directly from the underlying adapter; the router is not a streaming surface yet.',
    );
  }

  embed(_text: string, _options?: EmbedOptions): Promise<EmbedResponse> {
    return Promise.reject(
      new Error(
        "RoutedLLMProvider.embed() is not supported. Embeddings go through Brain's embedding pipeline (registerLocalProvider / registerCloudProvider) — not the LLM router.",
      ),
    );
  }
}
