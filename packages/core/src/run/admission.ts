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
  | 'grant_unavailable'
  // Round-A A-03 — `paused_reason` is set (§7 response_lost / §10
  // provider_grant_unavailable): fetch is PAUSED until the owner resumes
  // (retry), skips the lost slot, or rebinds the grant.
  | 'paused';

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
  /** Invoked IN THE COMMIT TRANSACTION the moment the produced-basis count
   *  barrier is set (§5.1). Like every barrier, it must atomically invalidate
   *  every remaining OPEN (fetch-ahead) reservation + crypto-shred its staged
   *  ciphertext — the just-committed slot is already `committed`, so it is not
   *  touched. The composition wires this to RunTerminationService.onBarrier;
   *  unwired, the barrier row is still set (admission stops via the count gate),
   *  only the fetch-ahead invalidation is skipped. */
  onBarrier?: (run: RunRecord) => void;
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
  private onBarrier?: (run: RunRecord) => void;
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
    this.onBarrier = opts.onBarrier;
  }

  /** Wire the produced-count barrier hook after construction (breaks the
   *  AdmissionService ↔ RunTerminationService cycle at composition time). */
  setOnBarrier(fn: ((run: RunRecord) => void) | undefined): void {
    this.onBarrier = fn;
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
  /**
   * Round-A A-11 — the FULL admission gate set as a SIDE-EFFECT-FREE check
   * (§5 "fetch-paused is a derived condition": barrier/state, hard TTL,
   * `paused_reason`, cadence, queue cap, count budget, persona lock, grant).
   * `reserve` consumes it before opening a slot; `/status` reports it so
   * `fetch_paused` reflects the REAL current condition, not just
   * `paused_reason`/TTL. Returns the first blocking reason, or null.
   */
  gateReason(runId: string): ReserveRejection | null {
    const run = this.runRepo.getById(runId);
    if (run === null) return 'not_active';
    const nowMs = this.now();

    if (run.state !== 'active') return 'not_active';
    if (nowMs >= run.expires_at) return 'past_ttl';
    // A-03 — an OWNER-ACTION pause blocks fetch outright (§7 response_lost:
    // "run paused for owner skip/resume/stop"; §7.1 push_grant_unavailable:
    // lifts only via an /update rebind). Without this gate the pacer kept
    // polling and a retry was admitted while the loss and pause stood.
    // `provider_grant_unavailable` is NOT gated here — §10 says "Core
    // auto-revalidates and resumes", so it falls through to the grant check
    // below: an invalid grant re-reports `grant_unavailable`; a rebound valid
    // grant admits again and the pacer clears the stale pause marker.
    if (run.paused_reason === 'response_lost' || run.paused_reason === 'push_grant_unavailable') {
      return 'paused';
    }
    if (run.next_fetch_at !== null && nowMs < run.next_fetch_at) {
      return 'cadence_not_elapsed';
    }

    const open = this.resRepo.countOpen(runId);
    const outstanding = this.counts.enqueuedUndecided(runId) + open;
    if (outstanding >= run.queue_cap) return 'queue_full';

    if (!this.withinCountBudget(run, open, outstanding)) return 'count_exhausted';
    if (!this.personaOpen(run.persona)) return 'persona_locked';
    if (!this.providerGrantValid(run, nowMs)) return 'grant_unavailable';
    return null;
  }

  reserve(runId: string): ReserveResult {
    const blocked = this.gateReason(runId);
    if (blocked !== null) return { ok: false, reason: blocked };
    const run = this.runRepo.getById(runId);
    if (run === null) return { ok: false, reason: 'not_active' };
    const nowMs = this.now();

    // DISTINCT cursor per open reservation (§7 single-flight-per-cursor): the
    // run's `fetch_cursor` only advances at COMMIT, so under fetch-ahead every
    // open reservation would otherwise snapshot the SAME cursor and fetch the
    // same provider position twice. Allocate the LOWEST FREE cursor at/above the
    // run cursor — filling any hole left by a released out-of-order reservation
    // (so `fetch_cursor + open` can never re-hand an occupied cursor, and the
    // in-order commit CAS never deadlocks on a gap). Commit advances the run
    // cursor in strict order (the CAS below).
    const openCursors = new Set(
      this.resRepo
        .listByRun(runId)
        .filter((r) => r.state === 'reserved' || r.state === 'held_by_lock')
        .map((r) => r.cursor),
    );
    let cursor = run.fetch_cursor ?? 0;
    while (openCursors.has(cursor)) cursor++;
    const reservationId = this.nextId();
    this.resRepo.create({
      reservation_id: reservationId,
      run_id: runId,
      cursor,
      state: 'reserved',
      message_id: null,
      dedup_key: null,
      content_digest: null,
      sealed_response_ref: null,
      held_message_json: null,
      error_reason: null,
      error_at: null,
      lease_expires_at: nowMs + this.leaseMs,
      query_correlation_id: null,
      created_at: nowMs,
      updated_at: nowMs,
    });
    return { ok: true, reservation_id: reservationId, cursor };
  }

  /**
   * The barrier-guarded enqueue-commit CAS (§7/§8). Commits the reservation AND
   * advances the run's produced_count + fetch_cursor + next_fetch_at atomically.
   * A barrier/TTL that landed in-flight makes the CAS fail: the transaction
   * rolls back and the slot is released — no message admitted, no cursor advance.
   *
   * `onCommitted` (F2/§8) runs INSIDE this transaction, immediately after the
   * reservation CAS succeeds, so the caller's message-lifecycle enqueue +
   * classification + payload-publish commit as ONE Tier-0 transaction with the
   * cursor/count/barrier advance. If it throws, the ENTIRE commit rolls back
   * (cursor unmoved, reservation released) — a crash can never leave an advanced
   * cursor with no message, nor a published payload with no lifecycle row.
   */
  commit(
    reservationId: string,
    input: CommitReservationInput,
    onCommitted?: () => void,
    from: 'reserved' | 'held_by_lock' = 'reserved',
  ): CommitResult {
    const res = this.resRepo.getById(reservationId);
    if (res === null || res.state !== from) {
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
        // In-order commit CAS on the reservation's own cursor (§7): a fetch-ahead
        // reservation may only commit when the run cursor has reached its position,
        // so each position advances exactly once and none is skipped/doubled.
        if (!this.runRepo.incrementProducedAndAdvance(res.run_id, nowMs, run.interval_ms ?? 0, res.cursor)) {
          throw ABORT;
        }
        if (!this.resRepo.commit(reservationId, input, nowMs, from)) throw ABORT;
        // A-03 — a commit at this cursor SUPERSEDES any stale `response_lost`
        // row parked on the same position (the owner resumed and the provider's
        // retry re-filled it): terminal-skip the stale row and clear the
        // `response_lost` pause once no loss remains — atomic with the commit.
        for (const sibling of this.resRepo.listByRun(res.run_id)) {
          if (sibling.state === 'response_lost' && sibling.cursor === res.cursor) {
            this.resRepo.skipLost(sibling.reservation_id, nowMs);
          }
        }
        // Round-C C-04 — this commit advanced fetch_cursor to res.cursor+1. If an
        // owner ALREADY terminally-skipped a LATER cursor (an out-of-order skip
        // whose earlier gap this repair just closed), advance THROUGH every
        // contiguous skipped position so the next reserve never targets a
        // position the owner permanently skipped (§13 permanent-gap). In-tx +
        // CAS-guarded (advanceCursorPastSkipped only advances when fetch_cursor
        // equals the skipped cursor), so it's a no-op unless the run cursor sits
        // exactly on a skipped position.
        const skippedCursors = new Set(
          this.resRepo
            .listByRun(res.run_id)
            .filter((r) => r.state === 'skipped')
            .map((r) => r.cursor),
        );
        let nextCursor = res.cursor + 1;
        while (
          skippedCursors.has(nextCursor) &&
          this.runRepo.advanceCursorPastSkipped(res.run_id, nextCursor, nowMs)
        ) {
          nextCursor += 1;
        }
        const runNow = this.runRepo.getById(res.run_id);
        if (runNow !== null && runNow.paused_reason === 'response_lost') {
          const anyLost = this.resRepo
            .listByRun(res.run_id)
            .some((r) => r.state === 'response_lost');
          if (!anyLost) this.runRepo.setPausedReason(res.run_id, null, nowMs);
        }
        // Caller's lifecycle enqueue + classify + payload-publish, atomic with the
        // CAS above (F2). A throw here aborts the whole transaction.
        if (onCommitted !== undefined) onCommitted();
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
          const applied = this.runRepo.applyBarrier(
            res.run_id,
            'count',
            'permissive',
            nowMs + updated.drain_deadline_ms,
            nowMs,
          );
          // Every barrier atomically invalidates the remaining OPEN (fetch-ahead)
          // reservations + crypto-shreds their staged ciphertext (§5.1/R2-02),
          // routed through the SAME hook as owner/expiry barriers so the path is
          // uniform. The slot committed just above is `committed`, so the hook never
          // touches it; a permissive count barrier leaves the undecided set to
          // finish. Runs in THIS commit tx so barrier + invalidation land atomically.
          //   Invariant: the produced-budget gate (`produced_count + open <
          // max_count`, held_by_lock included) means a commit reaching max_count has
          // NO open sibling — the invalidation set is normally empty. The hook is
          // defense-in-depth: it keeps this barrier uniform with the others and can
          // never leave a slot live past the cap if the budget logic ever changes.
          if (applied && this.onBarrier !== undefined) {
            const barred = this.runRepo.getById(res.run_id);
            if (barred !== null) this.onBarrier(barred);
          }
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

// ---------------------------------------------------------------------------
// Round-A A-11 — the fetch-eligibility probe the owner `/status` route reads.
// The plane registers its AdmissionService's `gateReason` here (same pattern as
// `setRunPayloadView`), so the route reports the FULL derived condition without
// reaching into the plane. Absent a probe the route falls back to the
// paused_reason/TTL approximation.
// ---------------------------------------------------------------------------

export type FetchEligibilityProbe = (runId: string) => ReserveRejection | null;

let eligibilityProbe: FetchEligibilityProbe | null = null;

export function setFetchEligibilityProbe(p: FetchEligibilityProbe | null): void {
  eligibilityProbe = p;
}

export function getFetchEligibilityProbe(): FetchEligibilityProbe | null {
  return eligibilityProbe;
}
