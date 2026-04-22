/**
 * Health aggregator — combine multiple health checks into one status.
 *
 * Brain's `/readyz` endpoint surfaces "can I serve requests?" — that
 * answer depends on Core reachability + LLM-provider availability +
 * vault open state + background-loop health. Each concern produces
 * its own check; this primitive aggregates them into a single
 * top-level status plus per-check details for the admin UI.
 *
 * **Status ladder** (worst wins):
 *
 *   `up` < `degraded` < `down`
 *
 *   A single `down` check pulls the aggregate to `down`. At least
 *   one `degraded` (no `down`) pulls to `degraded`. All `up` → `up`.
 *
 * **Optional per-check criticality** — `critical: false` lets a
 * check count only as `degraded` when failing. Useful for "LLM
 * provider is flaky but Core still works" scenarios.
 *
 * **Pure function** — no IO, no state. Inputs in, result out.
 * Deterministic.
 *
 * **Output** mirrors a small `AggregateHealth` object the handler
 * serialises to JSON directly.
 */

export type HealthStatus = 'up' | 'degraded' | 'down';

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  /** Optional human-readable message. */
  detail?: string;
  /** When false, a `down` in this check only degrades the aggregate. Default true. */
  critical?: boolean;
  /** Optional latency in ms for observability. */
  latencyMs?: number;
}

export interface AggregateHealth {
  status: HealthStatus;
  /** Count per status across all checks. */
  counts: Record<HealthStatus, number>;
  /** Original per-check list in input order. */
  checks: HealthCheck[];
  /** Names of checks currently not `up`. */
  failingChecks: string[];
  /**
   * Human-readable summary for ops: "2/5 checks failing: core_reachable, llm_provider_anthropic".
   */
  summary: string;
}

export interface AggregateOptions {
  /** Treat a non-critical `down` as `degraded` in the aggregate. Default true. */
  demoteNonCritical?: boolean;
}

export class HealthAggregatorError extends Error {
  constructor(
    public readonly code: 'empty' | 'invalid_check' | 'duplicate_name',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HealthAggregatorError';
  }
}

/**
 * Aggregate `checks` into a single `AggregateHealth`. Throws
 * `HealthAggregatorError` on invalid input (no checks / bad shape).
 */
export function aggregateHealth(
  checks: ReadonlyArray<HealthCheck>,
  opts: AggregateOptions = {},
): AggregateHealth {
  if (!Array.isArray(checks)) {
    throw new HealthAggregatorError('empty', 'checks must be an array');
  }
  if (checks.length === 0) {
    throw new HealthAggregatorError('empty', 'at least one check required');
  }

  const demote = opts.demoteNonCritical ?? true;
  const seen = new Set<string>();
  const validated: HealthCheck[] = [];
  for (const [i, c] of checks.entries()) {
    if (!c || typeof c !== 'object') {
      throw new HealthAggregatorError('invalid_check', `checks[${i}]: object required`);
    }
    if (typeof c.name !== 'string' || c.name === '') {
      throw new HealthAggregatorError('invalid_check', `checks[${i}]: name required`);
    }
    if (c.status !== 'up' && c.status !== 'degraded' && c.status !== 'down') {
      throw new HealthAggregatorError('invalid_check', `checks[${i}]: invalid status`);
    }
    if (seen.has(c.name)) {
      throw new HealthAggregatorError('duplicate_name', `duplicate check name: ${c.name}`);
    }
    seen.add(c.name);
    const copy: HealthCheck = {
      name: c.name,
      status: c.status,
    };
    if (c.detail !== undefined) copy.detail = c.detail;
    if (c.critical !== undefined) copy.critical = c.critical;
    if (c.latencyMs !== undefined) copy.latencyMs = c.latencyMs;
    validated.push(copy);
  }

  const counts: Record<HealthStatus, number> = { up: 0, degraded: 0, down: 0 };
  let hasDownCritical = false;
  let hasDegraded = false;
  const failing: string[] = [];
  for (const c of validated) {
    const effective = effectiveStatus(c, demote);
    counts[c.status] += 1;
    if (c.status !== 'up') failing.push(c.name);
    if (effective === 'down') hasDownCritical = true;
    else if (effective === 'degraded') hasDegraded = true;
  }

  const status: HealthStatus = hasDownCritical
    ? 'down'
    : hasDegraded
      ? 'degraded'
      : 'up';

  const summary = renderSummary(status, validated, failing);
  return {
    status,
    counts,
    checks: validated,
    failingChecks: failing,
    summary,
  };
}

/** True when `a` is a worse status than `b`. */
export function isWorseStatus(a: HealthStatus, b: HealthStatus): boolean {
  return STATUS_ORDER[a] > STATUS_ORDER[b];
}

/** Compare two statuses, returning sort-compatible number. */
export function compareStatus(a: HealthStatus, b: HealthStatus): number {
  return STATUS_ORDER[a] - STATUS_ORDER[b];
}

// ── Internals ──────────────────────────────────────────────────────────

const STATUS_ORDER: Readonly<Record<HealthStatus, number>> = {
  up: 0,
  degraded: 1,
  down: 2,
};

function effectiveStatus(check: HealthCheck, demoteNonCritical: boolean): HealthStatus {
  const crit = check.critical !== false;
  if (check.status === 'down' && !crit && demoteNonCritical) return 'degraded';
  return check.status;
}

function renderSummary(
  status: HealthStatus,
  checks: ReadonlyArray<HealthCheck>,
  failing: ReadonlyArray<string>,
): string {
  if (status === 'up') {
    return `all ${checks.length} checks up`;
  }
  return `${failing.length}/${checks.length} checks failing: ${failing.join(', ')}`;
}
