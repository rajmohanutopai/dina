/**
 * Admission + pacing — the atomic bounded queue
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§8).
 *
 * PULL flow: `reserve()` opens a `reserved` slot only when EVERY gate holds
 * (run active, before hard TTL, cadence elapsed, a free slot, count budget,
 * persona open, provider grant for a protected service). `commit()` is the
 * barrier-guarded enqueue-commit CAS: it commits the reservation AND advances
 * produced_count + fetch_cursor + next_fetch_at in ONE Tier-0 transaction; a
 * barrier/TTL that raced in makes the CAS fail, the transaction rolls back, the
 * slot is released, and nothing is enqueued (no cursor advance after a
 * stop/expiry, §8).
 *
 *   outstanding = enqueued_undecided + open_reservations (reserved + held_by_lock)
 *
 * Push admission (no pre-opened slot, the full §7.1 gate set) reuses the same
 * commit CAS and is layered on in the push slices. This service handles PULL.
 */

import { type RunRecord } from './domain';
import { getRunRepository, type RunRepository } from './repository';
import {
  getReservationRepository,
  type CommitReservationInput,
  type ReservationRecord,
  type ReservationRepository,
} from './reservation';

/** Why a reserve attempt was rejected (surfaced as the derived fetch-paused
 *  condition; §7). `past_ttl` additionally signals the caller (ISVC-7 sweeper)
 *  to set the expiry barrier. */
export type ReserveRejection =
  | 'not_active'
  | 'past_ttl'
  | 'cadence_not_elapsed'
  | 'queue_full'
  | 'count_exhausted'
  | 'persona_locked'
  | 'grant_unavailable';

export type ReserveResult =
  | { ok: true; reservation_id: string; cursor: number }
  | { ok: false; reason: ReserveRejection };

export type CommitResult =
  | { committed: true }
  | { committed: false; reason: 'reservation_not_open' | 'run_missing' | 'barrier_or_ttl_raced' };

/** Counts the admission gate needs that live in stores wired by later slices. */
export interface AdmissionCounts {
  /** Messages in enqueued/classification_pending/classified (ISVC-4). */
  enqueuedUndecided(runId: string): number;
}

export interface AdmissionServiceOptions {
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
  /** Runs a set of single-statement store ops atomically (rollback on throw).
   *  Default = a passthrough (no rollback) — pass the SQLite `db.transaction`
   *  for real enqueue-commit atomicity. */
  tx?: (fn: () => void) => void;
  counts?: AdmissionCounts;
  /** Whether the run's persona is currently open (§7). Default: always open. */
  isPersonaOpen?: (persona: string) => boolean;
  nowMsFn?: () => number;
  idFn?: () => string;
  /** Reservation lease window (ms). Lease-expired `reserved` rows are reclaimed
   *  by the sweeper (ISVC-7); `held_by_lock` is never lease-reclaimed (§7). */
  leaseMs?: number;
}

const ABORT = Symbol('admission-abort');

export class AdmissionService {
  private readonly runRepo: RunRepository;
  private readonly resRepo: ReservationRepository;
  private readonly tx: (fn: () => void) => void;
  private readonly counts: AdmissionCounts;
  private readonly personaOpen: (persona: string) => boolean;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly leaseMs: number;
  private seq = 0;

  constructor(opts: AdmissionServiceOptions = {}) {
    const runRepo = opts.runRepo ?? getRunRepository();
    const resRepo = opts.reservationRepo ?? getReservationRepository();
    if (runRepo === null || resRepo === null) {
      throw new Error('AdmissionService: run + reservation repositories must be wired');
    }
    this.runRepo = runRepo;
    this.resRepo = resRepo;
    this.tx = opts.tx ?? ((fn) => fn());
    this.counts = opts.counts ?? { enqueuedUndecided: () => 0 };
    this.personaOpen = opts.isPersonaOpen ?? (() => true);
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.nextId = opts.idFn ?? (() => `res-${(++this.seq).toString(36)}-${this.now().toString(36)}`);
    this.leaseMs = opts.leaseMs ?? 120_000;
  }

  /** `outstanding` (§7), re-derivable on restart. */
  outstanding(runId: string): number {
    return this.counts.enqueuedUndecided(runId) + this.resRepo.countOpen(runId);
  }

  /**
   * Try to open a PULL admission slot (§7). Evaluates every gate; on success
   * inserts a `reserved` reservation at the run's current fetch_cursor and
   * returns it. The caller then fetches and calls {@link commit}.
   */
  reserve(runId: string): ReserveResult {
    const run = this.runRepo.getById(runId);
    if (run === null) return { ok: false, reason: 'not_active' };
    const nowMs = this.now();

    if (run.state !== 'active') return { ok: false, reason: 'not_active' };
    if (nowMs >= run.expires_at) return { ok: false, reason: 'past_ttl' };
    if (run.next_fetch_at !== null && nowMs < run.next_fetch_at) {
      return { ok: false, reason: 'cadence_not_elapsed' };
    }

    const open = this.resRepo.countOpen(runId);
    const outstanding = this.counts.enqueuedUndecided(runId) + open;
    if (outstanding >= run.queue_cap) return { ok: false, reason: 'queue_full' };

    if (!this.withinCountBudget(run, open, outstanding)) {
      return { ok: false, reason: 'count_exhausted' };
    }
    if (!this.personaOpen(run.persona)) return { ok: false, reason: 'persona_locked' };
    if (!this.providerGrantValid(run, nowMs)) return { ok: false, reason: 'grant_unavailable' };

    const reservationId = this.nextId();
    this.resRepo.create({
      reservation_id: reservationId,
      run_id: runId,
      cursor: run.fetch_cursor ?? 0,
      state: 'reserved',
      message_id: null,
      dedup_key: null,
      content_digest: null,
      sealed_response_ref: null,
      error_reason: null,
      error_at: null,
      lease_expires_at: nowMs + this.leaseMs,
      query_correlation_id: null,
      created_at: nowMs,
      updated_at: nowMs,
    });
    return { ok: true, reservation_id: reservationId, cursor: run.fetch_cursor ?? 0 };
  }

  /**
   * The barrier-guarded enqueue-commit CAS (§7/§8). Commits the reservation AND
   * advances the run's produced_count + fetch_cursor + next_fetch_at atomically.
   * A barrier/TTL that landed in-flight makes the CAS fail: the transaction
   * rolls back and the slot is released — no message admitted, no cursor advance.
   */
  commit(reservationId: string, input: CommitReservationInput): CommitResult {
    const res = this.resRepo.getById(reservationId);
    if (res === null || res.state !== 'reserved') {
      return { committed: false, reason: 'reservation_not_open' };
    }
    const run = this.runRepo.getById(res.run_id);
    if (run === null) return { committed: false, reason: 'run_missing' };

    const nowMs = this.now();
    let ok = false;
    try {
      this.tx(() => {
        // Advance the run FIRST — it is the barrier/TTL guard. If it fails, we
        // throw before touching the reservation, so the (single-threaded)
        // passthrough-tx default leaves the reservation `reserved` (release()
        // then works). With a real tx both orderings roll back cleanly (VERIF #2).
        if (!this.runRepo.incrementProducedAndAdvance(res.run_id, nowMs, run.interval_ms ?? 0)) {
          throw ABORT;
        }
        if (!this.resRepo.commit(reservationId, input, nowMs)) throw ABORT;
        // Produced-basis count barrier (§5.1): the transaction taking
        // produced_count to max_count sets the (permissive) `count` barrier
        // atomically — the final in-budget message still classifies/decides but
        // no further admission occurs.
        const updated = this.runRepo.getById(res.run_id);
        if (
          updated !== null &&
          updated.max_count_basis === 'produced' &&
          updated.max_count !== null &&
          updated.produced_count >= updated.max_count
        ) {
          this.runRepo.applyBarrier(res.run_id, 'count', 'permissive', nowMs + updated.drain_deadline_ms, nowMs);
        }
        ok = true;
      });
    } catch (e) {
      if (e !== ABORT) throw e;
      ok = false;
    }

    if (!ok) {
      // Rolled back to `reserved` (barrier/TTL raced) → release the slot; the
      // fetched ciphertext is crypto-shredded by the caller (ISVC-6).
      this.resRepo.release(reservationId, nowMs);
      return { committed: false, reason: 'barrier_or_ttl_raced' };
    }
    return { committed: true };
  }

  /** Release a `reserved` slot (fetch error). */
  release(reservationId: string): void {
    this.resRepo.release(reservationId, this.now());
  }

  /** Invalidate every OPEN reservation of a run (barrier/termination, §5.1).
   *  Returns the invalidated records so the caller can crypto-shred any staged
   *  ciphertext (ISVC-6). */
  invalidateOpen(runId: string): ReservationRecord[] {
    return this.resRepo.invalidateOpen(runId, this.now());
  }

  private withinCountBudget(run: RunRecord, openReservations: number, outstanding: number): boolean {
    if (run.max_count === null) return true;
    if (run.max_count_basis === 'produced') {
      // produced_count + uncommitted_produced_reservations < max_count (§7.1).
      return run.produced_count + openReservations < run.max_count;
    }
    // decided basis: outstanding + decided_count < max_count.
    return outstanding + run.decided_count < run.max_count;
  }

  private providerGrantValid(run: RunRecord, nowMs: number): boolean {
    // A public service carries no grant. A protected service's grant expiry is
    // enforced here (mid-run expiry → grant_unavailable, §10). The
    // protected-requires-a-grant-at-start check lives at creation (service
    // metadata); admission enforces only that a bound grant is still valid.
    if (run.provider_grant_id === null) return true;
    if (run.provider_grant_expires_at_sec === null) return true;
    return Math.floor(nowMs / 1000) < run.provider_grant_expires_at_sec;
  }
}
