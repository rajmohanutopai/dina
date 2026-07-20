/**
 * The interactive-run active-engine DRIVER (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §7/§8/§11 — the "gated pacer as a driven loop").
 *
 * `RunEngine` is the pure, injectable driver that turns the already-built control
 * plane (admission gate, dispatch outbox) into a running loop. It owns TWO ticks:
 *
 *  - `pacerTick` (§7/§11) — for each ACTIVE pull run, try to open an admission
 *    slot (`reserve` gates cadence / queue / count / persona / grant), and on
 *    success emit the run's `service.query` through the injected egress effect.
 *    The reservation stays `reserved`; the provider's RESPONSE arrives later and
 *    is correlated back to the slot by the D2D ingress branch (a separate piece),
 *    which commits it, stores the payload, and begins classification. A send
 *    failure releases the slot so the cursor is retried, never skipped.
 *
 *  - `dispatchTick` (§8) — for each dispatchable run (active, or draining under a
 *    permissive cause before its deadline), atomically CLAIM every
 *    `risk_authorized` action (mint the stable delegation id, advance to
 *    `sending`), emit the delegation, then mark it `dispatched` (or `failed`). The
 *    claim guard is the linearization point; a fenced / expired / locked run's
 *    claim fails and nothing is sent.
 *
 * The engine performs NO crypto, NO transport, and NO classification itself — all
 * external effects are injected callbacks, so the loop logic is unit-tested with
 * stubs and the composition wires the real D2D egress. Classification is driven by
 * the Brain worker (§12.6); termination / expiry / lease-reclaim by the
 * `RunSweeper` (§5.1). The engine only drives the two egress-bound loops.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { getMessageRepository, type MessageRecord, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository } from './reservation';

import type { AdmissionService } from './admission';
import type { RunDispatchService } from './dispatch';
import type { RunRecord } from './domain';
import type { RunService } from './service';

/** Emit a run's `service.query` for a freshly-reserved pull slot (§7). The engine
 *  has ALREADY stamped `correlationId` onto the reservation (durable, pre-egress)
 *  — the effect MUST embed that exact id in the outgoing query so the provider
 *  echoes it and the response-correlation ingress can match the slot. Resolves
 *  when the query is SENT — NOT when answered; rejects on an egress failure (→ the
 *  slot is released). */
export type EmitQueryEffect = (input: {
  run: RunRecord;
  reservationId: string;
  cursor: number;
  correlationId: string;
}) => Promise<void>;

/** Transmit a claimed delegation for a `sending` action (§8). Resolves on send;
 *  rejects on a send failure (→ the message is marked `failed`). */
export type EmitDelegationEffect = (input: {
  run: RunRecord;
  message: MessageRecord;
  delegationId: string;
}) => Promise<void>;

export interface RunEngineOptions {
  runRepo?: RunRepository;
  messageRepo?: MessageRepository;
  reservationRepo?: ReservationRepository;
  admission: AdmissionService;
  /** Sets the expiry barrier when the pacer observes a past-TTL run (§11). */
  runService: RunService;
  dispatch: RunDispatchService;
  /** D2D egress for a pull `service.query`. */
  emitQuery: EmitQueryEffect;
  /** D2D egress for a claimed action delegation. */
  emitDelegation: EmitDelegationEffect;
  nowMsFn?: () => number;
  /** Fresh, unguessable query-correlation id (per reserved slot). A random id
   *  (not the reservation id) is used so no internal identifier is disclosed to
   *  the provider. */
  correlationIdFn?: () => string;
  /** Max runs scanned per tick (backpressure); default 500. */
  pageLimit?: number;
  intervalMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  /** Supervises an interval-tick failure (a rejected pacer/dispatch promise).
   *  Without it a transient repository error becomes an unhandled rejection. */
  onError?: (err: unknown) => void;
}

export interface PacerReport {
  reserved: number;
  sent: number;
  failed: number;
}

export interface DispatchReport {
  /** `approved` actions run through the risk gate this pass (§6.3). */
  risk_evaluated: number;
  /** freshly `risk_authorized` actions claimed → `sending` this pass. */
  claimed: number;
  /** `sending` delegations confirmed sent → `dispatched` this pass (includes
   *  re-driven durable rows from a prior tick / crash). */
  sent: number;
  /** `sending` delegations whose egress failed/was ambiguous — LEFT in `sending`
   *  to resend next tick (never falsely marked failed, §8/§6.2, F7). */
  retried: number;
}

export interface EngineTickReport {
  pacer: PacerReport;
  dispatch: DispatchReport;
}

export class RunEngine {
  private readonly runs: RunRepository;
  private readonly messages: MessageRepository;
  private readonly reservations: ReservationRepository;
  private readonly admission: AdmissionService;
  private readonly runService: RunService;
  private readonly dispatch: RunDispatchService;
  private readonly emitQuery: EmitQueryEffect;
  private readonly emitDelegation: EmitDelegationEffect;
  private readonly now: () => number;
  private readonly newCorrelationId: () => string;
  private readonly pageLimit: number;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private handle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  private activeTick: Promise<void> | null = null;
  private readonly onError: (err: unknown) => void;

  constructor(opts: RunEngineOptions) {
    const runs = opts.runRepo ?? getRunRepository();
    const messages = opts.messageRepo ?? getMessageRepository();
    const reservations = opts.reservationRepo ?? getReservationRepository();
    if (runs === null || messages === null || reservations === null) {
      throw new Error('RunEngine: run + message + reservation repositories must be wired');
    }
    this.runs = runs;
    this.messages = messages;
    this.reservations = reservations;
    this.admission = opts.admission;
    this.runService = opts.runService;
    this.dispatch = opts.dispatch;
    this.emitQuery = opts.emitQuery;
    this.emitDelegation = opts.emitDelegation;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.newCorrelationId = opts.correlationIdFn ?? (() => `qc-${bytesToHex(randomBytes(16))}`);
    this.pageLimit = opts.pageLimit ?? 500;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
    this.onError = opts.onError ?? (() => undefined);
  }

  /**
   * One pull-pacer pass (§7/§11). Tries to open an admission slot on every ACTIVE
   * pull run; `reserve` is the whole gate (cadence / queue / count / persona /
   * grant), so an ineligible run is simply skipped. On a reserved slot, emits the
   * query; a send failure releases the slot (the cursor is retried, never
   * skipped). Deterministic — tests call it directly.
   */
  async pacerTick(): Promise<PacerReport> {
    let reserved = 0;
    let sent = 0;
    let failed = 0;
    const inflight: Promise<void>[] = [];
    // Fair due-fetch selection (F8): most-overdue pull runs first, actionable-only.
    // A just-committed run's next_fetch_at moves into the future, so a backlog of
    // old runs can't starve a newer eligible one (the oldest-N scan did).
    for (const run of this.runs.listPullDueForFetch(this.now(), this.pageLimit)) {
      const res = this.admission.reserve(run.run_id);
      if (!res.ok) {
        // Don't silently swallow eligibility failures (§11/§12.5):
        //  - past_ttl → set the expiry (fencing) barrier NOW rather than waiting
        //    for the next sweeper pass (the sweeper is still the backstop).
        //  - grant_unavailable → surface `provider_grant_unavailable` so /status
        //    shows the run fetch-paused instead of silently idle.
        // Other reasons (cadence/queue/count/persona) are normal, transient skips.
        if (res.reason === 'past_ttl') {
          this.runService.applyTerminationCause(run, 'expiry');
        } else if (res.reason === 'grant_unavailable') {
          if (run.paused_reason !== 'provider_grant_unavailable') {
            this.runs.setPausedReason(run.run_id, 'provider_grant_unavailable', this.now());
          }
        }
        continue;
      }
      reserved++;
      // Eligibility returned: clear a stale grant-unavailable pause marker so
      // /status stops showing fetch-paused once the grant is valid again.
      if (run.paused_reason === 'provider_grant_unavailable') {
        this.runs.setPausedReason(run.run_id, null, this.now());
      }
      const reservationId = res.reservation_id;
      // Stamp a fresh, unguessable correlation id onto the reservation BEFORE
      // egress (§7): the response-correlation ingress finds the slot by this id.
      // Durable (CAS on `reserved`) so a crash after send still resolves the
      // response. If the slot is no longer `reserved` (a barrier raced the stamp),
      // release and skip — never emit a query for an un-correlatable slot.
      const correlationId = this.newCorrelationId();
      if (!this.reservations.setQueryCorrelation(reservationId, correlationId, this.now())) {
        this.admission.release(reservationId);
        continue;
      }
      inflight.push(
        this.emitQuery({ run, reservationId, cursor: res.cursor, correlationId })
          .then(() => {
            sent++;
          })
          .catch(() => {
            // Egress failed before the query left: release the slot so the run's
            // cursor is retried next tick (the fetched-nothing case). The slot's
            // count / cadence budget is returned. No payload was ever staged.
            failed++;
            this.admission.release(reservationId);
          }),
      );
    }
    await Promise.all(inflight);
    return { reserved, sent, failed };
  }

  /**
   * One dispatch pass (§6.3/§8). Two steps per dispatchable run (active, or
   * draining-permissive before its deadline):
   *
   *  1. RISK GATE — run every owner-`approved` action through `evaluateRisk`
   *     (SAFE → risk_authorized; MODERATE/HIGH within ceiling → risk_pending,
   *     awaiting an explicit owner confirm; BLOCKED / above-ceiling →
   *     policy_refused). The owner `/decide` route only sets `approved`; the
   *     driver re-derives the risk class against the run's live ceiling.
   *  2. CLAIM + SEND — atomically CLAIM every `risk_authorized` action (mint the
   *     stable delegation, advance to `sending`), emit the delegation, and mark it
   *     `dispatched` (or `failed`). `claimDispatch` is the linearization point +
   *     guard; a fenced / expired / locked run's claim fails and nothing is sent.
   *
   * MODERATE/HIGH actions wait in `risk_pending` for the owner's confirm
   * (`authorizeRisk`, an owner action — not the driver). Deterministic — tests
   * call it directly.
   */
  async dispatchTick(): Promise<DispatchReport> {
    let riskEvaluated = 0;
    let claimed = 0;
    let sent = 0;
    let retried = 0;
    // R5-05 — visit ONLY runs that actually have a dispatch-actionable message
    // (approved | risk_authorized | sending), ordered by their oldest such
    // message. This bounds the per-tick fan-out WITHOUT the old
    // `listByState('active'|'draining', 500)` starvation, where the 501st-oldest
    // run's authorized action was hidden forever behind older idle runs. A run
    // must still be active or draining to dispatch (a draining-permissive run
    // keeps sending cause-retained approvals until its deadline; the claim guard
    // enforces the bound).
    const runs = this.messages
      .listRunIdsWithActionableMessages(this.pageLimit)
      .map((runId) => this.runs.getById(runId))
      .filter(
        (r): r is RunRecord => r !== null && (r.state === 'active' || r.state === 'draining'),
      );
    // Collect the delegations to transmit this pass, THEN emit concurrently. Two
    // sources feed the durable outbox (the message row IS the outbox, §8):
    //   (a) freshly-claimed `risk_authorized` actions (claim → `sending`), and
    //   (b) EXISTING `sending` rows — a claim whose send never confirmed (crash
    //       after claim, a prior tick's ambiguous egress, or a cold restart). Both
    //       carry a STABLE `delegation_id`, so re-emitting is at-least-once, never
    //       a second logical action (§6.2).
    const toEmit: { run: RunRecord; message: MessageRecord; delegationId: string }[] = [];
    for (const run of runs) {
      // Step 1 — risk gate on freshly-approved actions (advances SAFE to
      // risk_authorized in-place so step 2 can claim it the same pass).
      for (const msg of this.messages.listByRun(run.run_id)) {
        if (msg.state !== 'approved') continue;
        this.dispatch.evaluateRisk(msg.message_id);
        riskEvaluated++;
      }
      // Step 2 — claim newly-authorized actions + re-collect durable `sending`
      // rows (re-read state; the gate above may have advanced some).
      for (const msg of this.messages.listByRun(run.run_id)) {
        if (msg.state === 'risk_authorized') {
          const outcome = this.dispatch.claimDispatch(msg.message_id);
          if (!outcome.claimed) continue;
          claimed++;
          const claimedMsg = this.messages.getById(msg.message_id);
          if (claimedMsg !== null) {
            toEmit.push({ run, message: claimedMsg, delegationId: outcome.delegation_id });
          }
        } else if (msg.state === 'sending' && msg.delegation_id !== null) {
          // Durable outbox re-drive — resend the SAME delegation id.
          toEmit.push({ run, message: msg, delegationId: msg.delegation_id });
        }
      }
    }
    await Promise.all(
      toEmit.map(({ run, message, delegationId }) => {
        const messageId = message.message_id;
        return this.emitDelegation({ run, message, delegationId })
          .then(() => {
            if (this.dispatch.markDispatched(messageId)) sent++;
          })
          .catch(() => {
            // Egress failed or was AMBIGUOUS (the transport can't prove the effect
            // never left, §6.2). Leave the row `sending` so it resends next tick —
            // NEVER mark it terminal-failed (that would silently drop a possibly-
            // effected action). If it never confirms, the drain-deadline reconcile
            // records `outcome_unknown` (the honest "may have happened" state).
            retried++;
          });
      }),
    );
    return { risk_evaluated: riskEvaluated, claimed, sent, retried };
  }

  /** One combined tick (pacer then dispatch). */
  async tick(): Promise<EngineTickReport> {
    const pacer = await this.pacerTick();
    const dispatch = await this.dispatchTick();
    return { pacer, dispatch };
  }

  /** Start the interval loop. Re-entrancy-guarded so a slow tick never overlaps
   *  itself. Idempotent. */
  start(): void {
    if (this.handle !== null) return;
    this.stopped = false;
    this.handle = this.setIntervalFn(() => {
      // Never begin a new tick once stopped (a fake/real timer that fires in the
      // teardown gap must not send or mutate after disposal), and never overlap.
      if (this.ticking || this.stopped) return;
      this.ticking = true;
      this.activeTick = this.tick()
        .then(() => undefined)
        .catch((err) => {
          // Supervise: a rejected pacer/dispatch tick is logged, never an
          // unhandled rejection that could crash the host.
          this.onError(err);
        })
        .finally(() => {
          this.ticking = false;
          this.activeTick = null;
        });
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

  /** Await the in-flight tick (if any) so a disposer reaches quiescence before
   *  the stores the tick reads/writes are torn down under it. Call after stop(). */
  async drain(): Promise<void> {
    const inFlight = this.activeTick;
    if (inFlight !== null) await inFlight;
  }
}
