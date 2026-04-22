/**
 * Task 5.53 — per-LLM-call latency + token metrics.
 *
 * Every outbound LLM call emits a structured metrics record with:
 *
 *   - **Identity**: provider, model, task type, persona tier.
 *   - **Latency**: wall-clock ms from request start to response
 *     (or error / timeout).
 *   - **Tokens**: input + output counts (provider-reported or
 *     fallback estimated).
 *   - **Cost**: optional, computed from a pricing table.
 *   - **Outcome**: `ok` / `failed` / `cancelled` / `timeout`.
 *   - **Request correlation**: `requestId` + `parentId` from
 *     `TraceContext` (task 5.58) so metrics join to logs by id.
 *
 * **Pattern** — scoped measurement via a `record()` factory:
 *
 * ```ts
 * const rec = measureLlmCall({provider: 'anthropic', model: 'claude-opus-4-7', taskType: 'reasoning', nowMsFn});
 * try {
 *   const resp = await callLlm(...);
 *   rec.complete({ inputTokens: resp.usage.input, outputTokens: resp.usage.output });
 * } catch (err) {
 *   rec.fail(err);
 * }
 * const entry = rec.done(); // finalised record
 * ```
 *
 * The caller decides where `entry` goes — pino logger, Prometheus
 * counter, OTEL exporter. The primitive just produces the record.
 *
 * **Token estimation fallback**: when a provider doesn't report
 * usage (older APIs, streaming with cost-lookup-off), the caller
 * can pass `inputText` / `outputText` and we estimate ~4 chars per
 * token (English average; close enough for budget tracking but
 * marked `estimated: true` for downstream accuracy checks).
 *
 * **Cost computation**: optional `pricing` table maps
 * `${provider}:${model}` to (input, output) per-million-token USD.
 * When present, `costUsd` is filled; when absent, left null.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5g task 5.53.
 */

export type LlmCallOutcome = 'ok' | 'failed' | 'cancelled' | 'timeout';

export interface LlmCallIdentity {
  provider: string;
  model: string;
  taskType: string;
  /** Optional — set for cloud routes where persona-tier gates apply. */
  personaTier?: 'default' | 'standard' | 'sensitive' | 'locked';
  /** Propagated from `TraceContext` (task 5.58). */
  requestId?: string;
  parentId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when counts come from character-based estimation, not provider-reported. */
  estimated: boolean;
}

/** `(inputPerMTok, outputPerMTok)` in USD. */
export type PricingEntry = readonly [number, number];

/** Maps `"${provider}:${model}"` → pricing. Case-insensitive on lookup. */
export type PricingTable = ReadonlyMap<string, PricingEntry>;

export interface LlmCallMetricsRecord extends LlmCallIdentity {
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  outcome: LlmCallOutcome;
  tokens: TokenUsage | null;
  /** USD cost, when the pricing table covered this model. */
  costUsd: number | null;
  /** Set on `outcome !== 'ok'`. Short, logger-safe message. */
  error: string | null;
  /** UTC ms of call start (for log timestamp alignment). */
  startedAtMs: number;
}

export interface MeasureLlmCallOptions extends LlmCallIdentity {
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Optional pricing table. */
  pricing?: PricingTable;
}

/** Handle returned by `measureLlmCall`. */
export interface LlmCallRecorder {
  /**
   * Mark the call successful + supply token usage. Pass either
   * provider-reported counts or `inputText`/`outputText` for
   * estimation.
   */
  complete(usage: CompleteInput): void;
  /** Mark the call failed with an error message. */
  fail(err: unknown): void;
  /** Mark the call cancelled by the caller (AbortSignal). */
  cancel(): void;
  /** Mark the call timed out. */
  timeout(): void;
  /**
   * Finalise + return the metrics record. Safe to call multiple
   * times — the first terminal call (complete/fail/cancel/timeout)
   * wins; subsequent are ignored.
   */
  done(): LlmCallMetricsRecord;
}

export type CompleteInput =
  | { inputTokens: number; outputTokens: number }
  | { inputText: string; outputText: string };

export const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Start measuring an LLM call. The returned recorder captures the
 * terminal state + token usage via one of the `complete`/`fail`/
 * `cancel`/`timeout` methods, then emits a frozen record via
 * `done()`.
 */
export function measureLlmCall(
  opts: MeasureLlmCallOptions,
): LlmCallRecorder {
  validateIdentity(opts);
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const pricing = opts.pricing;
  const startedAtMs = nowMsFn();

  let outcome: LlmCallOutcome | null = null;
  let tokens: TokenUsage | null = null;
  let error: string | null = null;
  let endedAtMs: number | null = null;

  const end = (next: LlmCallOutcome): void => {
    if (outcome !== null) return; // already terminal
    outcome = next;
    endedAtMs = nowMsFn();
  };

  return {
    complete(usage: CompleteInput): void {
      if (outcome !== null) return;
      tokens = computeUsage(usage);
      end('ok');
    },
    fail(err: unknown): void {
      if (outcome !== null) return;
      error = err instanceof Error ? err.message : String(err);
      end('failed');
    },
    cancel(): void {
      if (outcome !== null) return;
      error = 'cancelled';
      end('cancelled');
    },
    timeout(): void {
      if (outcome !== null) return;
      error = 'timeout';
      end('timeout');
    },
    done(): LlmCallMetricsRecord {
      if (outcome === null) {
        // Caller forgot to terminate — pessimistic default: failed.
        error = 'recorder finalised without a terminal state';
        end('failed');
      }
      const latencyMs = (endedAtMs ?? nowMsFn()) - startedAtMs;
      const costUsd = tokens && pricing ? computeCost(opts.provider, opts.model, tokens, pricing) : null;
      const record: LlmCallMetricsRecord = {
        provider: opts.provider,
        model: opts.model,
        taskType: opts.taskType,
        latencyMs,
        outcome: outcome!,
        tokens,
        costUsd,
        error,
        startedAtMs,
        ...(opts.personaTier !== undefined ? { personaTier: opts.personaTier } : {}),
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
        ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      };
      return Object.freeze(record);
    },
  };
}

/**
 * Build a log-field object (snake_case keys, primitives only) from
 * a metrics record — ready to pass as `log.info(fields, 'llm_call')`
 * for pino / structured loggers that expect flat key-value records.
 */
export function toLogFields(
  r: LlmCallMetricsRecord,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    provider: r.provider,
    model: r.model,
    task_type: r.taskType,
    outcome: r.outcome,
    latency_ms: r.latencyMs,
    started_at_ms: r.startedAtMs,
  };
  if (r.tokens) {
    out.input_tokens = r.tokens.inputTokens;
    out.output_tokens = r.tokens.outputTokens;
    out.total_tokens = r.tokens.inputTokens + r.tokens.outputTokens;
    out.tokens_estimated = r.tokens.estimated;
  }
  if (r.costUsd !== null) out.cost_usd = r.costUsd;
  if (r.error !== null) out.error = r.error;
  if (r.personaTier !== undefined) out.persona_tier = r.personaTier;
  if (r.requestId !== undefined) out.request_id = r.requestId;
  if (r.parentId !== undefined) out.parent_id = r.parentId;
  return out;
}

// ── Internals ──────────────────────────────────────────────────────────

function validateIdentity(opts: LlmCallIdentity): void {
  if (typeof opts?.provider !== 'string' || opts.provider.trim() === '') {
    throw new TypeError('measureLlmCall: provider is required');
  }
  if (typeof opts.model !== 'string' || opts.model.trim() === '') {
    throw new TypeError('measureLlmCall: model is required');
  }
  if (typeof opts.taskType !== 'string' || opts.taskType.trim() === '') {
    throw new TypeError('measureLlmCall: taskType is required');
  }
}

function computeUsage(usage: CompleteInput): TokenUsage {
  if ('inputTokens' in usage) {
    if (
      !Number.isInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isInteger(usage.outputTokens) ||
      usage.outputTokens < 0
    ) {
      throw new RangeError('measureLlmCall.complete: token counts must be non-negative integers');
    }
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimated: false,
    };
  }
  return {
    inputTokens: estimateTokens(usage.inputText),
    outputTokens: estimateTokens(usage.outputText),
    estimated: true,
  };
}

/** Character-based token estimation. ~4 chars/token is the English average. */
function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

function computeCost(
  provider: string,
  model: string,
  tokens: TokenUsage,
  pricing: PricingTable,
): number | null {
  const key = `${provider}:${model}`.toLowerCase();
  let entry = pricing.get(key);
  if (!entry) {
    // Try a case-insensitive linear lookup as a fallback.
    for (const [k, v] of pricing) {
      if (k.toLowerCase() === key) {
        entry = v;
        break;
      }
    }
  }
  if (!entry) return null;
  const [inputPerMTok, outputPerMTok] = entry;
  return (
    (tokens.inputTokens / 1_000_000) * inputPerMTok +
    (tokens.outputTokens / 1_000_000) * outputPerMTok
  );
}
