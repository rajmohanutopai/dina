/**
 * Unlock replay for `held_by_lock` reservations (R5-01 —
 * INTERACTIVE_SERVICES_ARCHITECTURE.md §7 "unlock-commit").
 *
 * A lock-raced verified response was durably staged (device-sealed spool blob)
 * and its reservation CAS'd to `held_by_lock` by the ingest. When the persona
 * unlocks, this service admits each held response EXACTLY ONCE through the SAME
 * guarded enqueue-commit the live ingest uses (`admission.commit` entered from
 * `held_by_lock`): recover (peek + digest + device-unseal, side-effect free) →
 * prepare the persona-wrapped payload → the single Tier-0 CAS (reservation +
 * cursor + message row + payload publish, one transaction) → finalize (spool ack
 * + staging-key destroy). Crash at any boundary retries cleanly:
 *   - crash after prepare, before commit → prepared blob reclaimed by the
 *     prepared-lease sweep; reservation still held; spool intact ⇒ retried;
 *   - crash after commit, before finalize → the message row exists; the retry
 *     detects it and just finalizes (no double-admit).
 *
 * An unrecoverable staged blob (missing / digest mismatch / shredded key /
 * corrupt) becomes `response_lost` (§7): the reservation CAS's to
 * `response_lost` with the detected reason, the slot leaves the open set, the
 * run gains `paused_reason: 'response_lost'`, and the owner is notified. A
 * provider RETRY repairs a not-yet-skipped loss by re-fetching the freed cursor
 * position through the live ingest; the owner's `skip_lost_reservation` gives
 * up on it (terminal `skipped`, `paused_reason` recomputed).
 *
 * Per-run CURSOR ORDER is preserved (the in-order commit CAS requires it):
 * held reservations replay lowest-cursor first, and a still-locked or re-locked
 * persona defers its remaining items to the next unlock.
 */

import { PersonaLockedError } from '../errors';

import { buildEnqueuedMessageRow, parseHeldMessageMeta } from './ingest';
import { getMessageRepository, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository , ReservationRecord } from './reservation';

import type { AdmissionService } from './admission';
import type { RunClassifyService } from './classification';
import type { RunRecord } from './domain';
import type { LockedArrivalStore, SealedResponseRef } from './locked_arrival';
import type { PayloadStore } from './payload_store';

export interface HeldReplayOptions {
  admission: AdmissionService;
  classify: RunClassifyService;
  payloadStore: PayloadStore;
  lockedArrival: LockedArrivalStore;
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
  messageRepo?: MessageRepository;
  isPersonaOpen?: (persona: string) => boolean;
  nowMsFn?: () => number;
  /** R5-02/§7 — fired post-commit when a held response is detected LOST. The
   *  boots wire it to a `run`-kind notification. Best-effort. */
  onResponseLost?: (run: RunRecord, reservation: ReservationRecord, reason: string) => void;
}

export interface HeldReplayReport {
  /** Admitted exactly-once through the guarded commit. */
  published: number;
  /** Detected unrecoverable → `response_lost` (+ owner notification). */
  lost: number;
  /** Skipped this pass (persona still/again locked, run missing, barrier). */
  deferred: number;
}

/** Parse a stored `sealed_response_ref` back to its ref; null on corruption. */
export function parseSealedRef(raw: string | null): SealedResponseRef | null {
  if (raw === null || raw === '') return null;
  try {
    const p = JSON.parse(raw) as Partial<SealedResponseRef>;
    if (typeof p.spool_id !== 'string' || typeof p.content_digest !== 'string') return null;
    return {
      spool_id: p.spool_id,
      content_digest: p.content_digest,
      // A-02 — the ref-pinned staging-key id; absent on pre-field refs.
      ...(typeof p.staged_key_id === 'string' ? { staged_key_id: p.staged_key_id } : {}),
    };
  } catch {
    return null;
  }
}

export class HeldReplayService {
  private readonly runs: RunRepository;
  private readonly reservations: ReservationRepository;
  private readonly messages: MessageRepository;
  private readonly admission: AdmissionService;
  private readonly classify: RunClassifyService;
  private readonly payloads: PayloadStore;
  private readonly lockedArrival: LockedArrivalStore;
  private readonly personaOpen: (persona: string) => boolean;
  private readonly now: () => number;
  private readonly onResponseLost:
    | ((run: RunRecord, reservation: ReservationRecord, reason: string) => void)
    | undefined;

  constructor(opts: HeldReplayOptions) {
    const runs = opts.runRepo ?? getRunRepository();
    const reservations = opts.reservationRepo ?? getReservationRepository();
    const messages = opts.messageRepo ?? getMessageRepository();
    if (runs === null || reservations === null || messages === null) {
      throw new Error('HeldReplayService: run + reservation + message repositories must be wired');
    }
    this.runs = runs;
    this.reservations = reservations;
    this.messages = messages;
    this.admission = opts.admission;
    this.classify = opts.classify;
    this.payloads = opts.payloadStore;
    this.lockedArrival = opts.lockedArrival;
    this.personaOpen = opts.isPersonaOpen ?? (() => true);
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.onResponseLost = opts.onResponseLost;
  }

  /** Replay every held reservation whose run belongs to `persona` (unlock). */
  replayForPersona(persona: string): HeldReplayReport {
    return this.replay((run) => run.persona === persona);
  }

  /** Replay every held reservation whose persona is currently open (boot). */
  replayAll(): HeldReplayReport {
    return this.replay(() => true);
  }

  private replay(runFilter: (run: RunRecord) => boolean): HeldReplayReport {
    const report: HeldReplayReport = { published: 0, lost: 0, deferred: 0 };
    // Cursor ASC globally ⇒ per-run cursor order preserved. A run whose earlier
    // position fails to commit defers its later positions (the in-order CAS
    // would reject them anyway).
    const stalledRuns = new Set<string>();
    for (const res of this.reservations.listHeldByLock()) {
      if (stalledRuns.has(res.run_id)) {
        report.deferred += 1;
        continue;
      }
      const run = this.runs.getById(res.run_id);
      if (run === null || !runFilter(run)) {
        report.deferred += 1;
        continue;
      }
      if (!this.personaOpen(run.persona)) {
        report.deferred += 1;
        continue;
      }

      const meta = parseHeldMessageMeta(res.held_message_json);
      const ref = parseSealedRef(res.sealed_response_ref);
      if (meta === null || ref === null) {
        this.markLost(run, res, 'corrupt', ref, meta?.message_id ?? null);
        report.lost += 1;
        continue;
      }

      // Crash-recovery (§7): committed but not finalized — the message row
      // exists, so just finalize the staged copy + converge the reservation.
      if (this.messages.getById(meta.message_id) !== null) {
        this.lockedArrival.finalize(meta.message_id, ref);
        this.reservations.commit(
          res.reservation_id,
          { message_id: meta.message_id, dedup_key: meta.dedup_key, content_digest: meta.content_digest },
          this.now(),
          'held_by_lock',
        );
        this.reservations.clearSealedRef(res.reservation_id);
        report.published += 1;
        continue;
      }

      const recovered = this.lockedArrival.recover(meta.message_id, ref);
      if (recovered.outcome === 'response_lost') {
        this.markLost(run, res, recovered.reason, ref, meta.message_id);
        report.lost += 1;
        continue;
      }

      // Prepare the persona-wrapped payload; a re-lock mid-replay defers the
      // rest of this persona's items to the next unlock (nothing consumed).
      let contentId: string;
      try {
        contentId = this.payloads.preparePayload({
          payloadId: meta.message_id,
          runId: run.run_id,
          persona: run.persona,
          plaintext: recovered.plaintext,
        }).content_id;
      } catch (err) {
        if (err instanceof PersonaLockedError) {
          report.deferred += 1;
          stalledRuns.add(res.run_id);
          continue;
        }
        throw err;
      }

      const nowMs = this.now();
      const committed = this.admission.commit(
        res.reservation_id,
        { message_id: meta.message_id, dedup_key: meta.dedup_key, content_digest: meta.content_digest },
        () => {
          this.messages.create(buildEnqueuedMessageRow(meta, run, res, contentId, nowMs));
          this.classify.beginClassification(meta.message_id);
          if (!this.payloads.publishPayload(meta.message_id)) {
            throw new Error('HeldReplayService: payload publish failed (prepared pin missing)');
          }
        },
        'held_by_lock',
      );
      if (committed.committed) {
        this.lockedArrival.finalize(meta.message_id, ref);
        // A-01 — clear the staged ref so a crash between commit and finalize is
        // detectable: a committed row that still CARRIES a ref is exactly the
        // residue the cleanup sweep finalizes on the next boot/tick.
        this.reservations.clearSealedRef(res.reservation_id);
        report.published += 1;
      } else {
        // Barrier/TTL raced (or the in-order cursor CAS rejected): shred the
        // prepared (never published) ciphertext. The held blob itself is owned
        // by the terminating path (barrier invalidation → discardHeld) or the
        // next replay pass; nothing is consumed here.
        this.payloads.shredPayload(meta.message_id);
        report.deferred += 1;
        stalledRuns.add(res.run_id);
      }
    }
    return report;
  }

  private markLost(
    run: RunRecord,
    res: ReservationRecord,
    reason: string,
    ref: SealedResponseRef | null,
    payloadId: string | null,
  ): void {
    const nowMs = this.now();
    if (!this.reservations.markResponseLost(res.reservation_id, reason, nowMs)) return;
    // The stale staged copy is unrecoverable garbage (a provider RETRY repairs
    // via a fresh live fetch, not from the spool) — destroy the staging key,
    // then ack the blob. A-02: the ref pins the REAL key id, so even a
    // corrupt-metadata loss (payloadId unknown) shreds the right key.
    if (ref !== null) {
      this.lockedArrival.finalize(payloadId ?? res.reservation_id, ref);
    }
    // Clear the raw ref either way: a parseable one was just finalized; an
    // UNPARSEABLE one points at nothing actionable (the orphaned spool blob is
    // reaped by the age-based spool GC, A-05) — keeping it would make the
    // residue sweep rescan the row forever.
    this.reservations.clearSealedRef(res.reservation_id);
    this.runs.setPausedReason(run.run_id, 'response_lost', nowMs);
    if (this.onResponseLost !== undefined) {
      try {
        this.onResponseLost(run, res, reason);
      } catch {
        /* notification sink is best-effort */
      }
    }
  }
}
