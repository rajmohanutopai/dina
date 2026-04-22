/**
 * Task 5.28 — token accounting + limits.
 *
 * Tracks LLM token usage per `(persona, provider, model)` and
 * enforces budget caps. The ledger serves three purposes:
 *
 *   1. **Cost control**: per-persona + per-provider daily/monthly
 *      caps stop a runaway agent from running up a provider bill.
 *   2. **Observability**: admin UI + /readyz report current usage
 *      + remaining budget.
 *   3. **Policy enforcement**: `consume()` returns `{ok: false}` when
 *      a request would exceed a cap, so the router falls back to a
 *      local model or fails the ask.
 *
 * **Limit types**:
 *   - `persona` — total tokens per persona per calendar period
 *   - `provider` — total tokens per provider per calendar period
 *   - `persona_provider` — the intersection (most specific)
 *
 * **Calendar periods**: daily (reset at 00:00 UTC) or monthly (reset
 * on the 1st). The period boundary is computed from `nowMsFn`, so
 * tests can drive determinism by advancing a fake clock past the
 * boundary.
 *
 * **Consume semantics**: `consume({persona, provider, model, input,
 * output})` returns `{ok: true, remaining: {...}}` when allowed, or
 * `{ok: false, reason, limit, consumed}` when a cap is hit. The
 * reservation is ATOMIC — if any cap would be exceeded, no counter
 * is incremented. Partial reservations (charge some caps, decline
 * the request) would leak tokens.
 *
 * **`preview()`** returns the current usage without mutating — for
 * pre-flight checks before calling the LLM.
 *
 * **Provider adapters** feed the ledger AFTER the LLM returns the
 * actual token counts (not the pre-flight estimate). The router's
 * policy is: estimate → preview → if ok, call LLM → consume with
 * actual counts.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.28.
 */

export type Period = 'daily' | 'monthly';

export interface TokenUsage {
  input: number;
  output: number;
  /** Sum of input + output — derivative, but cheap to precompute. */
  total: number;
}

export interface TokenLimit {
  /** Which limit type this applies to. */
  scope: 'persona' | 'provider' | 'persona_provider';
  /** Calendar period the cap resets on. */
  period: Period;
  /** Max `total` tokens (input + output) per period. */
  maxTotal: number;
  /** For `persona` scope: the persona name. */
  persona?: string;
  /** For `provider` scope: the provider name. */
  provider?: string;
}

export interface ConsumeInput {
  persona: string;
  provider: string;
  model: string;
  /** Actual tokens consumed (not an estimate). */
  input: number;
  output: number;
}

export type ConsumeRejection =
  | 'persona_limit'
  | 'provider_limit'
  | 'persona_provider_limit';

export interface RemainingByScope {
  persona?: number;
  provider?: number;
  persona_provider?: number;
}

export type ConsumeResult =
  | {
      ok: true;
      remaining: RemainingByScope;
    }
  | {
      ok: false;
      reason: ConsumeRejection;
      limit: number;
      consumed: number;
      attempted: number;
    };

export interface TokenLedgerOptions {
  limits: TokenLimit[];
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: TokenLedgerEvent) => void;
}

export type TokenLedgerEvent =
  | {
      kind: 'consumed';
      persona: string;
      provider: string;
      model: string;
      input: number;
      output: number;
    }
  | {
      kind: 'rejected';
      persona: string;
      provider: string;
      reason: ConsumeRejection;
      limit: number;
      attempted: number;
    }
  | { kind: 'period_reset'; scope: 'persona' | 'provider' | 'persona_provider'; period: Period; key: string };

/**
 * In-memory ledger. Same adapter-pattern posture as
 * `WorkflowPersistenceAdapter` / `AskPersistenceAdapter` — a
 * SQLCipher-backed variant can swap in later with the same surface.
 * Today the ledger is ephemeral; cost visibility across restarts
 * lands with storage-node.
 */
export class TokenLedger {
  private readonly limits: TokenLimit[];
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: TokenLedgerEvent) => void;

  /**
   * Buckets keyed by `${scope}::${key}::${period}::${boundary}`. The
   * `boundary` is the calendar slot id (e.g. `2026-04-22` for daily,
   * `2026-04` for monthly) so a clock tick past midnight naturally
   * starts a fresh bucket without explicit reset.
   */
  private readonly buckets = new Map<string, TokenUsage>();

  constructor(opts: TokenLedgerOptions) {
    this.limits = opts.limits.map(validateLimit);
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Preview current usage for a `(persona, provider)` pair without
   * mutating. Router calls this pre-LLM-call to decide "can this
   * possibly succeed?" before paying the provider latency.
   */
  preview(
    persona: string,
    provider: string,
  ): { usage: TokenUsage; remaining: RemainingByScope } {
    const now = this.nowMsFn();
    const usage = this.aggregateUsage(persona, provider, now);
    const remaining = this.computeRemaining(persona, provider, now);
    return { usage, remaining };
  }

  /**
   * Atomically record token usage + check every applicable limit.
   * If any limit would be exceeded, NO counter is incremented and
   * the rejection carries `{reason, limit, consumed, attempted}` for
   * actionable logging.
   */
  consume(input: ConsumeInput): ConsumeResult {
    validateConsumeInput(input);
    const now = this.nowMsFn();
    const total = input.input + input.output;

    // Pre-flight: walk every matching limit; if any would overflow,
    // return rejection without mutating.
    for (const lim of this.limits) {
      if (!this.limitApplies(lim, input.persona, input.provider)) continue;
      const key = this.bucketKey(lim, input.persona, input.provider, now);
      const current = this.buckets.get(key)?.total ?? 0;
      if (current + total > lim.maxTotal) {
        const reason = this.limitRejection(lim);
        this.onEvent?.({
          kind: 'rejected',
          persona: input.persona,
          provider: input.provider,
          reason,
          limit: lim.maxTotal,
          attempted: current + total,
        });
        return {
          ok: false,
          reason,
          limit: lim.maxTotal,
          consumed: current,
          attempted: current + total,
        };
      }
    }

    // All limits clear — commit. `persona_provider` also updates
    // the wider `persona` and `provider` scopes (and vice versa)
    // because each record contributes to every applicable bucket.
    for (const lim of this.limits) {
      if (!this.limitApplies(lim, input.persona, input.provider)) continue;
      const key = this.bucketKey(lim, input.persona, input.provider, now);
      const existing = this.buckets.get(key) ?? { input: 0, output: 0, total: 0 };
      this.buckets.set(key, {
        input: existing.input + input.input,
        output: existing.output + input.output,
        total: existing.total + total,
      });
    }

    this.onEvent?.({
      kind: 'consumed',
      persona: input.persona,
      provider: input.provider,
      model: input.model,
      input: input.input,
      output: input.output,
    });

    return { ok: true, remaining: this.computeRemaining(input.persona, input.provider, now) };
  }

  /**
   * Reset every bucket — useful for tests or for a "clear my budget"
   * admin operation. Does NOT emit per-bucket events (a reset is
   * wholesale, not periodic).
   */
  reset(): void {
    this.buckets.clear();
  }

  /** Snapshot of every live bucket. For admin UI + /readyz. */
  snapshot(): Array<{ key: string; usage: TokenUsage }> {
    return Array.from(this.buckets, ([key, usage]) => ({ key, usage: { ...usage } }));
  }

  // ── Internals ───────────────────────────────────────────────────────

  private aggregateUsage(
    persona: string,
    provider: string,
    now: number,
  ): TokenUsage {
    // Return usage from the most-specific matching bucket that has
    // an actual limit, so the caller sees "how much have I used
    // against the tightest budget". If no persona_provider limit
    // exists, fall back to provider, then persona.
    let best: TokenUsage = { input: 0, output: 0, total: 0 };
    for (const lim of this.limits) {
      if (!this.limitApplies(lim, persona, provider)) continue;
      const key = this.bucketKey(lim, persona, provider, now);
      const bucket = this.buckets.get(key);
      if (bucket && bucket.total > best.total) {
        best = { ...bucket };
      }
    }
    return best;
  }

  private computeRemaining(
    persona: string,
    provider: string,
    now: number,
  ): RemainingByScope {
    const out: RemainingByScope = {};
    for (const lim of this.limits) {
      if (!this.limitApplies(lim, persona, provider)) continue;
      const key = this.bucketKey(lim, persona, provider, now);
      const used = this.buckets.get(key)?.total ?? 0;
      const remaining = Math.max(0, lim.maxTotal - used);
      out[lim.scope] = remaining;
    }
    return out;
  }

  private limitApplies(
    lim: TokenLimit,
    persona: string,
    provider: string,
  ): boolean {
    switch (lim.scope) {
      case 'persona':
        return lim.persona === persona;
      case 'provider':
        return lim.provider === provider;
      case 'persona_provider':
        return lim.persona === persona && lim.provider === provider;
    }
  }

  private limitRejection(lim: TokenLimit): ConsumeRejection {
    switch (lim.scope) {
      case 'persona':
        return 'persona_limit';
      case 'provider':
        return 'provider_limit';
      case 'persona_provider':
        return 'persona_provider_limit';
    }
  }

  private bucketKey(
    lim: TokenLimit,
    persona: string,
    provider: string,
    nowMs: number,
  ): string {
    const boundary = periodBoundary(lim.period, nowMs);
    switch (lim.scope) {
      case 'persona':
        return `persona::${persona}::${lim.period}::${boundary}`;
      case 'provider':
        return `provider::${provider}::${lim.period}::${boundary}`;
      case 'persona_provider':
        return `persona_provider::${persona}:${provider}::${lim.period}::${boundary}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateLimit(lim: TokenLimit): TokenLimit {
  if (lim.maxTotal === undefined || !Number.isFinite(lim.maxTotal) || lim.maxTotal <= 0) {
    throw new Error(
      `TokenLedger: maxTotal must be a positive finite number (got ${lim.maxTotal})`,
    );
  }
  if (lim.period !== 'daily' && lim.period !== 'monthly') {
    throw new Error(
      `TokenLedger: period must be "daily" or "monthly" (got ${JSON.stringify(lim.period)})`,
    );
  }
  if (lim.scope === 'persona') {
    if (!lim.persona) {
      throw new Error('TokenLedger: scope=persona requires `persona`');
    }
  } else if (lim.scope === 'provider') {
    if (!lim.provider) {
      throw new Error('TokenLedger: scope=provider requires `provider`');
    }
  } else if (lim.scope === 'persona_provider') {
    if (!lim.persona || !lim.provider) {
      throw new Error(
        'TokenLedger: scope=persona_provider requires both `persona` and `provider`',
      );
    }
  } else {
    throw new Error(`TokenLedger: unknown scope ${JSON.stringify(lim.scope)}`);
  }
  return lim;
}

function validateConsumeInput(input: ConsumeInput): void {
  if (!input.persona) throw new Error('TokenLedger.consume: persona is required');
  if (!input.provider) throw new Error('TokenLedger.consume: provider is required');
  if (!input.model) throw new Error('TokenLedger.consume: model is required');
  if (!Number.isFinite(input.input) || input.input < 0) {
    throw new Error(`TokenLedger.consume: input must be >= 0 (got ${input.input})`);
  }
  if (!Number.isFinite(input.output) || input.output < 0) {
    throw new Error(`TokenLedger.consume: output must be >= 0 (got ${input.output})`);
  }
}

/**
 * Return the period boundary id for the given period + ms-since-epoch.
 * Daily: `YYYY-MM-DD`. Monthly: `YYYY-MM`. UTC.
 */
function periodBoundary(period: Period, ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'monthly') return `${y}-${m}`;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
