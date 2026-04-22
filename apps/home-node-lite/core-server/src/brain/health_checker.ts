/**
 * Task 5.5 — `/healthz` + `/readyz` health-check primitive.
 *
 * Kubernetes distinguishes two health signals:
 *
 *   - **liveness (`/healthz`)**: "is the process functional?"
 *     Answer yes as soon as the process is up + the event loop
 *     isn't wedged. Failing liveness → restart the pod.
 *   - **readiness (`/readyz`)**: "is the process ready to serve
 *     traffic?" Checks dependency reachability (Core, PDS, LLM
 *     providers, registries loaded). Failing readiness → stop
 *     sending traffic but don't restart.
 *
 * This module is the shared primitive both endpoints consume. It
 * runs a registered list of `CheckFn`s + assembles a structured
 * report the Fastify routes (once 5.4 + 5.5 land the server)
 * serialise.
 *
 * **Framework-free**: no Fastify, no Node HTTP. The brain-server
 * app will wrap this in a route. Tests invoke the primitive
 * directly.
 *
 * **Per-check timeout**: a hung dependency check doesn't stall
 * the probe. Each check has its own bound (default 2s) — beyond
 * that it's recorded as `timeout` and the overall probe proceeds.
 *
 * **Always-healthy liveness**: if a check is flagged
 * `kind: 'liveness'`, it counts toward the `/healthz` outcome;
 * all checks count toward `/readyz`. The typical wiring is one
 * liveness check (process is up — trivially true once `start()`
 * returned) plus many readiness checks.
 *
 * **Duration reporting**: each check's wall-clock duration lands
 * in the output for ops dashboards.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a task 5.5.
 */

export type CheckKind = 'liveness' | 'readiness' | 'both';

export interface CheckDefinition {
  /** Stable name used in the output + logs. */
  name: string;
  /** Which probe(s) this check feeds. */
  kind: CheckKind;
  /** The actual check. Resolves `{ok, detail?}` OR throws on failure. */
  run(signal?: AbortSignal): Promise<{ ok: true; detail?: string } | { ok: false; detail: string }>;
  /** Per-check timeout override. Default is the registry's. */
  timeoutMs?: number;
}

export interface CheckResult {
  name: string;
  kind: CheckKind;
  status: 'ok' | 'fail' | 'timeout' | 'error';
  detail: string;
  durationMs: number;
}

export interface ProbeReport {
  /** Overall status — ok when every relevant check is ok. */
  status: 'ok' | 'degraded';
  /** UTC ms when the probe started. */
  startedAtMs: number;
  durationMs: number;
  checks: CheckResult[];
}

export interface HealthCheckerOptions {
  /** Default per-check timeout. Default 2s. */
  defaultTimeoutMs?: number;
  /** Injectable clock. */
  nowMsFn?: () => number;
  /** Injectable timers — tests pass deterministic variants. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: HealthCheckerEvent) => void;
}

export type HealthCheckerEvent =
  | { kind: 'probe_started'; probe: 'liveness' | 'readiness'; checkCount: number }
  | { kind: 'check_ok'; name: string; durationMs: number }
  | { kind: 'check_failed'; name: string; detail: string; durationMs: number }
  | { kind: 'check_timeout'; name: string; timeoutMs: number }
  | { kind: 'check_threw'; name: string; error: string }
  | { kind: 'probe_finished'; probe: 'liveness' | 'readiness'; status: 'ok' | 'degraded' };

export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/**
 * Health checker. Register checks at boot, run `liveness()` /
 * `readiness()` per probe hit.
 */
export class HealthChecker {
  private readonly checks: Map<string, CheckDefinition> = new Map();
  private readonly defaultTimeoutMs: number;
  private readonly nowMsFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;
  private readonly onEvent?: (event: HealthCheckerEvent) => void;

  constructor(opts: HealthCheckerOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.setTimerFn =
      opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn =
      opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onEvent = opts.onEvent;
  }

  /** Register a check. Throws on duplicate name. */
  register(check: CheckDefinition): void {
    if (!check || typeof check !== 'object') {
      throw new TypeError('HealthChecker: check required');
    }
    if (typeof check.name !== 'string' || check.name === '') {
      throw new TypeError('HealthChecker: check.name required');
    }
    if (check.kind !== 'liveness' && check.kind !== 'readiness' && check.kind !== 'both') {
      throw new TypeError(
        `HealthChecker: check.kind must be liveness | readiness | both (got ${check.kind})`,
      );
    }
    if (typeof check.run !== 'function') {
      throw new TypeError('HealthChecker: check.run required');
    }
    if (this.checks.has(check.name)) {
      throw new Error(`HealthChecker: check "${check.name}" already registered`);
    }
    this.checks.set(check.name, check);
  }

  /** Remove a registered check. */
  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  /** Count of registered checks. */
  size(): number {
    return this.checks.size;
  }

  names(): string[] {
    return Array.from(this.checks.keys()).sort();
  }

  /**
   * Run the liveness probe — all `liveness` + `both` checks.
   * Returns `status: 'ok'` when every check passes.
   */
  async liveness(): Promise<ProbeReport> {
    return this.run('liveness', (c) => c.kind === 'liveness' || c.kind === 'both');
  }

  /**
   * Run the readiness probe — all `readiness` + `both` checks.
   */
  async readiness(): Promise<ProbeReport> {
    return this.run('readiness', (c) => c.kind === 'readiness' || c.kind === 'both');
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async run(
    probe: 'liveness' | 'readiness',
    filter: (c: CheckDefinition) => boolean,
  ): Promise<ProbeReport> {
    const startedAtMs = this.nowMsFn();
    const relevant = Array.from(this.checks.values()).filter(filter);
    this.onEvent?.({
      kind: 'probe_started',
      probe,
      checkCount: relevant.length,
    });
    // Run checks in parallel — probes are fan-out, not sequential.
    const results = await Promise.all(relevant.map((c) => this.runOne(c)));
    const status = results.every((r) => r.status === 'ok') ? 'ok' : 'degraded';
    const durationMs = this.nowMsFn() - startedAtMs;
    // Stable ordering for diff-friendly output.
    results.sort((a, b) => a.name.localeCompare(b.name));
    this.onEvent?.({ kind: 'probe_finished', probe, status });
    return { status, startedAtMs, durationMs, checks: results };
  }

  private async runOne(check: CheckDefinition): Promise<CheckResult> {
    const timeoutMs = check.timeoutMs ?? this.defaultTimeoutMs;
    const start = this.nowMsFn();
    const ac = new AbortController();
    let timerHandle: unknown = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerHandle = this.setTimerFn(() => {
        ac.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        check.run(ac.signal).then((r) => ({ kind: 'done' as const, r })),
        timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      ]);
      if (outcome.kind === 'timeout') {
        this.onEvent?.({
          kind: 'check_timeout',
          name: check.name,
          timeoutMs,
        });
        return {
          name: check.name,
          kind: check.kind,
          status: 'timeout',
          detail: `timed out after ${timeoutMs}ms`,
          durationMs: this.nowMsFn() - start,
        };
      }
      const durationMs = this.nowMsFn() - start;
      const r = outcome.r;
      if (r.ok) {
        this.onEvent?.({ kind: 'check_ok', name: check.name, durationMs });
        return {
          name: check.name,
          kind: check.kind,
          status: 'ok',
          detail: r.detail ?? '',
          durationMs,
        };
      }
      this.onEvent?.({
        kind: 'check_failed',
        name: check.name,
        detail: r.detail,
        durationMs,
      });
      return {
        name: check.name,
        kind: check.kind,
        status: 'fail',
        detail: r.detail,
        durationMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'check_threw', name: check.name, error: msg });
      return {
        name: check.name,
        kind: check.kind,
        status: 'error',
        detail: msg,
        durationMs: this.nowMsFn() - start,
      };
    } finally {
      if (timerHandle !== null) this.clearTimerFn(timerHandle);
    }
  }
}
