/**
 * Interactive-run service — the Core-owned authority over run lifecycle.
 *
 * docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §3/§5/§5.1/§12.5. Core is the sole
 * state-transition authority; this service composes the pure domain decisions
 * (`domain.ts`) with the durable store (`repository.ts`) inside a single per-run
 * transaction. Only the OWNER may create/steer a run — that boundary is enforced
 * at the route layer (server/routes/run.ts, §12.5); this service assumes an
 * already-authorized owner caller.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DrainCause,
  RunState,
  canPause,
  canResume,
  canStop,
  decideBarrier,
  isRunTerminal,
  strengthOfCause,
  terminalStateForCause,
  validateCreateParams,
  type BarrierState,
  type CreateRunParams,
  type ErasureMode,
  type OnStop,
  type RunRecord,
} from './domain';
import { probeErasureMode } from './erasure_store';
import {
  RunConflictError,
  type RunConfigPatch,
  type RunRepository,
} from './repository';

export interface RunServiceOptions {
  repository: RunRepository;
  nowMsFn?: () => number;
  /** Injectable id generator (tests pass a deterministic one). */
  idFn?: () => string;
  /** Freeze the platform crypto-shred guarantee at run creation (§13). The owner
   *  never supplies `erasure_mode` — Core probes the wired erasure backend so a
   *  caller can NOT claim `backup_resistant` without a conforming backend. */
  probeErasure?: () => ErasureMode;
  /** Invoked the moment ANY barrier is set (owner stop, count, exhaustion,
   *  expiry, or a strengthen), IN THE SAME transaction as the barrier row (§5.1
   *  "Setting the barrier ... atomically invalidates every outstanding uncommitted
   *  reservation"). Every barrier invalidates outstanding reservations; a FENCING
   *  barrier ALSO fences the undecided set + cancels jobs. The composition wires
   *  this to RunTerminationService.onBarrier; unwired, only the barrier row is set
   *  (the per-gate guards still prevent any fenced work from acting). */
  onBarrier?: (run: RunRecord) => void;
  /** Runs `applyBarrier` + the `onBarrier` hook as ONE atomic commit (§5.1). */
  tx?: (fn: () => void) => void;
}

export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

/** Result of a control command (§12.5): the resulting run state. */
export interface RunCommandResult {
  run_id: string;
  state: RunState;
}

export class RunService {
  private readonly repo: RunRepository;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly probeErasure: () => ErasureMode;
  private onBarrier?: (run: RunRecord) => void;
  private readonly tx: (fn: () => void) => void;

  constructor(opts: RunServiceOptions) {
    this.repo = opts.repository;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.nextId = opts.idFn ?? (() => `run-${bytesToHex(randomBytes(12))}`);
    this.probeErasure = opts.probeErasure ?? probeErasureMode;
    this.onBarrier = opts.onBarrier;
    this.tx = opts.tx ?? ((fn) => fn());
  }

  /** Wire the barrier hook after construction (breaks the RunService ↔
   *  RunTerminationService cycle at composition time). */
  setOnBarrier(fn: ((run: RunRecord) => void) | undefined): void {
    this.onBarrier = fn;
  }

  store(): RunRepository {
    return this.repo;
  }

  /**
   * Create a run (§5, §15.1). Idempotent by `idempotency_key`: a repeated
   * create that maps to an existing *live* run returns that run rather than
   * a conflict (durable owner-command idempotency, §12.5).
   */
  create(params: CreateRunParams): RunRecord {
    const nowMs = this.now();

    // Idempotency: an existing live run under this key is returned as-is.
    const existing = this.repo.getByIdempotencyKey(params.idempotency_key);
    if (existing !== null && !isRunTerminal(existing.state)) {
      return existing;
    }

    const seed = validateCreateParams(params, nowMs);
    const isPull = seed.transport === 'pull';

    const run: RunRecord = {
      run_id: this.nextId(),
      idempotency_key: seed.idempotency_key,
      service_uri: seed.service_uri,
      provider_did: seed.provider_did,
      persona: seed.persona,
      transport: seed.transport,
      push_grant_ref: seed.push_grant_ref,
      provider_grant_id: seed.provider_grant_id,
      provider_grant_expires_at_sec: seed.provider_grant_expires_at_sec,
      interval_ms: isPull ? seed.interval_ms : null,
      // pull mode: eligible to fetch immediately.
      next_fetch_at: isPull ? nowMs : null,
      queue_cap: seed.queue_cap,
      action_risk_ceiling: seed.action_risk_ceiling,
      priority_ceiling: seed.priority_ceiling,
      classify_timeout_ms: seed.classify_timeout_ms,
      muted: seed.muted,
      on_stop: seed.on_stop,
      // The frozen crypto-shred guarantee is the PROBED platform mode (§13/§20),
      // never a caller-supplied value — a caller can't over-claim backup_resistant.
      erasure_mode: this.probeErasure(),
      paused_reason: null,
      stop_on_command: seed.stop_on_command,
      max_count: seed.max_count,
      max_count_basis: seed.max_count_basis,
      stop_on_exhaustion: seed.stop_on_exhaustion,
      expires_at: seed.expires_at,
      drain_deadline_ms: seed.drain_deadline_ms,
      drain_deadline_at: null,
      drain_cause: null,
      drain_strength: null,
      config_version: 0,
      fetch_cursor: isPull ? 0 : null,
      last_commit_at: null,
      produced_count: 0,
      decided_count: 0,
      state: 'active',
      created_at: nowMs,
      updated_at: nowMs,
    };

    try {
      this.repo.create(run);
    } catch (err) {
      if (err instanceof RunConflictError && err.code === 'duplicate_idempotency') {
        // Lost a race — return the run that won.
        const won = this.repo.getByIdempotencyKey(params.idempotency_key);
        if (won !== null) return won;
      }
      throw err;
    }
    return run;
  }

  get(runId: string): RunRecord | null {
    return this.repo.getById(runId);
  }

  /** `pause` — only `active → paused`; retains everything, cancels nothing.
   *  Out-of-state is an idempotent no-op returning the current state (§12). */
  pause(runId: string): RunCommandResult {
    const run = this.requireRun(runId);
    if (canPause(run.state)) {
      this.repo.pause(runId, this.now());
    }
    return this.currentResult(runId);
  }

  /** `resume` — only `paused → active`; never restores authorization or
   *  weakens a barrier on any other state (§12). */
  resume(runId: string): RunCommandResult {
    const run = this.requireRun(runId);
    if (canResume(run.state)) {
      this.repo.resume(runId, this.now());
    }
    // Round-A A-03 (§7) — resume on an ACTIVE run paused by `response_lost` is
    // the owner's "wait for the provider's retry" choice: clear the pause so
    // fetch re-polls the un-advanced cursor; the provider's replayed response
    // re-fills the lost position through the normal admission commit (which
    // then terminal-skips the stale lost row). The grant pause is NOT cleared
    // here — it lifts only when `/update` rebinds a valid grant (§10).
    if (run.state === 'active' && run.paused_reason === 'response_lost') {
      this.repo.setPausedReason(runId, null, this.now());
    }
    return this.currentResult(runId);
  }

  /**
   * `stop` (§5.1, §12.5). Version-unconditional but state-gated. Opens a
   * termination barrier whose cause is derived from `on_stop`
   * (`cancel_pending`→fencing, `finish_pending`→permissive); a `cancel_pending`
   * stop may *strengthen* an in-progress permissive drain. A terminal run is a
   * no-op. The `on_stop` override lets the owner choose the disposition at stop
   * time; absent an override the run's configured `on_stop` is used.
   */
  stop(runId: string, onStopOverride?: OnStop): RunCommandResult {
    const run = this.requireRun(runId);
    if (!canStop(run.state)) {
      return this.currentResult(runId);
    }
    const onStop = onStopOverride ?? run.on_stop;
    const cause: DrainCause = onStop === 'finish_pending' ? 'finish_pending' : 'cancel_pending';
    this.applyTerminationCause(run, cause);
    return this.currentResult(runId);
  }

  /**
   * Apply a termination cause to a run (§5.1), shared by stop and — in later
   * slices — count/exhaustion/expiry. Monotonic strengthen-only: uses the pure
   * `decideBarrier` to compute the transition, then persists it. Returns the
   * effective barrier, or null if the cause was a no-op / the run is terminal.
   */
  applyTerminationCause(run: RunRecord, cause: DrainCause): BarrierState | null {
    if (isRunTerminal(run.state)) return null;
    const nowMs = this.now();

    // Decide + apply the barrier from the CURRENT committed row, re-read INSIDE the
    // transaction (NEW-01): the caller's `run` snapshot may be stale — a stronger
    // barrier (e.g. a fencing expiry) may have committed since it was fetched.
    // `applyBarrier` overwrites unconditionally, so deciding strengthen-only from a
    // stale snapshot could WEAKEN a committed fencing barrier to permissive,
    // violating §5.1's monotonic strengthen-only invariant. Deciding from the fresh
    // in-tx state closes that race.
    let result: BarrierState | null = null;
    this.tx(() => {
      const fresh = this.repo.getById(run.run_id);
      if (fresh === null || isRunTerminal(fresh.state)) return;
      const current: BarrierState | null =
        fresh.drain_cause !== null && fresh.drain_strength !== null && fresh.drain_deadline_at !== null
          ? { cause: fresh.drain_cause, strength: fresh.drain_strength, deadline_at: fresh.drain_deadline_at }
          : null;
      const decision = decideBarrier(current, cause, nowMs + fresh.drain_deadline_ms);
      if (decision.kind === 'noop') {
        result = current;
        return;
      }
      // Apply the barrier row AND the invalidation/fencing hook as ONE atomic
      // commit (§5.1). EVERY barrier invalidates outstanding reservations; a
      // fencing barrier also fences the undecided set + cancels jobs.
      const applied = this.repo.applyBarrier(
        fresh.run_id,
        decision.barrier.cause,
        decision.barrier.strength,
        decision.barrier.deadline_at,
        nowMs,
      );
      if (applied) {
        result = decision.barrier;
        if (this.onBarrier !== undefined) {
          const updated = this.repo.getById(fresh.run_id);
          if (updated !== null) this.onBarrier(updated);
        }
      } else {
        result = current;
      }
    });
    return result;
  }

  /**
   * Force-terminate a draining run (§5.1). Resolves to the absorbing terminal
   * state implied by the drain cause. Idempotent — a no-op on a non-draining run.
   */
  finalize(runId: string): RunCommandResult {
    const run = this.repo.getById(runId);
    if (run === null) throw new RunNotFoundError(runId);
    if (run.state === 'draining' && run.drain_cause !== null) {
      this.repo.finalize(runId, terminalStateForCause(run.drain_cause), this.now());
    }
    return this.currentResult(runId);
  }

  /** Owner config change (§12.5), gated on `config_version`. Returns the new
   *  version, or null on a version mismatch. An interval change recomputes
   *  `next_fetch_at = max(now, last_commit_at + new_interval)` on a pull run (§11)
   *  using the run's own clock, so a shorter cadence takes effect this cycle
   *  instead of only after the next stale fetch. */
  updateConfig(runId: string, patch: RunConfigPatch, expectedConfigVersion: number): number | null {
    const run = this.requireRun(runId);
    const nowMs = this.now();
    // Anchor the recompute on the last commit (§11 formula). A run that has never
    // fetched has a pending first fetch at its current `next_fetch_at`; an
    // interval change must NOT delay that first fetch — so recompute only once a
    // commit exists to anchor from.
    const effective: RunConfigPatch =
      patch.interval_ms !== undefined && run.transport === 'pull' && run.last_commit_at !== null
        ? { ...patch, next_fetch_at: Math.max(nowMs, run.last_commit_at + patch.interval_ms) }
        : patch;
    return this.repo.updateConfig(runId, effective, expectedConfigVersion, nowMs);
  }

  private requireRun(runId: string): RunRecord {
    const run = this.repo.getById(runId);
    if (run === null) throw new RunNotFoundError(runId);
    return run;
  }

  private currentResult(runId: string): RunCommandResult {
    const run = this.repo.getById(runId);
    if (run === null) throw new RunNotFoundError(runId);
    return { run_id: run.run_id, state: run.state };
  }
}

// Re-export a couple of pure helpers callers commonly need alongside the service.
export { RunState, strengthOfCause, terminalStateForCause, DEFAULT_DRAIN_DEADLINE_MS };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: RunService | null = null;

export function setRunService(s: RunService | null): void {
  instance = s;
}

export function getRunService(): RunService | null {
  return instance;
}
