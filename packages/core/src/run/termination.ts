/**
 * Termination + the `drain_deadline_at` force-terminate + the run sweeper
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §5.1/§11/§13).
 *
 * Every termination passes through `draining`; at `drain_deadline_at` ONE atomic
 * transition force-terminates: still-undecided / classification_pending /
 * risk_pending / risk_authorized / unclaimed dispatch_pending → cancelled
 * (stop/count/exhaustion) or expired (expiry); every already-claimed
 * (sending/dispatched) non-terminal delegation → outcome_unknown; classification
 * jobs cancelled; outstanding reservations invalidated (+ held blobs
 * crypto-shredded); the run becomes terminal and terminal payload crypto-shred
 * is scheduled. The sweeper drives expiry (set the barrier when a run passes its
 * hard TTL) and the deadline force-terminate; it is NOT the completion
 * advancement path (that is event-driven with its own recovery pass, §6.2).
 */

import { getMessageRepository, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRecord, type ReservationRepository } from './reservation';
import { RunService, type RunState } from './service';

export interface ForceTerminateResult {
  terminated: boolean;
  state?: RunState;
}

export interface RunTerminationServiceOptions {
  runRepo?: RunRepository;
  runService: RunService;
  messageRepo?: MessageRepository;
  reservationRepo?: ReservationRepository;
  nowMsFn?: () => number;
  /** Cancel a fenced message's classification job (§12.6). */
  fenceClassificationJob?: (messageId: string, terminal: 'cancelled' | 'expired') => void;
  /** Reconcile a claimed (sending/dispatched) message → outcome_unknown, or
   *  advance a verified_pending receipt that arrived before the deadline (§6.2). */
  reconcileClaimed?: (messageId: string) => void;
  /** Crypto-shred + ack a held_by_lock reservation's staged blob (§7/ISVC-6). */
  discardHeld?: (reservation: ReservationRecord) => void;
  /** Schedule terminal payload crypto-shred for the run (§13). */
  shredPayloads?: (runId: string) => void;
}

export class RunTerminationService {
  private readonly runRepo: RunRepository;
  private readonly runService: RunService;
  private readonly messages: MessageRepository;
  private readonly reservations: ReservationRepository;
  private readonly now: () => number;
  private readonly fenceJob?: (messageId: string, terminal: 'cancelled' | 'expired') => void;
  private readonly reconcileClaimed?: (messageId: string) => void;
  private readonly discardHeld?: (reservation: ReservationRecord) => void;
  private readonly shredPayloads?: (runId: string) => void;

  constructor(opts: RunTerminationServiceOptions) {
    const runRepo = opts.runRepo ?? getRunRepository();
    const messages = opts.messageRepo ?? getMessageRepository();
    const reservations = opts.reservationRepo ?? getReservationRepository();
    if (runRepo === null || messages === null || reservations === null) {
      throw new Error('RunTerminationService: run + message + reservation repositories must be wired');
    }
    this.runRepo = runRepo;
    this.runService = opts.runService;
    this.messages = messages;
    this.reservations = reservations;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.fenceJob = opts.fenceClassificationJob;
    this.reconcileClaimed = opts.reconcileClaimed;
    this.discardHeld = opts.discardHeld;
    this.shredPayloads = opts.shredPayloads;
  }

  /**
   * The `drain_deadline_at` force-terminate (§5.1). Only fires on a `draining`
   * run. Fences the undecided/in-flight set, reconciles claimed effects, cancels
   * classification jobs, invalidates outstanding reservations, finalizes the run,
   * and schedules payload crypto-shred.
   */
  forceTerminate(runId: string): ForceTerminateResult {
    const run = this.runRepo.getById(runId);
    if (run === null || run.state !== 'draining' || run.drain_cause === null) {
      return { terminated: false };
    }
    const terminal: 'cancelled' | 'expired' = run.drain_cause === 'expiry' ? 'expired' : 'cancelled';

    // 1. Reconcile already-CLAIMED effects (sending/dispatched → outcome_unknown,
    //    or advance a pre-deadline verified_pending receipt).
    if (this.reconcileClaimed !== undefined) {
      for (const msg of this.messages.listByRun(runId)) {
        if (msg.state === 'sending' || msg.state === 'dispatched') this.reconcileClaimed(msg.message_id);
      }
    }

    // 2. Fence the still-undecided / in-flight set (+ cancel their jobs).
    const fenced = this.messages.fenceOpen(runId, terminal, this.now());
    if (this.fenceJob !== undefined) {
      for (const id of fenced) this.fenceJob(id, terminal);
    }

    // 3. Invalidate outstanding reservations (+ discard held blobs, no decryption).
    const invalidated = this.reservations.invalidateOpen(runId, this.now());
    if (this.discardHeld !== undefined) {
      for (const res of invalidated) {
        if (res.state === 'held_by_lock') this.discardHeld(res);
      }
    }

    // 4. Finalize the run → its terminal state (revokes authorization).
    const result = this.runService.finalize(runId);

    // 5. Schedule terminal payload crypto-shred.
    this.shredPayloads?.(runId);

    return { terminated: true, state: result.state };
  }
}

// ---------------------------------------------------------------------------
// The run sweeper (reuses the workflow-sweeper shape: injectable clock, runTick,
// idempotent start/stop). NOT the completion advancement path (§6.2).
// ---------------------------------------------------------------------------

export interface RunSweeperOptions {
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
  runService: RunService;
  termination: RunTerminationService;
  nowMsFn?: () => number;
  intervalMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
}

export interface RunSweepReport {
  expired: number;
  force_terminated: number;
  reservations_reclaimed: number;
}

export class RunSweeper {
  private readonly runRepo: RunRepository;
  private readonly reservations: ReservationRepository;
  private readonly runService: RunService;
  private readonly termination: RunTerminationService;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RunSweeperOptions) {
    const runRepo = opts.runRepo ?? getRunRepository();
    const reservations = opts.reservationRepo ?? getReservationRepository();
    if (runRepo === null || reservations === null) {
      throw new Error('RunSweeper: run + reservation repositories must be wired');
    }
    this.runRepo = runRepo;
    this.reservations = reservations;
    this.runService = opts.runService;
    this.termination = opts.termination;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  /** One sweep pass (deterministic; tests call this directly). */
  runTick(): RunSweepReport {
    const nowMs = this.now();
    let expired = 0;
    let forceTerminated = 0;

    for (const run of this.runRepo.listActive()) {
      // (a) Past the hard TTL: open the fencing expiry barrier on an
      //     active OR PAUSED run (VERIF #7), or STRENGTHEN a draining-permissive
      //     run to expiry so it finalizes as `expired`, not mislabeled, and no
      //     longer lingers past its TTL (VERIF #9).
      if (nowMs >= run.expires_at) {
        if (run.state === 'active' || run.state === 'paused') {
          this.runService.applyTerminationCause(run, 'expiry');
          expired++;
        } else if (run.state === 'draining' && run.drain_strength === 'permissive') {
          this.runService.applyTerminationCause(run, 'expiry'); // strengthen → fencing
          expired++;
        }
      }
      // (b) Force-terminate a draining run past its deadline. (Re-read state:
      //     a run may have just been strengthened above.)
      const cur = this.runRepo.getById(run.run_id);
      if (
        cur !== null &&
        cur.state === 'draining' &&
        cur.drain_deadline_at !== null &&
        nowMs >= cur.drain_deadline_at
      ) {
        if (this.termination.forceTerminate(cur.run_id).terminated) forceTerminated++;
      }
    }

    const reclaimed = this.reservations.reclaimLeaseExpired(nowMs);
    return { expired, force_terminated: forceTerminated, reservations_reclaimed: reclaimed };
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => {
      this.runTick();
    }, this.intervalMs);
    (this.handle as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }
}
