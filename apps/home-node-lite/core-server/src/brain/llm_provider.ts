/**
 * Task 5.22 — Provider adapters (primitive layer).
 *
 * The Home Node Lite Brain's model-routing layer (tasks 5.24, 5.43)
 * picks WHICH provider to use. The provider ADAPTER is what
 * actually talks to the LLM service (Anthropic, Google, OpenRouter,
 * local llama). The real adapters live in `packages/brain/src/llm/
 * adapters/*.ts`.
 *
 * This module is the primitive layer that lets Home Node Lite-side
 * tests + the router work against a typed adapter interface
 * without depending on the real SDK adapters. It ships:
 *
 *   1. **`LlmProviderAdapter` interface** — the minimal contract
 *      every adapter satisfies: identity (id / displayName /
 *      isLocal) + `chat(input)` + `embed(input)`.
 *   2. **`ScriptedLlmProvider`** — test-friendly adapter that
 *      returns scripted responses. Unlimited configurability via
 *      per-call handlers.
 *   3. **`LlmProviderRegistry`** — a small multi-provider
 *      coordinator: register, list, pick by id, stats per
 *      provider, event stream.
 *
 * **Relationship to the real adapters**: the real Anthropic /
 * Gemini / OpenAI / OpenRouter adapters in `packages/brain`
 * implement the SAME shape. Brain-server (task 5.1) will register
 * those real adapters via `LlmProviderRegistry.register(instance)`
 * at boot.
 *
 * **Event-aware**: every call flows through `onCall` + `onResult`
 * events so metrics (task 5.53) + logger (5.52) can instrument
 * without knowing the specific adapter.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.22.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** 0..1. */
  temperature?: number;
  maxTokens?: number;
  /** For caller-level tracing. */
  requestId?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
}

export interface EmbedRequest {
  model: string;
  text: string;
  requestId?: string;
}

export interface EmbedResponse {
  embedding: number[];
  model: string;
  dimensions: number;
}

/**
 * The minimal provider contract. Adapters for Anthropic / Gemini /
 * OpenAI / local llama implement this.
 */
export interface LlmProviderAdapter {
  /** Stable id used by the router (`"anthropic"`, `"gemini"`, `"local"`). */
  readonly id: string;
  /** Human-readable name for admin UI. */
  readonly displayName: string;
  /** True when on-device (PII-safe). */
  readonly isLocal: boolean;

  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

// ══════════════════════════════════════════════════════════════════════
// ScriptedLlmProvider
// ══════════════════════════════════════════════════════════════════════

export type ScriptedChatHandler = (req: ChatRequest) => Promise<ChatResponse> | ChatResponse;
export type ScriptedEmbedHandler = (req: EmbedRequest) => Promise<EmbedResponse> | EmbedResponse;

export interface ScriptedLlmProviderOptions {
  id: string;
  displayName?: string;
  isLocal?: boolean;
  /** If omitted, returns `{content: '', toolCalls: [], …, finishReason: 'end'}`. */
  chatHandler?: ScriptedChatHandler;
  /** If omitted, returns a zeros embedding matching the requested model. */
  embedHandler?: ScriptedEmbedHandler;
  /** Default embedding dimensions when handler omitted. */
  defaultDimensions?: number;
}

/**
 * Scripted adapter — the default for tests. Production never wires
 * this directly. Callers script per-call responses via
 * `{chatHandler, embedHandler}` or accept the defaults (empty
 * responses / zero embeddings).
 */
export class ScriptedLlmProvider implements LlmProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  private readonly chatHandler: ScriptedChatHandler;
  private readonly embedHandler: ScriptedEmbedHandler;

  constructor(opts: ScriptedLlmProviderOptions) {
    if (typeof opts?.id !== 'string' || opts.id === '') {
      throw new TypeError('ScriptedLlmProvider: id is required');
    }
    this.id = opts.id;
    this.displayName = opts.displayName ?? opts.id;
    this.isLocal = opts.isLocal ?? false;
    const defaultDimensions = opts.defaultDimensions ?? 768;
    this.chatHandler =
      opts.chatHandler ??
      ((req) => ({
        content: '',
        toolCalls: [],
        model: req.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'end',
      }));
    this.embedHandler =
      opts.embedHandler ??
      ((req) => ({
        embedding: new Array(defaultDimensions).fill(0),
        model: req.model,
        dimensions: defaultDimensions,
      }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.chatHandler(req);
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return this.embedHandler(req);
  }
}

// ══════════════════════════════════════════════════════════════════════
// LlmProviderRegistry
// ══════════════════════════════════════════════════════════════════════

export interface RegisteredProviderInfo {
  id: string;
  displayName: string;
  isLocal: boolean;
}

export interface ProviderStats {
  chatCalls: number;
  chatFailures: number;
  embedCalls: number;
  embedFailures: number;
}

export type LlmProviderEvent =
  | { kind: 'registered'; id: string; isLocal: boolean }
  | { kind: 'unregistered'; id: string }
  | { kind: 'chat_started'; id: string; requestId: string | undefined }
  | { kind: 'chat_ok'; id: string; requestId: string | undefined; durationMs: number }
  | { kind: 'chat_failed'; id: string; requestId: string | undefined; error: string; durationMs: number }
  | { kind: 'embed_started'; id: string; requestId: string | undefined }
  | { kind: 'embed_ok'; id: string; requestId: string | undefined; dimensions: number }
  | { kind: 'embed_failed'; id: string; requestId: string | undefined; error: string };

export interface LlmProviderRegistryOptions {
  nowMsFn?: () => number;
  onEvent?: (event: LlmProviderEvent) => void;
}

/**
 * Registry + instrumented dispatch. Wrap each adapter on
 * registration; the registry owns per-provider stats so admin UI
 * can render "N calls, M failures per provider" without each
 * adapter having to track it.
 */
export class LlmProviderRegistry {
  private readonly adapters: Map<string, LlmProviderAdapter> = new Map();
  private readonly stats: Map<string, ProviderStats> = new Map();
  private readonly onEvent?: (event: LlmProviderEvent) => void;
  private readonly nowMsFn: () => number;

  constructor(opts: LlmProviderRegistryOptions = {}) {
    this.onEvent = opts.onEvent;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
  }

  register(adapter: LlmProviderAdapter): void {
    if (!adapter || typeof adapter !== 'object') {
      throw new TypeError('LlmProviderRegistry: adapter is required');
    }
    if (typeof adapter.id !== 'string' || adapter.id === '') {
      throw new TypeError('LlmProviderRegistry: adapter.id is required');
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`LlmProviderRegistry: id "${adapter.id}" already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    this.stats.set(adapter.id, {
      chatCalls: 0,
      chatFailures: 0,
      embedCalls: 0,
      embedFailures: 0,
    });
    this.onEvent?.({
      kind: 'registered',
      id: adapter.id,
      isLocal: adapter.isLocal,
    });
  }

  unregister(id: string): boolean {
    const existed = this.adapters.delete(id);
    if (existed) {
      this.stats.delete(id);
      this.onEvent?.({ kind: 'unregistered', id });
    }
    return existed;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  size(): number {
    return this.adapters.size;
  }

  get(id: string): LlmProviderAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  list(): RegisteredProviderInfo[] {
    return Array.from(this.adapters.values())
      .map((a) => ({ id: a.id, displayName: a.displayName, isLocal: a.isLocal }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  statsFor(id: string): ProviderStats | null {
    const s = this.stats.get(id);
    return s ? { ...s } : null;
  }

  allStats(): Record<string, ProviderStats> {
    const out: Record<string, ProviderStats> = {};
    for (const [id, s] of this.stats) out[id] = { ...s };
    return out;
  }

  /**
   * Dispatch a chat call to a specific provider. Throws
   * `ProviderNotFound` when the id is unknown; propagates the
   * adapter's own error otherwise (after event-stream + stats
   * bookkeeping).
   */
  async chat(id: string, req: ChatRequest): Promise<ChatResponse> {
    const adapter = this.mustGet(id);
    const stats = this.stats.get(id)!;
    const start = this.nowMsFn();
    this.onEvent?.({
      kind: 'chat_started',
      id,
      requestId: req.requestId,
    });
    try {
      const res = await adapter.chat(req);
      stats.chatCalls++;
      this.onEvent?.({
        kind: 'chat_ok',
        id,
        requestId: req.requestId,
        durationMs: this.nowMsFn() - start,
      });
      return res;
    } catch (err) {
      stats.chatFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({
        kind: 'chat_failed',
        id,
        requestId: req.requestId,
        error: msg,
        durationMs: this.nowMsFn() - start,
      });
      throw err;
    }
  }

  /** Dispatch an embed call. Same error-handling as `chat`. */
  async embed(id: string, req: EmbedRequest): Promise<EmbedResponse> {
    const adapter = this.mustGet(id);
    const stats = this.stats.get(id)!;
    this.onEvent?.({ kind: 'embed_started', id, requestId: req.requestId });
    try {
      const res = await adapter.embed(req);
      stats.embedCalls++;
      this.onEvent?.({
        kind: 'embed_ok',
        id,
        requestId: req.requestId,
        dimensions: res.dimensions,
      });
      return res;
    } catch (err) {
      stats.embedFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({
        kind: 'embed_failed',
        id,
        requestId: req.requestId,
        error: msg,
      });
      throw err;
    }
  }

  private mustGet(id: string): LlmProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new ProviderNotFoundError(id);
    }
    return adapter;
  }
}

export class ProviderNotFoundError extends Error {
  constructor(public readonly providerId: string) {
    super(`LlmProviderRegistry: no provider registered as "${providerId}"`);
    this.name = 'ProviderNotFoundError';
  }
}
