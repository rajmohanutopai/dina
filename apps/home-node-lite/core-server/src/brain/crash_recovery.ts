/**
 * Task 5.55 — Brain crash recovery.
 *
 * When the brain-server process restarts (planned redeploy, OOM
 * kill, SIGTERM), any in-flight work held purely in memory is lost.
 * Several primitives already persist their state to survive restart:
 *
 *   - `AskRegistry` (5.19) — request_id → status table.
 *   - `Scratchpad` (5.42) — multi-step reasoning checkpoints.
 *   - (Future) Guardian loop — no persistent state; stateless by design.
 *
 * This module is the **boot-time restore orchestrator** — it scans
 * every registered persistent primitive + brings each back to a safe
 * resume point. A Brain that restarts mid-ask must do three things:
 *
 *   1. **Discover** — enumerate persistent state that was live at
 *      shutdown.
 *   2. **Demote** — move in-flight records to a safe terminal or
 *      pending state so nothing looks like it's still running.
 *   3. **Report** — emit a structured summary the admin UI + ops
 *      dashboard can render: "recovered N asks, M scratchpads".
 *
 * **Why a separate orchestrator**: each primitive knows how to
 * restore *its own* state, but some cross-primitive consistency
 * rules only make sense at the orchestrator level (e.g. "if an ask
 * has a scratchpad, the scratchpad lingers for 24h as a resume
 * anchor; otherwise clear it"). The orchestrator also enforces a
 * strict ordering — asks restored before scratchpads, so the
 * scratchpad sweeper has canonical ask data to consult.
 *
 * **Pluggable participants**: a restore participant is any object
 * implementing `{ name, restore() }`. The orchestrator calls them
 * in registration order, collects per-participant results, and
 * emits a combined `RestoreReport`. Adding a new persistent
 * primitive just means registering another participant — no change
 * to the orchestrator itself.
 *
 * **Never throws** — a participant that fails its restore is
 * recorded in the report + the others continue. Refusing to boot
 * the brain just because a single sweep hit a transient error is
 * worse than booting with a known-bad compartment.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5h task 5.55.
 */

/** Per-participant restore result. */
export interface RestoreParticipantResult {
  name: string;
  /** True when the participant's restore finished cleanly. */
  ok: boolean;
  /** Count of records touched by the restore (demoted / cleared / reset). */
  recovered: number;
  /** Human-readable summary for logs / admin UI. */
  detail: string;
  durationMs: number;
}

/** Boot-time orchestrator report. */
export interface RestoreReport {
  /** All participant runs in registration order. */
  participants: RestoreParticipantResult[];
  /** Count of participants whose restore succeeded. */
  okCount: number;
  /** Count of participants whose restore failed. */
  failedCount: number;
  /** Total records touched across all participants. */
  totalRecovered: number;
  durationMs: number;
}

/** A participant's own restore contract. */
export interface RestoreParticipant {
  /** Stable id for logs + report fields. */
  name: string;
  /**
   * Run the participant's restore. May throw — the orchestrator
   * catches + records the failure. Return value is the count of
   * records touched + a human-readable detail string.
   */
  restore(): Promise<{ recovered: number; detail: string }>;
}

export type CrashRecoveryEvent =
  | { kind: 'started'; participantCount: number }
  | { kind: 'participant_ok'; name: string; recovered: number; durationMs: number }
  | { kind: 'participant_failed'; name: string; error: string; durationMs: number }
  | { kind: 'finished'; report: RestoreReport };

export interface CrashRecoveryOptions {
  /** Injectable clock — tests use a mock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: CrashRecoveryEvent) => void;
  /**
   * Per-participant timeout in ms. When exceeded, the participant
   * is marked failed + skipped. 0 disables timeouts. Default 30s —
   * long enough for a full `restoreOnStartup()` sweep on a busy
   * deployment but short enough that a truly stuck backend doesn't
   * block boot forever.
   */
  participantTimeoutMs?: number;
}

export const DEFAULT_PARTICIPANT_TIMEOUT_MS = 30_000;

/**
 * Orchestrates Brain boot-time state restore.
 *
 * Usage:
 * ```ts
 * const rec = new CrashRecoveryOrchestrator({ onEvent: log });
 * rec.register({ name: 'asks', restore: () => askRegistry.restoreOnStartup() });
 * rec.register({ name: 'scratchpad', restore: () => scratchpad.sweepStale() });
 * const report = await rec.run();
 * ```
 *
 * A participant whose restore takes longer than
 * `participantTimeoutMs` is marked `ok: false` + the orchestrator
 * proceeds to the next participant.
 */
export class CrashRecoveryOrchestrator {
  private readonly participants: RestoreParticipant[] = [];
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: CrashRecoveryEvent) => void;
  private readonly participantTimeoutMs: number;
  private hasRun = false;

  constructor(opts: CrashRecoveryOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
    this.participantTimeoutMs =
      opts.participantTimeoutMs ?? DEFAULT_PARTICIPANT_TIMEOUT_MS;
  }

  /**
   * Register a participant. Throws after `run()` has been called —
   * the orchestrator's work is a one-shot boot phase + late
   * registrations would silently be skipped.
   */
  register(p: RestoreParticipant): void {
    if (this.hasRun) {
      throw new Error(
        'CrashRecoveryOrchestrator: cannot register after run()',
      );
    }
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || p.name === '') {
      throw new TypeError(
        'CrashRecoveryOrchestrator: participant.name must be a non-empty string',
      );
    }
    if (typeof p.restore !== 'function') {
      throw new TypeError(
        `CrashRecoveryOrchestrator: participant "${p.name}" must have a restore() method`,
      );
    }
    if (this.participants.some((e) => e.name === p.name)) {
      throw new Error(
        `CrashRecoveryOrchestrator: duplicate participant name "${p.name}"`,
      );
    }
    this.participants.push(p);
  }

  /** Number of registered participants. */
  size(): number {
    return this.participants.length;
  }

  /**
   * Run every participant's restore in registration order. Returns a
   * structured report. Safe to call only once — subsequent calls
   * throw. Never propagates participant errors — they land in the
   * report.
   */
  async run(): Promise<RestoreReport> {
    if (this.hasRun) {
      throw new Error('CrashRecoveryOrchestrator: run() already called');
    }
    this.hasRun = true;
    const start = this.nowMsFn();
    this.onEvent?.({
      kind: 'started',
      participantCount: this.participants.length,
    });

    const results: RestoreParticipantResult[] = [];
    let okCount = 0;
    let failedCount = 0;
    let totalRecovered = 0;

    for (const p of this.participants) {
      const pStart = this.nowMsFn();
      try {
        const restorePromise = p.restore();
        const { recovered, detail } = this.participantTimeoutMs > 0
          ? await this.withTimeout(restorePromise, this.participantTimeoutMs, p.name)
          : await restorePromise;
        const durationMs = this.nowMsFn() - pStart;
        if (!Number.isInteger(recovered) || recovered < 0) {
          throw new Error(
            `participant "${p.name}" returned non-integer recovered count: ${recovered}`,
          );
        }
        results.push({
          name: p.name,
          ok: true,
          recovered,
          detail: typeof detail === 'string' ? detail : '',
          durationMs,
        });
        okCount++;
        totalRecovered += recovered;
        this.onEvent?.({
          kind: 'participant_ok',
          name: p.name,
          recovered,
          durationMs,
        });
      } catch (err) {
        const durationMs = this.nowMsFn() - pStart;
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          name: p.name,
          ok: false,
          recovered: 0,
          detail: `restore failed: ${msg}`,
          durationMs,
        });
        failedCount++;
        this.onEvent?.({
          kind: 'participant_failed',
          name: p.name,
          error: msg,
          durationMs,
        });
      }
    }

    const report: RestoreReport = {
      participants: results,
      okCount,
      failedCount,
      totalRecovered,
      durationMs: this.nowMsFn() - start,
    };
    this.onEvent?.({ kind: 'finished', report });
    return report;
  }

  private withTimeout<T>(
    p: Promise<T>,
    ms: number,
    name: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`participant "${name}" timed out after ${ms}ms`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
