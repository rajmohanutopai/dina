/**
 * Pull response-correlation ingress (INTERACTIVE_SERVICES_ARCHITECTURE.md §7).
 *
 * The other half of the pull loop from `engine.ts`: the pacer emits a signed
 * `service.query` tagged with a reservation's correlation id; the provider's
 * signed `service.response` (a `RunMessage`) comes back later through the Core
 * D2D receive path. This module turns that ALREADY-VERIFIED response into an
 * enqueued, classifying message — the §7 sequence:
 *
 *   match the reserved slot by correlation id → envelope-encrypt + store the
 *   verified payload (fresh per-payload key, §13) → GUARDED enqueue-commit CAS
 *   (`admission.commit`: barrier/TTL/persona still open, cursor advances exactly
 *   once) → create the `enqueued` message row → `beginClassification`.
 *
 * A barrier / TTL that landed in-flight makes the commit CAS fail: the stored
 * ciphertext is crypto-shredded and the slot released — no message admitted, no
 * cursor advance (§7). A duplicate (message already admitted) is idempotently
 * ignored. A persona that locked between the query and the response is reported
 * as `persona_locked`; the durable held-blob staging (`held_by_lock`) is the
 * locked-arrival path (ISVC-6 / the fs-spool composition), not this module.
 *
 * Signature verification (§6.2) happens in the receive pipeline BEFORE this
 * module — it only ever sees a verified projection, so it performs no crypto and
 * is fully unit-tested with stubs.
 */

import { PersonaLockedError } from '../errors';
import { getDefaultRiskLevel } from '../gatekeeper/intent';

import { getMessageRepository, type MessageKind, type MessageRecord, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRecord, type ReservationRepository } from './reservation';

import type { AdmissionService } from './admission';
import type { RunClassifyService } from './classification';
import type { RunRecord } from './domain';
import type { LockedArrivalStore } from './locked_arrival';
import type { PayloadStore } from './payload_store';
import type { RunService } from './service';


/** A signed provider `RunMessage` AFTER verification (§6.2/§18) — the fields the
 *  ingress needs to store the payload + shape the message row. */
export interface VerifiedRunMessage {
  message_id: string;
  sequence: number;
  dedup_key: string;
  kind: MessageKind;
  action_type: string | null;
  /** the message's own signed expiry (§6.3), ms. */
  expires_at: number;
  /** The provider-signed CANONICAL digest of the message's immutable fields
   *  (§13/§18) — NOT the randomized ciphertext hash. It is the stable content
   *  identity recorded on the reservation, so a re-delivery under a fresh
   *  `message_id` is detectable and never mis-recorded as new content. */
  content_digest: string;
  /** the verified payload plaintext to envelope-encrypt + store (§13). */
  payload: Uint8Array;
}
// NOTE (security, §9.1): a provider does NOT sign `risk_class` (the §18
// Message/proposal projection binds only kind + action_type, never a risk label).
// Core DERIVES risk — it must never trust a provider-supplied class, or a
// provider could label a HIGH/BLOCKED action `SAFE` to bypass owner confirmation.
// The lifecycle row is created with `risk_class: null`, so the risk gate's
// `?? 'MODERATE'` default requires an owner confirm; a Core action→risk policy
// keyed on `action_type` (an explicit SAFE allow-list) is where auto-dispatch of
// genuinely-safe actions would later be earned, never from provider input.

/** The Tier-0 metadata a `held_by_lock` reservation persists so the unlock
 *  replay can rebuild the message row (the payload itself stays Core-sealed in
 *  the spool). `VerifiedRunMessage` minus `payload`. */
export type HeldMessageMeta = Omit<VerifiedRunMessage, 'payload'>;

/** Parse a stored `held_message_json` back to metadata; null on corruption. */
export function parseHeldMessageMeta(raw: string | null): HeldMessageMeta | null {
  if (raw === null || raw === '') return null;
  try {
    const p = JSON.parse(raw) as Partial<HeldMessageMeta>;
    if (
      typeof p.message_id !== 'string' || p.message_id === '' ||
      typeof p.sequence !== 'number' ||
      typeof p.dedup_key !== 'string' ||
      (p.kind !== 'informational' && p.kind !== 'action') ||
      typeof p.expires_at !== 'number' ||
      typeof p.content_digest !== 'string'
    ) {
      return null;
    }
    return {
      message_id: p.message_id,
      sequence: p.sequence,
      dedup_key: p.dedup_key,
      kind: p.kind,
      action_type: typeof p.action_type === 'string' ? p.action_type : null,
      expires_at: p.expires_at,
      content_digest: p.content_digest,
    };
  } catch {
    return null;
  }
}

/**
 * The `enqueued` message row for a verified arrival — shared by the live ingest
 * and the unlock replay so the row shape (incl. the Core-DERIVED risk class,
 * never provider-supplied — §9.1) can never diverge between the two paths.
 */
export function buildEnqueuedMessageRow(
  meta: HeldMessageMeta,
  run: RunRecord,
  reservation: ReservationRecord,
  contentId: string,
  nowMs: number,
): MessageRecord {
  return {
    message_id: meta.message_id,
    run_id: run.run_id,
    reservation_id: reservation.reservation_id,
    dedup_key: meta.dedup_key,
    sequence: meta.sequence,
    kind: meta.kind,
    action_type: meta.action_type,
    risk_class:
      meta.kind === 'action' ? (getDefaultRiskLevel(meta.action_type ?? '') ?? 'MODERATE') : null,
    state: 'enqueued',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: meta.expires_at,
    payload_ref: contentId,
    content_digest: meta.content_digest,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: nowMs,
    updated_at: nowMs,
  };
}

export type PullIngestOutcome =
  /** admitted: `enqueued` + classification begun. */
  | { outcome: 'enqueued'; message_id: string }
  /** no reserved slot for this correlation id (already handled / invalidated /
   *  unknown) — nothing to admit. */
  | { outcome: 'no_slot' }
  /** the message was already admitted (idempotent replay). */
  | { outcome: 'duplicate'; message_id: string }
  /** rejected: a same-`dedup_key` retry that MUTATED the content (81B-03). */
  | { outcome: 'content_mismatch'; message_id: string }
  /** a barrier / TTL raced the commit CAS → ciphertext shredded, slot released. */
  | { outcome: 'barrier_raced' }
  /** the persona locked between query + response AND the locked-arrival store is
   *  composed: the response was durably STAGED and the slot is `held_by_lock` —
   *  it will be admitted exactly-once on unlock (§7). */
  | { outcome: 'held_by_lock' }
  /** the persona locked between query + response and NO locked-arrival store is
   *  wired (degraded mode): nothing staged; the slot stays reserved/released. */
  | { outcome: 'persona_locked' }
  /** the provider signalled `exhausted` (§7.1): slot released; if the run is
   *  `stop_on_exhaustion` the permissive exhaustion barrier was set. */
  | { outcome: 'exhausted'; barrier_set: boolean };

export interface RunResponseIngestOptions {
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
  messageRepo?: MessageRepository;
  admission: AdmissionService;
  /** Applies the exhaustion barrier on an `exhausted` marker (§7.1). */
  runService: RunService;
  classify: RunClassifyService;
  payloadStore: PayloadStore;
  /** Whether the run's persona DEK is currently in RAM (§7 commit gate). */
  isPersonaOpen?: (persona: string) => boolean;
  nowMsFn?: () => number;
  /** Runs the message enqueue + `beginClassification` as ONE commit after the
   *  guarded admission CAS (§6.3). Default is a passthrough. */
  tx?: (fn: () => void) => void;
  /** R5-01 — the composed locked-arrival store (§7): a lock-raced verified
   *  response is durably STAGED (device-sealed spool blob) and its slot becomes
   *  `held_by_lock` for exactly-once admission on unlock. Omitted ⇒ the degraded
   *  pre-composition behavior (persona_locked; the response may be re-fetched). */
  lockedArrival?: LockedArrivalStore;
}

export class RunResponseIngest {
  private readonly runs: RunRepository;
  private readonly reservations: ReservationRepository;
  private readonly messages: MessageRepository;
  private readonly admission: AdmissionService;
  private readonly runService: RunService;
  private readonly classify: RunClassifyService;
  private readonly payloads: PayloadStore;
  private readonly personaOpen: (persona: string) => boolean;
  private readonly now: () => number;
  private readonly tx: (fn: () => void) => void;
  private readonly lockedArrival: LockedArrivalStore | undefined;

  constructor(opts: RunResponseIngestOptions) {
    const runs = opts.runRepo ?? getRunRepository();
    const reservations = opts.reservationRepo ?? getReservationRepository();
    const messages = opts.messageRepo ?? getMessageRepository();
    if (runs === null || reservations === null || messages === null) {
      throw new Error('RunResponseIngest: run + reservation + message repositories must be wired');
    }
    this.runs = runs;
    this.reservations = reservations;
    this.messages = messages;
    this.admission = opts.admission;
    this.runService = opts.runService;
    this.classify = opts.classify;
    this.payloads = opts.payloadStore;
    this.personaOpen = opts.isPersonaOpen ?? (() => true);
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.tx = opts.tx ?? ((fn) => fn());
    this.lockedArrival = opts.lockedArrival;
  }

  /**
   * R5-01 (§7) — a verified response raced a persona LOCK: durably stage its
   * ciphertext (device-sealed spool blob) BEFORE the `held_by_lock` CAS, so it is
   * never lost and never re-fetched; the unlock replay admits it exactly once.
   * Falls back to the degraded `persona_locked` outcome when no locked-arrival
   * store is composed (nothing staged) or the CAS loses a race (blob discarded).
   */
  private holdForLock(
    res: { reservation_id: string },
    message: VerifiedRunMessage,
  ): PullIngestOutcome {
    if (this.lockedArrival === undefined) return { outcome: 'persona_locked' };
    const meta: HeldMessageMeta = {
      message_id: message.message_id,
      sequence: message.sequence,
      dedup_key: message.dedup_key,
      kind: message.kind,
      action_type: message.action_type,
      expires_at: message.expires_at,
      content_digest: message.content_digest,
    };
    // Stage FIRST (durable spool write), THEN the CAS — the §7 ordering: a crash
    // between the two leaves an unreferenced spool blob (GC'd later), never a
    // held reservation pointing at nothing.
    const ref = this.lockedArrival.stage(message.message_id, message.payload);
    const held = this.reservations.holdByLock(
      res.reservation_id,
      JSON.stringify(ref),
      JSON.stringify(meta),
      this.now(),
    );
    if (!held) {
      // The slot changed under us (barrier invalidated it mid-flight) — the
      // response must not survive: crypto-shred + delete the staged blob.
      this.lockedArrival.discard(message.message_id, ref);
      return { outcome: 'persona_locked' };
    }
    return { outcome: 'held_by_lock' };
  }

  /**
   * Ingest a verified pull `exhausted` marker for the slot that carried
   * `correlationId` (§7.1): the provider has no more results for this cursor. The
   * reserved slot is released (no message admitted, no cursor advance), and — if
   * the run is `stop_on_exhaustion` — the permissive exhaustion barrier is set
   * through `RunService` (idempotent, monotonic). Signature verification (binding
   * provider/service/run/cursor) happens in the receive pipeline before this.
   */
  ingestExhausted(correlationId: string): PullIngestOutcome {
    const res = this.reservations.getByCorrelation(correlationId);
    if (res === null || res.state !== 'reserved') return { outcome: 'no_slot' };
    const run = this.runs.getById(res.run_id);
    if (run === null) return { outcome: 'no_slot' };

    // ONE Tier-0 transaction (§6.2/§7.1, F10): release the fetch slot AND — if the
    // run is stop_on_exhaustion — set the permissive exhaustion barrier together, so
    // a crash can never leave the slot released with the barrier lost (a replayed
    // exhausted marker would then find no reserved slot and drop the barrier
    // forever). The slot release admits nothing + does not advance the cursor (the
    // position simply has no item). The barrier is monotonic + idempotent via
    // decideBarrier; a non-stop_on_exhaustion run keeps paging (a later cursor may
    // yield again).
    let barrierSet = false;
    this.tx(() => {
      this.reservations.release(res.reservation_id, this.now());
      if (run.stop_on_exhaustion && run.state === 'active') {
        barrierSet = this.runService.applyTerminationCause(run, 'exhaustion') !== null;
      }
    });
    return { outcome: 'exhausted', barrier_set: barrierSet };
  }

  /**
   * Ingest a verified pull `service.response` for the slot that carried
   * `correlationId` (§7). Idempotent by `message_id`. See {@link PullIngestOutcome}.
   */
  ingestPullResponse(correlationId: string, message: VerifiedRunMessage): PullIngestOutcome {
    const res = this.reservations.getByCorrelation(correlationId);
    if (res === null) return { outcome: 'no_slot' };

    // Idempotent replay (§7.1/§13, F4). A re-delivery of an already-admitted item,
    // detected TWO ways, is a duplicate — never re-stored, never double-advancing
    // the count/cursor:
    //   (a) same `message_id` — checked FIRST (before the reserved-state gate) so a
    //       re-delivery arriving after its slot committed reads as `duplicate`, not
    //       a spurious `no_slot` (its reservation is no longer `reserved`);
    //   (b) same `(run_id, dedup_key)` under a FRESH `message_id` (a provider
    //       retry) — scanned over the run's messages (bounded by queue_cap).
    // If THIS response opened a fresh `reserved` slot for the duplicate, release it
    // so the fetch position is retried and the slot isn't leaked to lease-expiry.
    const dupById = this.messages.getById(message.message_id);
    const dupByKey =
      dupById === null && res.state === 'reserved'
        ? (this.messages.listByRun(res.run_id).find((m) => m.dedup_key === message.dedup_key) ?? null)
        : null;
    const duplicate = dupById ?? dupByKey;
    if (duplicate !== null) {
      // 81B-03 — a same-id / same-`dedup_key` retry that MUTATED the content (a
      // DIFFERENT canonical content_digest) is a provider integrity violation, not
      // a duplicate: reject it, never collapse it onto the original claimed event.
      // A faithful retry (identical content_digest) still collapses as a dup.
      if (
        duplicate.content_digest !== null &&
        duplicate.content_digest !== message.content_digest
      ) {
        if (res.state === 'reserved') this.reservations.release(res.reservation_id, this.now());
        return { outcome: 'content_mismatch', message_id: duplicate.message_id };
      }
      if (res.state === 'reserved') this.reservations.release(res.reservation_id, this.now());
      return { outcome: 'duplicate', message_id: duplicate.message_id };
    }

    // Only a still-`reserved` slot can be committed; a committed / released / held
    // slot carrying a DIFFERENT (or no) message means the slot was already
    // consumed or invalidated — nothing to admit for this correlation id.
    if (res.state !== 'reserved') return { outcome: 'no_slot' };
    const run = this.runs.getById(res.run_id);
    if (run === null) return { outcome: 'no_slot' };

    // Persona must be open to wrap the payload under its DEK (§7). A locked
    // persona takes the durable held-blob path: stage + `held_by_lock` (R5-01).
    if (!this.personaOpen(run.persona)) return this.holdForLock(res, message);

    // PREPARE the payload (envelope-encrypt + leaf key + `prepared` pin), but do
    // NOT publish yet (F2): publication is deferred into the enqueue-commit tx
    // below so a crash before that leaves the payload merely `prepared`
    // (reclaimable), never a `published` orphan with no lifecycle row (§13).
    let contentId: string;
    try {
      const ref = this.payloads.preparePayload({
        payloadId: message.message_id,
        runId: run.run_id,
        persona: run.persona,
        plaintext: message.payload,
      });
      contentId = ref.content_id;
    } catch (err) {
      // The DEK dropped between the open-check and the wrap (a lock race): the
      // durable held-blob path (R5-01) — stage + `held_by_lock`.
      if (err instanceof PersonaLockedError) return this.holdForLock(res, message);
      throw err;
    }

    // Recheck persona-open at the enqueue-commit point (§7/§18 "hard bounds", F3).
    // `preparePayload` above already fails closed on a lock (PersonaLockedError),
    // but this is the explicit hard-bound recheck AT the commit: a persona that
    // locked after the payload was prepared must NOT be admitted under a now-
    // closed persona. Crypto-shred the just-prepared (persona-wrapped) ciphertext,
    // then take the durable held-blob path (R5-01): stage the still-in-memory
    // plaintext device-sealed and CAS the slot to `held_by_lock` — never dropped,
    // admitted exactly-once on unlock. (Degraded mode releases the slot as before.)
    if (!this.personaOpen(run.persona)) {
      this.payloads.shredPayload(message.message_id);
      const held = this.holdForLock(res, message);
      if (held.outcome === 'persona_locked') {
        this.reservations.release(res.reservation_id, this.now());
      }
      return held;
    }

    // GUARDED enqueue-commit CAS (§7/§8) — ONE Tier-0 transaction (F2). The
    // `onCommitted` callback runs INSIDE the commit tx, right after the reservation
    // CAS + cursor/count/barrier advance: it creates the `enqueued` message row,
    // begins classification (ACTION → Tier-2 base; INFORMATIONAL → durable Brain
    // job), and PUBLISHES the payload pointer — so cursor advance, lifecycle, and
    // payload publication all commit or roll back together. A barrier/TTL that
    // landed in-flight fails the CAS; the slot is released inside commit and the
    // prepared (never published) ciphertext is crypto-shredded — nothing admitted,
    // no cursor advance, no orphan blob.
    const nowMs = this.now();
    const committed = this.admission.commit(
      res.reservation_id,
      {
        message_id: message.message_id,
        dedup_key: message.dedup_key,
        // The CANONICAL provider-signed digest (F4/§13) — NOT the randomized
        // ciphertext hash — so the reservation records a stable content identity.
        content_digest: message.content_digest,
      },
      () => {
        // 81B-05 — the row's risk class is Core-DERIVED inside the shared
        // builder (§9.1, never provider-supplied); the builder is shared with the
        // unlock replay so the two admission paths can never diverge.
        this.messages.create(buildEnqueuedMessageRow(message, run, res, contentId, nowMs));
        this.classify.beginClassification(message.message_id);
        // Publish the payload pointer within this same tx (prepared → published).
        if (!this.payloads.publishPayload(message.message_id)) {
          throw new Error('RunResponseIngest: payload publish failed (prepared pin missing)');
        }
      },
    );
    if (!committed.committed) {
      // The CAS raced a barrier/TTL (or onCommitted rolled back): the prepared
      // ciphertext was never published — crypto-shred it; nothing was admitted.
      this.payloads.shredPayload(message.message_id);
      return { outcome: 'barrier_raced' };
    }
    return { outcome: 'enqueued', message_id: message.message_id };
  }
}
