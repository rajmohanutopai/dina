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
  /** Runs the Tier-0 deadline transition (reconcile + fence + invalidate +
   *  finalize) as ONE atomic commit (§5.1 "one atomic transition"). Default is a
   *  passthrough; boot passes `db.transaction` so a crash can never leave a
   *  partially-fenced run. The external crypto-shred / spool-ack runs AFTER the
   *  commit, idempotently, from the durable reservation records. */
  tx?: (fn: () => void) => void;
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
  private readonly tx: (fn: () => void) => void;

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
    this.tx = opts.tx ?? ((fn) => fn());
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
    // Deadline guard: NEVER force-terminate before `drain_deadline_at` — a
    // permissive drain's cause-retained work is still eligible until then (§5.1).
    // (The sweeper only calls this past the deadline; this self-guard makes a
    // direct/early call a safe no-op.)
    if (run.drain_deadline_at !== null && this.now() < run.drain_deadline_at) {
      return { terminated: false };
    }
    const terminal: 'cancelled' | 'expired' = run.drain_cause === 'expiry' ? 'expired' : 'cancelled';

    // The deadline transition is ONE atomic Tier-0 transaction (§5.1 "one atomic
    // transition"): reconcile claimed effects, fence the undecided/in-flight set
    // (+ cancel jobs), invalidate outstanding reservations, and finalize. ALL of
    // these are durable DB writes, so they commit or roll back together.
    //
    // The IRREVERSIBLE external effects (erasure-key destroy, spool ack) are
    // performed AFTER the commit — NEVER inside the tx. A destroy() is not
    // transactional: if it ran inside the tx and a later statement threw, SQLite
    // would roll back the released/finalized state while the key stays destroyed,
    // leaving a live held reservation whose ciphertext is irrecoverable (R2-09
    // adversarial finding). Instead the run is finalized durably first; the
    // post-commit shred is idempotent, and a crash in the post-commit gap is
    // re-driven by the boot recovery pass (shred the payloads of any run already
    // finalized-terminal — the finalized state IS the durable cleanup intent).
    let terminalState: RunState | undefined;
    const heldToDiscard: ReservationRecord[] = [];
    this.tx(() => {
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
      // 3. Invalidate outstanding reservations (DB) — collect the held ones so their
      //    ciphertext can be crypto-shredded AFTER the commit.
      const invalidated = this.reservations.invalidateOpen(runId, this.now());
      for (const res of invalidated) {
        if (res.state === 'held_by_lock') heldToDiscard.push(res);
      }
      // 4. Finalize the run (the durable terminal state = the cleanup intent).
      terminalState = this.runService.finalize(runId).state;
    });

    // Post-commit, idempotent, non-transactional external effects (§13). A crash
    // here leaves the run terminal but some ciphertext un-shredded; the boot
    // recovery pass re-shreds any finalized run's payloads.
    if (this.discardHeld !== undefined) {
      for (const res of heldToDiscard) this.discardHeld(res);
    }
    this.shredPayloads?.(runId);

    return { terminated: true, state: terminalState };
  }

  /**
   * The barrier-SET hook (§5.1 "Setting the barrier ... atomically invalidates
   * every outstanding uncommitted reservation ... crypto-shredded"). Wired to
   * fire from within the barrier transaction (RunService.applyTerminationCause /
   * AdmissionService produced-count commit), so it runs in that AMBIENT tx — it
   * does NOT open its own. The run stays `draining` (no finalize); cause-retained
   * CLAIMED work drains until `drain_deadline_at`, where forceTerminate finalizes.
   *
   * EVERY barrier invalidates outstanding reservations + crypto-shreds any held
   * ciphertext (R2-02 — permissive count/exhaustion/finish_pending too, not only
   * fencing). A FENCING barrier ADDITIONALLY fences the undecided/in-flight set +
   * cancels their classification jobs. Idempotent; a no-op on a non-draining run.
   */
  onBarrier(runId: string): { invalidated: number; fenced: number } {
    const run = this.runRepo.getById(runId);
    if (run === null || run.state !== 'draining' || run.drain_cause === null) {
      return { invalidated: 0, fenced: 0 };
    }
    const terminal: 'cancelled' | 'expired' = run.drain_cause === 'expiry' ? 'expired' : 'cancelled';
    let fencedCount = 0;
    // Fence the undecided/in-flight (unclaimed) set ONLY for a fencing cause;
    // a permissive drain lets decided/claimed work complete (§5.1).
    if (run.drain_strength === 'fencing') {
      const fenced = this.messages.fenceOpen(runId, terminal, this.now());
      if (this.fenceJob !== undefined) {
        for (const id of fenced) this.fenceJob(id, terminal);
      }
      fencedCount = fenced.length;
    }
    // Invalidate outstanding reservations for EVERY barrier + shred held ciphertext.
    const invalidated = this.reservations.invalidateOpen(runId, this.now());
    if (this.discardHeld !== undefined) {
      for (const res of invalidated) {
        if (res.state === 'held_by_lock') this.discardHeld(res);
      }
    }
    return { invalidated: invalidated.length, fenced: fencedCount };
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
  /** Supervises a sweep-tick exception so a transient repository error is logged
   *  rather than thrown out of the interval callback. */
  onError?: (err: unknown) => void;
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
  private stopped = false;
  private readonly onError: (err: unknown) => void;

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
    this.onError = opts.onError ?? (() => undefined);
  }

  /** One sweep pass (deterministic; tests call this directly). Pages over the
   *  DUE set (not the oldest-N active window) so a backlog of live-but-not-due
   *  runs can never starve a newer expired/past-deadline run. */
  runTick(): RunSweepReport {
    const nowMs = this.now();
    let expired = 0;
    let forceTerminated = 0;

    const PAGE = 500;
    for (;;) {
      const due = this.runRepo.listDueForSweep(nowMs, PAGE);
      if (due.length === 0) break;
      for (const run of due) {
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
      // Every returned run was transitioned OUT of the due set (barrier /
      // strengthen / finalize), so a short page is the last page.
      if (due.length < PAGE) break;
    }

    const reclaimed = this.reservations.reclaimLeaseExpired(nowMs);
    return { expired, force_terminated: forceTerminated, reservations_reclaimed: reclaimed };
  }

  start(): void {
    if (this.handle !== null) return;
    this.stopped = false;
    this.handle = this.setIntervalFn(() => {
      // Skip once stopped (a timer firing in the teardown gap must not mutate),
      // and supervise: a sweep exception is logged, never thrown out of the
      // interval callback where it would become an unhandled error.
      if (this.stopped) return;
      try {
        this.runTick();
      } catch (err) {
        this.onError(err);
      }
    }, this.intervalMs);
    (this.handle as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }
}
