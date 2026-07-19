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

import { getMessageRepository, type MessageKind, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository } from './reservation';

import type { AdmissionService } from './admission';
import type { RunClassifyService } from './classification';
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

export type PullIngestOutcome =
  /** admitted: `enqueued` + classification begun. */
  | { outcome: 'enqueued'; message_id: string }
  /** no reserved slot for this correlation id (already handled / invalidated /
   *  unknown) — nothing to admit. */
  | { outcome: 'no_slot' }
  /** the message was already admitted (idempotent replay). */
  | { outcome: 'duplicate'; message_id: string }
  /** a barrier / TTL raced the commit CAS → ciphertext shredded, slot released. */
  | { outcome: 'barrier_raced' }
  /** the persona locked between query + response → the held-blob path (ISVC-6),
   *  handled by the locked-arrival composition, not admitted here. */
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
    // persona is the durable held-blob path (ISVC-6) — not admitted here.
    if (!this.personaOpen(run.persona)) return { outcome: 'persona_locked' };

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
      // The DEK dropped between the open-check and the wrap (a lock race): treat
      // as the held path, leave the slot `reserved` for the locked-arrival flow.
      if (err instanceof PersonaLockedError) return { outcome: 'persona_locked' };
      throw err;
    }

    // Recheck persona-open at the enqueue-commit point (§7/§18 "hard bounds", F3).
    // `putPayload` above already fails closed on a lock (PersonaLockedError), but
    // this is the explicit hard-bound recheck AT the commit: a persona that locked
    // after the payload was stored fails closed here — crypto-shred the just-stored
    // ciphertext + release the slot — rather than admitting a message under a now-
    // closed persona. (Durably STAGING a lock-raced response as `held_by_lock` for
    // replay on unlock is the ISVC-6 fs-spool path, layered on when composed.)
    if (!this.personaOpen(run.persona)) {
      this.payloads.shredPayload(message.message_id);
      this.reservations.release(res.reservation_id, this.now());
      return { outcome: 'persona_locked' };
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
        this.messages.create({
          message_id: message.message_id,
          run_id: run.run_id,
          reservation_id: res.reservation_id,
          dedup_key: message.dedup_key,
          sequence: message.sequence,
          kind: message.kind,
          action_type: message.action_type,
          // Core-derived, NEVER provider-supplied (§9.1): null → the risk gate
          // requires an owner confirm (fail-safe). See the VerifiedRunMessage note.
          risk_class: null,
          state: 'enqueued',
          decision: null,
          decision_revision: 0,
          delegation_id: null,
          expires_at: message.expires_at,
          payload_ref: contentId,
          tier_candidate: null,
          final_tier: null,
          tier_source: null,
          reconciliation_evidence: '[]',
          created_at: nowMs,
          updated_at: nowMs,
        });
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
