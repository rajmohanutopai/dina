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

import { CloudConsentError, rehydratePII } from '@dina/core';

import { getNameLexicon, type NameLexicon } from '../pii/names';
import { PII_TOKEN_NOTE, PiiSession } from '../pii/session';
import { getStrangerNames, type StrangerNames } from '../pii/strangers';

import { getProviderTiers } from './provider_config';
import {
  isFTSOnly,
  isLightweightTask,
  type ProviderName,
  type RouterConfig,
  type TaskType,
} from './router';

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

export interface LLMRouterOptions {
  /**
   * Per-provider LLMProvider instances. Keys must match `ProviderName`.
   * The router chooses which one to call based on `routeTask`'s
   * decision; the rest sit idle.
   */
  providers: Partial<Record<ProviderName, LLMProvider>>;
  config: RouterConfig;
  /**
   * The known names to hide (docs/PII_ARCHITECTURE_V2.md §5). Defaults to
   * the host's installed lexicon; with neither, patterns alone.
   */
  names?: NameLexicon;
  /**
   * Detection of names Dina does not know (§7). Defaults to the host's
   * installed one; hosts without a detector have none.
   */
  strangers?: StrangerNames;
  /**
   * Leave the model to the adapter (send no model id): for a raw adapter
   * already built with the operator's or owner's choice, which the router's
   * tier pick would otherwise replace (`routedProvider`).
   */
  keepAdapterModel?: boolean;
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

/**
 * Central router. Not an `LLMProvider` itself — it has a different
 * call shape (explicit `taskType`). Wrap it with `RoutedLLMProvider`
 * when you need the narrower `LLMProvider` surface.
 */
export class LLMRouter {
  private providers: Partial<Record<ProviderName, LLMProvider>>;
  private config: RouterConfig;
  private readonly names: NameLexicon | undefined;
  private readonly strangers: StrangerNames | undefined;
  private readonly keepAdapterModel: boolean;

  constructor(options: LLMRouterOptions) {
    this.providers = options.providers;
    this.config = options.config;
    this.names = options.names;
    this.strangers = options.strangers;
    this.keepAdapterModel = options.keepAdapterModel === true;
  }

  /**
   * Replace the single configured cloud provider with a new one.
   *
   * Mobile flips between cloud providers at runtime when the user
   * picks a different BYOK key in Settings. The change has to update
   * three things in lock-step: the provider instance the router can
   * call, the provider NAME (because `pickModel` reads it to choose a
   * provider-specific model), and `config.cloudProviders[0]` (because
   * that is what `pickProvider` reads to decide which entry to call).
   *
   * Any preserved `local` entry stays — local always wins over cloud
   * and we don't want a cloud-swap to remove a local LLM if one is
   * registered.
   */
  replaceCloudProvider(name: ProviderName, llm: LLMProvider): void {
    const next: Partial<Record<ProviderName, LLMProvider>> = {};
    if (this.providers.local !== undefined) {
      next.local = this.providers.local;
    }
    next[name] = llm;
    this.providers = next;
    this.config = { ...this.config, cloudProviders: [name] };
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

    const model = this.keepAdapterModel
      ? args.modelOverride
      : this.pickModel(args.taskType, providerName, args.modelOverride);

    // Scrub every message, tool argument and the system prompt going out to
    // a cloud provider through ONE session (docs/PII_ARCHITECTURE_V2.md §3-4),
    // so a value keeps one token across all of them and every token restores
    // to exactly one string on the way back.
    if (!requiresScrubbing) {
      return provider.chat(args.messages, {
        model,
        tools: args.tools,
        systemPrompt: args.systemPrompt,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        signal: args.signal,
        responseSchema: args.responseSchema,
      });
    }
    const lexicon = this.names ?? getNameLexicon();
    const strangers = this.strangers ?? getStrangerNames();
    const texts = textsNewestFirst(args);
    const session = new PiiSession(
      lexicon !== null && lexicon !== undefined ? await lexicon.current() : undefined,
      strangers !== null && strangers !== undefined ? await strangers.matcherFor(texts) : undefined,
    );
    // Tokens already anywhere in the call are set aside before any is minted.
    session.reserve(texts);
    const scrubbedMessages = this.scrubMessages(args.messages, session);
    let scrubbedSystemPrompt =
      args.systemPrompt !== undefined ? session.scrub(args.systemPrompt) : undefined;
    if (session.size > 0)
      scrubbedSystemPrompt =
        scrubbedSystemPrompt === undefined || scrubbedSystemPrompt === ''
          ? PII_TOKEN_NOTE
          : `${scrubbedSystemPrompt}\n\n${PII_TOKEN_NOTE}`;

    const response = await provider.chat(scrubbedMessages, {
      model,
      tools: args.tools,
      systemPrompt: scrubbedSystemPrompt,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
      responseSchema: args.responseSchema,
    });

    if (session.size === 0) return response;
    const restored = rehydrateResponse(response, session);
    session.clear();
    return restored;
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
    const isSensitive = persona !== undefined && this.config.sensitivePersonas.includes(persona);
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
    // `none`/`scripted` have no real model tiers — the scripted provider ignores
    // the model, so there is nothing to pick.
    if (providerName === 'none' || providerName === 'scripted') return undefined;
    const tiers = getProviderTiers(providerName);
    return isLightweightTask(taskType) ? tiers.lite : tiers.primary;
  }

  // -------------------------------------------------------------------------
  // PII scrub / rehydrate helpers
  // -------------------------------------------------------------------------

  private scrubMessages(messages: ChatMessage[], session: PiiSession): ChatMessage[] {
    return messages.map((m) => {
      const nextContent = m.content !== '' ? session.scrub(m.content) : '';
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
        return {
          ...m,
          content: nextContent,
          toolCalls: m.toolCalls.map((tc) => ({
            ...tc,
            arguments: session.scrubDeep(tc.arguments),
          })),
        };
      }
      return { ...m, content: nextContent };
    });
  }
}

// ---------------------------------------------------------------------------
// Response rehydration — outside the class so it's easy to unit-test in
// isolation with no `LLMProvider` instance in hand.
// ---------------------------------------------------------------------------

/**
 * Every string a call sends, newest first: the latest messages are the ones
 * not seen before (history repeats each turn), and the system prompt, mostly
 * fixed, comes last. Stranger detection spends its time budget in this order.
 */
function textsNewestFirst(args: RouterChatArgs): string[] {
  const out: string[] = [];
  const strings = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(strings);
  };
  for (let i = args.messages.length - 1; i >= 0; i--) {
    const m = args.messages[i] as ChatMessage;
    if (m.content !== '') out.push(m.content);
    for (const tc of m.toolCalls ?? []) strings(tc.arguments);
  }
  if (args.systemPrompt !== undefined && args.systemPrompt !== '') out.push(args.systemPrompt);
  return out;
}

/**
 * Restore tokens in a reply's text and every tool-call argument. Takes the
 * call's session, or (older callers and tests) a token list.
 */
export function rehydrateResponse(
  response: ChatResponse,
  table: PiiSession | { token: string; value: string }[],
): ChatResponse {
  const restore = (text: string): string =>
    Array.isArray(table) ? rehydratePII(text, table) : table.rehydrate(text);
  const content = response.content === '' ? response.content : restore(response.content);
  const toolCalls: ToolCall[] = response.toolCalls.map((tc) => ({
    ...tc,
    arguments: restoreValue(tc.arguments, restore) as Record<string, unknown>,
  }));
  return { ...response, content, toolCalls };
}

function restoreValue(value: unknown, restore: (text: string) => string): unknown {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) return value.map((v) => restoreValue(v, restore));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = restoreValue(v, restore);
    return out;
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

/** The ask pipeline's default sensitive personas (agentic_ask.ts); one source for both. */
export const DEFAULT_SENSITIVE_PERSONAS: readonly string[] = ['health', 'financial'];

/**
 * A raw model adapter behind the router, as a plain `LLMProvider`: for every
 * consumer outside the ask pipeline (the remember loop, the capability
 * runtime, the internal-Brain worker, PeerLens features). Hosts never hand a
 * consumer the raw adapter (docs/PII_ARCHITECTURE_V2.md §3).
 */
export function routedProvider(input: {
  llm: LLMProvider;
  providerName: ProviderName;
  taskType: TaskType;
  names?: NameLexicon;
  sensitivePersonas?: readonly string[];
  cloudConsentGranted?: boolean;
}): RoutedLLMProvider {
  const router = new LLMRouter({
    providers: { [input.providerName]: input.llm },
    config: {
      localAvailable: false,
      cloudProviders: [input.providerName],
      sensitivePersonas: [...(input.sensitivePersonas ?? DEFAULT_SENSITIVE_PERSONAS)],
      cloudConsentGranted: input.cloudConsentGranted ?? true,
    },
    ...(input.names !== undefined ? { names: input.names } : {}),
    // The adapter was built with the configured model; keep it.
    keepAdapterModel: true,
  });
  return new RoutedLLMProvider({
    router,
    taskType: input.taskType,
    label: `routed:${input.taskType}:${input.providerName}`,
  });
}
