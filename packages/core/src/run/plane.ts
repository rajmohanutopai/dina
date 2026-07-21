/**
 * ISVC-10 — the interactive-run PLANE: the single composition that turns the
 * (already-built, unit-tested) driver classes into a LIVE loop, wired once and
 * called by BOTH boots (server `wire_workflow_plane.ts`, mobile `bootstrap.ts`).
 *
 * Until this, every driver (`RunEngine`, `RunSweeper`, `RunResponseIngest`,
 * `RunClassifyService` timeout sweep, `CompletionService` recovery,
 * `RunTerminationService`) existed only in tests — a `/v1/run/start` wrote a run
 * row and NOTHING ever pulled. `wireRunPlane` constructs them all with the real
 * atomicity (`tx`), the cross-service barrier hook (`RunService`/`Admission`
 * `onBarrier` → `RunTerminationService.onBarrier`), and the egress effects the
 * boot injects, then starts the cadence loops. The D2D receive path calls back
 * into the returned handle (`ingestPullResponse` / `ingestExhausted` /
 * `ingestCompletion`) to feed provider responses into the lifecycle.
 *
 * Core-side only: the plane operates directly on Core's SQLite repos/services,
 * never over a transport. The egress (`emitQuery`/`emitDelegation`) and the
 * completion signature verifier are INJECTED so this file performs no crypto and
 * no transport — the boot supplies the signed D2D sender + ISVC-8 verifier.
 */

import { PersonaLockedError } from '../errors';

import { AdmissionService, setFetchEligibilityProbe } from './admission';
import { renderRunPayloadView } from './card';
import { RunClassifyService, getClassificationJobRepository, type ClassificationJobRepository } from './classification';
import { setCommandTxRunner } from './command_receipt';
import {
  CompletionService,
  getCompletionReceiptRepository,
  type CompletionReceiptRepository,
  type IngestCompletionInput,
  type IngestOutcome,
} from './completion';
import { RunDispatchService, setRunDispatchService, setRunPayloadView } from './dispatch';
import { isRunTerminal } from './domain';
import { RunEngine, type EmitDelegationEffect, type EmitQueryEffect } from './engine';
import { SQLiteErasureKeyStore, getErasureKeyStore, type ErasureKeyStore } from './erasure_store';
import { HeldReplayService, parseSealedRef, type HeldReplayReport } from './held_replay';
import {
  RunResponseIngest,
  parseHeldMessageMeta,
  type PullIngestOutcome,
  type VerifiedRunMessage,
} from './ingest';
import { LockedArrivalStore, type DeviceSealer, type RunSpool } from './locked_arrival';
import { getMessageRepository, type MessageRecord, type MessageRepository } from './message';
import { PayloadStore, type PersonaCipher } from './payload_store';
import { setHeldReplayHook } from './replay_registry';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRecord, type ReservationRepository } from './reservation';
import { RunService, setRunService } from './service';
import { RunSweeper, RunTerminationService } from './termination';
import { makeReentrantTxRunner, type TxRunner } from './tx';


import type { RunRecord } from './domain';
import type { DatabaseAdapter } from '../storage/db_adapter';

/** Keyset page size for the terminal-run re-shred recovery scan (§13, E76-09).
 *  Recovery pages the FULL terminal set to exhaustion (not a fixed oldest-N
 *  window) so no crash-gap run is ever stranded; this only bounds each page's
 *  size. `shredRun` is idempotent, so re-visiting already-clean runs is a no-op. */
const RESHRED_PAGE = 500;
// CA-3 (§13) — default bounded audit/replay window before a terminal message's
// per-payload leaf key is crypto-shredded (overridable via deps for tests).
const MESSAGE_PAYLOAD_SHRED_WINDOW_MS = 5 * 60_000;
// CA-9 — max still-classified messages the boot reconciler re-fires per boot.
const RECONCILE_PAGE = 500;

type Interval = ReturnType<typeof setInterval>;
interface TimerFns {
  setIntervalFn: (cb: () => void, ms: number) => Interval;
  clearIntervalFn: (h: Interval) => void;
}

export interface RunPlaneDeps {
  /** Tier-0 DB (`identity.sqlite`) — provides the atomic `transaction` used by
   *  every driver so an enqueue-commit / barrier / claim / classify is one step,
   *  and backs the envelope payload store. */
  db: DatabaseAdapter;
  /** Persona-DEK wrap/unwrap for the envelope payload store (§13). */
  personaCipher: PersonaCipher;
  /** Whether a persona is currently unlocked (§7 admission / §12.6 classify). */
  isPersonaOpen: (persona: string) => boolean;
  /** Signed D2D `service.query` egress; MUST embed the reservation's
   *  `correlationId` so the provider echoes it and the receive path can match. */
  emitQuery: EmitQueryEffect;
  /** Signed D2D action-delegation egress. */
  emitDelegation: EmitDelegationEffect;
  /** ISVC-8 completion signature/binding verifier. Omitted ⇒ CompletionService's
   *  FAIL-CLOSED default (every completion rejected) — an action never advances
   *  on an unverified receipt. */
  verifyReceipt?: (input: IngestCompletionInput) => boolean;
  /** OPTIONAL override of the bounded classify view Core hands Brain (§9.1/§12.6/
   *  §212 — NO vault context, NO `params`). When omitted the plane's OWN default
   *  runs (E76-06): it decrypts the stored payload for an open persona via the
   *  PayloadStore and renders the card's title/body + the verified content digest,
   *  so an omitted builder is never contentless. */
  buildClassificationView?: (message: MessageRecord) => {
    title: string;
    body: string;
    content_digest: string;
  };
  /** Hardened erasure backend (§13/§20). Omitted ⇒ the durable SQLite
   *  `logical_deletion` backend over `db` — the honest V1 mode. */
  erasureStore?: ErasureKeyStore;
  /** R5-02 — post-commit sink for a message reaching `classified` (§9.1). The
   *  boots wire it to the notification inbox so every classified message lands a
   *  retained Activity entry. Best-effort; never fails classification. */
  onMessageClassified?: (message: MessageRecord, run: RunRecord) => void;
  /** R5-01 — the durable locked-arrival spool + device sealer (§7). When BOTH
   *  are supplied the plane composes the `LockedArrivalStore`: a lock-raced
   *  verified response is durably staged + `held_by_lock`, admitted exactly-once
   *  on unlock, and crypto-shred-discarded on a barrier. Omitted ⇒ the degraded
   *  pre-composition behavior (persona_locked; the response may be re-fetched). */
  runSpool?: RunSpool;
  deviceSealer?: DeviceSealer;
  /** R5-01/§7 — post-commit sink for a held response detected LOST
   *  (`response_lost`). The boots wire it to a `run`-kind notification. */
  onResponseLost?: (run: RunRecord, reservation: ReservationRecord, reason: string) => void;
  /** The ONE re-entrant transaction runner the boot shares with the
   *  command-receipt runner + the owner `RunService` (E76-02). When omitted the
   *  plane builds a private runner over `db` (fine for standalone/test use, but a
   *  real boot MUST inject the shared instance so an owner command's outer
   *  transaction and a nested plane write share a single depth counter). */
  tx?: TxRunner;

  // Repos default to the wired singletons.
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
  messageRepo?: MessageRepository;
  jobRepo?: ClassificationJobRepository;
  completionReceiptRepo?: CompletionReceiptRepository;

  nowMsFn?: () => number;
  /** Pacer+dispatch cadence (default 5s). */
  engineIntervalMs?: number;
  /** Expiry/drain/lease sweeper cadence (default 30s). */
  sweeperIntervalMs?: number;
  /** Classify-timeout fallback sweep cadence (default 10s). */
  classifyIntervalMs?: number;
  /** Completion-recovery (verified_pending re-advance) cadence (default 30s). */
  completionIntervalMs?: number;
  /** CA-3 (§13) — bounded audit/replay window before a terminal message's
   *  payload leaf key is crypto-shredded (default 5 min). */
  messageShredWindowMs?: number;
  /** CA-9 — keyset page size for the boot classified-notification reconciler
   *  (default 500). Small values let tests prove exhaustion across pages. */
  reconcilePageSize?: number;
  setIntervalFn?: (cb: () => void, ms: number) => Interval;
  clearIntervalFn?: (h: Interval) => void;
  /** Structured boot log sink (metadata only — never payload/PII). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface RunPlane {
  /** Feed a verified pull RESPONSE into the reserved slot (D2D receive branch). */
  ingestPullResponse: (correlationId: string, message: VerifiedRunMessage) => PullIngestOutcome;
  /** Feed a verified pull `exhausted` marker into the reserved slot. */
  ingestExhausted: (correlationId: string) => PullIngestOutcome;
  /** Feed a verified action COMPLETION receipt (D2D receive branch). */
  ingestCompletion: (input: IngestCompletionInput) => IngestOutcome;
  /** One idempotent crash-recovery pass (re-advance verified_pending completions;
   *  the engine's dispatch tick re-drives durable `sending` rows; the sweeper
   *  reclaims expired leases; held_by_lock responses for OPEN personas replay).
   *  Run once at boot before starting the loops. */
  recoverOnBoot: () => void;
  /** R5-01 — admit every `held_by_lock` response for a just-unlocked persona
   *  exactly-once (§7). Also fired via the held-replay hook registry from the
   *  Core unlock points; a no-op report when the locked-arrival store is not
   *  composed. */
  replayHeldForPersona: (persona: string) => HeldReplayReport;
  // (start below is sync; stop is async so a disposer can await tick quiescence.)
  /** Start every cadence loop (idempotent). */
  start: () => void;
  /** Stop every cadence loop (idempotent), then await the in-flight engine tick. */
  stop: () => Promise<void>;
  // Exposed for composition tests + boot introspection.
  readonly engine: RunEngine;
  readonly sweeper: RunSweeper;
  readonly classify: RunClassifyService;
  readonly ingest: RunResponseIngest;
  readonly completion: CompletionService;
  readonly termination: RunTerminationService;
  readonly admission: AdmissionService;
  readonly dispatch: RunDispatchService;
  readonly payloads: PayloadStore;
  readonly runService: RunService;
  /** Null when the locked-arrival store is not composed (degraded mode). */
  readonly heldReplay: HeldReplayService | null;
  /** A-04 — the composed locked-arrival store (device-seal staging for lock-
   *  raced responses AND result cards). Null in degraded mode. */
  readonly lockedArrival: LockedArrivalStore | null;
}

function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`wireRunPlane: ${what} must be wired before composing the run plane`);
  return v;
}

/**
 * Compose + wire the interactive-run driver plane. Constructs the full driver
 * set over the wired Tier-0 repos, threads the atomic `tx` + barrier hook, and
 * returns a handle whose `start()` runs the live loops and whose `ingest*`
 * methods the D2D receive path calls. Registers the barrier-wired `RunService`
 * as the singleton (so owner `/v1/run/*` routes act through the same instance).
 */
export function wireRunPlane(deps: RunPlaneDeps): RunPlane {
  const now = deps.nowMsFn ?? (() => Date.now());
  // RE-ENTRANT Tier-0 transaction coordinator. The drivers nest — an admission
  // `commit` transaction calls `RunResponseIngest`'s onCommitted which calls
  // `RunClassifyService.beginClassification`, and `ingestExhausted` nests
  // `applyTerminationCause`. `better-sqlite3-multiple-ciphers` (server) supports
  // savepoints, but `op-sqlite` (mobile) issues a raw `BEGIN` and a nested
  // `BEGIN` throws "cannot start a transaction within a transaction". So the
  // OUTERMOST call opens the real Tier-0 transaction and every nested call joins
  // it (runs inline). A nested throw still propagates to the outer
  // `db.transaction`, which rolls the whole unit back — one atomic step (§5/§6.3).
  // ONE re-entrant Tier-0 transaction coordinator (E76-02). A real boot injects
  // the SAME runner it gave `setCommandTxRunner` + the owner `RunService`, so a
  // command's outer transaction and a nested plane/service write share a single
  // depth counter (op-sqlite forbids a nested `BEGIN`). Standalone/test callers
  // that omit `deps.tx` get a plane-local runner over `db`.
  const tx = deps.tx ?? makeReentrantTxRunner(deps.db);
  // Resolve exactly ONE erasure backend and use it for BOTH the frozen
  // `erasure_mode` probe AND the payload store that holds the leaf keys (Codex/
  // Claude finding): probing one backend while the payload store uses another
  // could advertise `backup_resistant` over ephemeral keys, and an in-memory
  // default would lose every leaf key on restart (weaker than logical_deletion).
  // Default to the DURABLE SQLite logical-deletion backend over the Tier-0 db —
  // never an ephemeral in-memory store for a composition real boots consume.
  const erasure: ErasureKeyStore =
    deps.erasureStore ?? getErasureKeyStore() ?? new SQLiteErasureKeyStore(deps.db);
  const timers: TimerFns = {
    setIntervalFn: deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms)),
    clearIntervalFn: deps.clearIntervalFn ?? ((h) => clearInterval(h)),
  };

  const runs = deps.runRepo ?? need(getRunRepository(), 'run repository');
  const reservations = deps.reservationRepo ?? need(getReservationRepository(), 'reservation repository');
  const messages = deps.messageRepo ?? need(getMessageRepository(), 'message repository');
  const jobs = deps.jobRepo ?? need(getClassificationJobRepository(), 'classification job repository');
  const receipts = deps.completionReceiptRepo ?? need(getCompletionReceiptRepository(), 'completion receipt repository');

  // The barrier hook is mutually recursive: RunService/Admission fire it the
  // instant a barrier row is set, and it invalidates outstanding reservations +
  // fences the undecided set via RunTerminationService — which itself needs
  // runService. `termination` is assigned before any barrier can fire (all
  // construction is synchronous, the first tick is async), so the late-bound
  // closure is safe.
  // Forward-ref holder for the barrier cycle: RunService/Admission fire
  // `onBarrier` → RunTerminationService, which itself needs `runService`. The
  // holder is filled before any barrier can fire (construction is synchronous;
  // the first tick is async), so the late binding is safe.
  const cycle: { termination?: RunTerminationService } = {};
  const onBarrier = (run: { run_id: string }): void => {
    cycle.termination?.onBarrier(run.run_id);
  };

  const runService = new RunService({
    repository: runs,
    nowMsFn: now,
    tx,
    onBarrier,
    // Freeze the mode from the SAME backend the payload store uses (above).
    probeErasure: () => erasure.mode,
  });
  // Owner /v1/run/* routes resolve `getRunService()` — register the barrier +
  // tx-wired instance so control and the driver share one RunService.
  setRunService(runService);
  // E76-02 — register the SAME re-entrant coordinator as the command-receipt
  // runner. An owner command (`/stop`, `/decide`) records its receipt inside
  // this runner and, in the same `compute()`, calls `RunService`/plane writes
  // that reuse `tx`; sharing one depth counter makes the nested write run inline
  // instead of issuing a second `BEGIN` (which op-sqlite rejects → the command
  // would roll back). The plane owns the run-subsystem's Tier-0 transaction, so
  // it also owns this registration (overriding any boot-time default).
  setCommandTxRunner(tx);

  const admission = new AdmissionService({
    runRepo: runs,
    reservationRepo: reservations,
    tx,
    isPersonaOpen: deps.isPersonaOpen,
    nowMsFn: now,
    onBarrier,
    // `outstanding = enqueued_undecided + open_reservations` (§7). Without this
    // provider AdmissionService's default treats committed-but-undecided messages
    // as 0, so a committed message frees its reserved slot yet does not itself
    // consume `queue_cap` — admission could exceed the bounded queue. Feed the
    // real count so the cap holds across the reserve→commit handoff.
    // 81B-07 — expire any decidable message past its own/the run's hard bound
    // BEFORE counting, so a stale message never consumes `queue_cap` at admission.
    counts: {
      enqueuedUndecided: (runId) => {
        const r = runs.getById(runId);
        if (r !== null) {
          // 81B-07b / R2-03 — fencing/expiry must also invalidate the classification
          // lease (§9.1), ATOMICALLY: the job-cancels run inside expireDecidable's
          // commit, so a crash can't leave an `expired` message with a live `pending`
          // job (both repos share this db adapter → one transaction).
          messages.expireDecidable(runId, now(), r.expires_at, (expired) => {
            for (const id of expired) jobs.cancel(id, 'expired', now());
          });
        }
        return messages.countEnqueuedUndecided(runId);
      },
    },
  });

  const dispatch = new RunDispatchService({
    messageRepo: messages,
    runRepo: runs,
    isPersonaOpen: deps.isPersonaOpen,
    nowMsFn: now,
    tx,
  });
  // E76-08 — register the dispatch service so the owner-only confirm-risk route
  // (getRunDispatchService().authorizeRisk) can advance a risk_pending action.
  setRunDispatchService(dispatch);

  const payloads = new PayloadStore({
    db: deps.db,
    erasureStore: erasure,
    personaCipher: deps.personaCipher,
    nowMsFn: now,
  });
  // 81B-06 — register the owner-decision payload view so `/v1/run/:id/status` can
  // render the bounded CardSpec title/body for a classified/risk-pending message.
  // Decrypt only for an OPEN persona (getPayload returns null while locked) + render
  // the same bounded view Brain sees — no `params`, no vault context. A message's
  // payload is stored under its `message_id`.
  setRunPayloadView((messageId, persona) => {
    const plaintext = payloads.getPayload(messageId, persona);
    if (plaintext === null) return { title: '', body: '' };
    return renderRunPayloadView(plaintext);
  });

  // E76-06 — the default Core-owned classify view: decrypt the stored payload for
  // an OPEN persona and render the card's bounded title/body + the VERIFIED content
  // digest (never the randomized ciphertext id in `payload_ref`). A locked /
  // shredded / absent payload yields empty text (Brain is non-load-bearing — the
  // classify-timeout finalizes regardless). A boot MAY override with
  // `deps.buildClassificationView`; omitting it no longer means contentless.
  const defaultClassificationView = (
    m: MessageRecord,
  ): { title: string; body: string; content_digest: string } => {
    const digest = m.content_digest ?? '';
    const run = runs.getById(m.run_id);
    if (run === null || m.payload_ref === null) return { title: '', body: '', content_digest: digest };
    const plaintext = payloads.getPayload(m.message_id, run.persona);
    if (plaintext === null) return { title: '', body: '', content_digest: digest };
    const { title, body } = renderRunPayloadView(plaintext);
    return { title, body, content_digest: digest };
  };

  const classify = new RunClassifyService({
    messageRepo: messages,
    jobRepo: jobs,
    runRepo: runs,
    isPersonaOpen: deps.isPersonaOpen,
    buildClassificationView: deps.buildClassificationView ?? defaultClassificationView,
    nowMsFn: now,
    tx,
    ...(deps.onMessageClassified !== undefined ? { onClassified: deps.onMessageClassified } : {}),
  });

  const completion = new CompletionService({
    messageRepo: messages,
    receiptRepo: receipts,
    runRepo: runs,
    verifyReceipt: deps.verifyReceipt,
    nowMsFn: now,
  });

  // R5-01 — compose the locked-arrival store when the boot supplies a durable
  // spool + device sealer (§7). Without them the plane runs the degraded
  // persona_locked mode (nothing staged) — logged so the gap is visible.
  const lockedArrival =
    deps.runSpool !== undefined && deps.deviceSealer !== undefined
      ? new LockedArrivalStore({
          spool: deps.runSpool,
          deviceSealer: deps.deviceSealer,
          payloadStore: payloads,
          erasureStore: erasure,
        })
      : undefined;
  if (lockedArrival === undefined) {
    deps.log?.({ evt: 'run_plane.locked_arrival_degraded' });
  }

  const ingest = new RunResponseIngest({
    runRepo: runs,
    reservationRepo: reservations,
    messageRepo: messages,
    admission,
    runService,
    classify,
    payloadStore: payloads,
    isPersonaOpen: deps.isPersonaOpen,
    nowMsFn: now,
    tx,
    ...(lockedArrival !== undefined ? { lockedArrival } : {}),
  });

  const heldReplay =
    lockedArrival !== undefined
      ? new HeldReplayService({
          admission,
          classify,
          payloadStore: payloads,
          lockedArrival,
          runRepo: runs,
          reservationRepo: reservations,
          messageRepo: messages,
          isPersonaOpen: deps.isPersonaOpen,
          nowMsFn: now,
          ...(deps.onResponseLost !== undefined ? { onResponseLost: deps.onResponseLost } : {}),
        })
      : null;

  const termination = new RunTerminationService({
    runRepo: runs,
    runService,
    messageRepo: messages,
    reservationRepo: reservations,
    nowMsFn: now,
    tx,
    fenceClassificationJob: (messageId, terminal) => classify.fenceJob(messageId, terminal),
    reconcileClaimed: (messageId) => completion.reconcileAtDeadline(messageId),
    shredPayloads: (runId) => payloads.shredRun(runId),
    // R5-01 — a terminal path that invalidated a `held_by_lock` reservation
    // crypto-shreds + ack-deletes its staged spool blob WITHOUT decryption (§7),
    // POST-COMMIT only (forceTerminate collects in-tx, discards after; a barrier
    // inside an ambient tx leaves the row as staged residue for the sweep —
    // round-A NEW-4). The ref is cleared so the residue scan converges.
    ...(lockedArrival !== undefined
      ? {
          discardHeld: (res: ReservationRecord) => {
            const ref = parseSealedRef(res.sealed_response_ref);
            if (ref !== null) {
              const meta = parseHeldMessageMeta(res.held_message_json);
              lockedArrival.discard(meta?.message_id ?? res.reservation_id, ref);
            }
            reservations.clearSealedRef(res.reservation_id);
          },
        }
      : {}),
  });
  cycle.termination = termination;

  const engine = new RunEngine({
    runRepo: runs,
    messageRepo: messages,
    reservationRepo: reservations,
    admission,
    runService,
    dispatch,
    emitQuery: deps.emitQuery,
    emitDelegation: deps.emitDelegation,
    nowMsFn: now,
    intervalMs: deps.engineIntervalMs,
    // Thread the injected timer seam so ALL four loops (engine, sweeper, +the two
    // wrappers below) are under one boot-controlled/deterministic-test lifecycle.
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    onError: (err) =>
      log({ evt: 'run_plane.engine_tick_failed', error: err instanceof Error ? err.message : String(err) }),
  });

  const sweeper = new RunSweeper({
    // Explicit repos (not just the global singletons) so the plane's chosen
    // stores are swept, and the injected timers for lifecycle control.
    runRepo: runs,
    reservationRepo: reservations,
    runService,
    termination,
    nowMsFn: now,
    intervalMs: deps.sweeperIntervalMs,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    onError: (err) =>
      log({ evt: 'run_plane.sweeper_tick_failed', error: err instanceof Error ? err.message : String(err) }),
  });

  let classifyTimer: Interval | null = null;
  let completionTimer: Interval | null = null;
  const classifyMs = deps.classifyIntervalMs ?? 10_000;
  const completionMs = deps.completionIntervalMs ?? 30_000;
  const log = deps.log ?? (() => undefined);

  // Round-A A-04 (§13 "a result card arriving while the persona is locked is
  // device-sealed like a held fetch and re-wrapped under the persona DEK on
  // unlock") — attach staged result cards whose persona is now open. Loss
  // clears the pointer (the OUTCOME already advanced; a provider re-send can
  // still re-attach via the digest-gated null→non-null upgrade). A terminal
  // run's staged card is crypto-shred-discarded with the run.
  const replayStagedCards = (personaFilter: ((p: string) => boolean) | null): void => {
    if (lockedArrival === undefined) return;
    for (const receipt of receipts.listStagedCards()) {
      const payloadId = `result-${receipt.delegation_id}`;
      const ref = parseSealedRef(receipt.result_card_staged_ref);
      if (ref === null) {
        log({ evt: 'run_plane.staged_card_ref_corrupt', delegation_id: receipt.delegation_id });
        receipts.clearStagedCard(receipt.delegation_id, now());
        continue;
      }
      const run = runs.getById(receipt.run_id);
      if (run === null || isRunTerminal(run.state)) {
        lockedArrival.discard(payloadId, ref);
        receipts.clearStagedCard(receipt.delegation_id, now());
        continue;
      }
      // B-01 convergence — a crash between attach and finalize left the card
      // ATTACHED with its staged pointer intact: just finalize (destroy the
      // staging key, ack the blob) and clear; never re-publish.
      if (receipt.result_card_ref !== null) {
        lockedArrival.finalize(payloadId, ref);
        receipts.clearStagedCard(receipt.delegation_id, now());
        continue;
      }
      if (personaFilter !== null && !personaFilter(run.persona)) continue;
      if (!deps.isPersonaOpen(run.persona)) continue;
      const recovered = lockedArrival.recover(payloadId, ref);
      if (recovered.outcome === 'response_lost') {
        log({
          evt: 'run_plane.staged_card_lost',
          delegation_id: receipt.delegation_id,
          reason: recovered.reason,
        });
        lockedArrival.finalize(payloadId, ref);
        receipts.clearStagedCard(receipt.delegation_id, now());
        continue;
      }
      try {
        const stored = payloads.putPayload({
          payloadId,
          runId: run.run_id,
          persona: run.persona,
          plaintext: recovered.plaintext,
        });
        // B-01 ordering: attach (staged pointer KEPT) → finalize (destroy the
        // staging key, then ack the blob) → clear the pointer. A crash at any
        // boundary converges on the next pass (see the branch above).
        receipts.attachResultCard(receipt.delegation_id, stored.content_id, now());
        lockedArrival.finalize(payloadId, ref);
        receipts.clearStagedCard(receipt.delegation_id, now());
      } catch (err) {
        // Re-locked mid-replay: defer to the next unlock (nothing consumed).
        if (err instanceof PersonaLockedError) continue;
        log({
          evt: 'run_plane.staged_card_attach_failed',
          delegation_id: receipt.delegation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // Round-A A-01/A-02/A-05/NEW-4 — the idempotent STORAGE-MAINTENANCE pass,
  // run at boot recovery and on the completion cadence:
  //   1. Staged residue: any reservation that LEFT the held set with its
  //      `sealed_response_ref` still attached (commit-crash before finalize;
  //      barrier-released inside an ambient tx; lost/skipped) — shred the
  //      staging key (ref-pinned id) + ack the spool blob + clear the ref.
  //   2. Spool orphan GC: spool blobs past a 24h TTL that no live
  //      `held_by_lock` ref reaches (e.g. their ref row was corrupted).
  //   3. Payload-store maintenance: reclaim crashed `prepared` pins + GC
  //      abandoned / published-but-shredded blobs (`sweepMaintenance`).
  const runStorageMaintenance = (): void => {
    try {
      let residue = 0;
      if (lockedArrival !== undefined) {
        for (const res of reservations.listStagedResidue()) {
          const ref = parseSealedRef(res.sealed_response_ref);
          if (ref !== null) {
            const meta = parseHeldMessageMeta(res.held_message_json);
            lockedArrival.discard(meta?.message_id ?? res.reservation_id, ref);
          } else {
            // Metadata-only log (never blob/payload content): the staging key
            // id is unrecoverable — the blob is reaped by the orphan GC below.
            log({ evt: 'run_plane.staged_ref_corrupt', reservation_id: res.reservation_id });
          }
          reservations.clearSealedRef(res.reservation_id);
          residue += 1;
        }
        if (lockedArrival !== undefined && deps.runSpool?.listStaleEntries !== undefined) {
          // §13 reachability: a spool blob is deletable only when NO live
          // reference reaches it. TWO reference sources point into the spool:
          // held reservations (`sealed_response_ref`) AND lock-staged result
          // cards (`result_card_staged_ref`, A-04) — round-B NEW-5: a card
          // under a persona locked past the TTL must SURVIVE this GC (locked
          // sensitive personas stay closed for days; the card attaches on
          // unlock).
          const live = new Set<string>();
          for (const held of reservations.listHeldByLock()) {
            const ref = parseSealedRef(held.sealed_response_ref);
            if (ref !== null) live.add(ref.spool_id);
          }
          for (const receipt of receipts.listStagedCards()) {
            const ref = parseSealedRef(receipt.result_card_staged_ref);
            if (ref !== null) live.add(ref.spool_id);
          }
          // C-02 — an orphan (crash before adoption) is crypto-shredded: the
          // spool row NAMES its staging key, so the GC destroys the key BEFORE
          // deleting the blob (never an ack that leaves a live key behind).
          for (const e of deps.runSpool.listStaleEntries(now() - 86_400_000, 200)) {
            if (!live.has(e.spool_id)) lockedArrival.discardOrphanSpool(e.spool_id, e.staged_key_id);
          }
        }
      }
      // CA-3 (§13) — a message that reached a terminal state has its per-payload
      // leaf key crypto-shredded past a bounded audit/replay window, MID-run, so
      // a long-lived watch/run doesn't retain a day-1 terminal message's key (and
      // its persona-DEK-recoverable ciphertext in WAL/backups) until whole-run
      // termination. Per-payload isolated — live sibling messages keep their
      // keys. Stamp freshly-terminal deadlines, then shred + mark the due ones;
      // sweepMaintenance() below GCs the now-inert blobs in the SAME pass.
      messages.stampTerminalShredDeadlines(
        deps.messageShredWindowMs ?? MESSAGE_PAYLOAD_SHRED_WINDOW_MS,
      );
      let msgShred = 0;
      for (const id of messages.listPayloadShredDue(now(), 200)) {
        payloads.shredPayload(id);
        messages.markPayloadShredded(id);
        msgShred += 1;
      }
      const swept = payloads.sweepMaintenance();
      if (residue > 0 || swept.reclaimed_prepared > 0 || swept.gc_blobs > 0 || msgShred > 0) {
        log({ evt: 'run_plane.storage_maintenance', staged_residue: residue, msg_shred: msgShred, ...swept });
      }
      // A-04 — attach (open persona) or discard (terminal run) staged cards.
      replayStagedCards(null);
    } catch (err) {
      log({
        evt: 'run_plane.storage_maintenance_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const recoverOnBoot = (): void => {
    // Idempotent crash recovery: (a) re-advance any completion that arrived (or
    // was reconciled) before a crash; (b) the engine's dispatch re-drives durable
    // `sending` rows and the sweeper reclaims expired reservation/classify leases;
    // (c) re-shred the payloads of every terminal run — `forceTerminate` finalizes
    // the run durably and THEN crypto-shreds post-commit (termination.ts), so a
    // crash in that gap leaves a terminal run's leaf keys live. `shredRun` is
    // idempotent, so re-running it closes the gap without ever un-shredding a live
    // payload (§13 restart recovery). E76-09: page the FULL terminal set to
    // exhaustion via a `(created_at, run_id)` keyset cursor — NOT a fixed
    // oldest-N window, which would revisit the same oldest runs every boot and
    // strand any newer/later-created crash-gap run's leaf key live indefinitely.
    // Each run is shredded under its own try/catch so one failure can't abort the
    // whole sweep (per-run error isolation).
    try {
      const advanced = completion.recoverAdvance();
      const swept = classify.sweepTimeouts();
      let reshred = 0;
      let reshredFailed = 0;
      for (const state of ['completed', 'stopped', 'expired'] as const) {
        let afterCreatedAt = 0;
        let afterRunId = '';
        for (;;) {
          const batch = runs.listByStateAfter(state, afterCreatedAt, afterRunId, RESHRED_PAGE);
          if (batch.length === 0) break;
          for (const run of batch) {
            try {
              payloads.shredRun(run.run_id);
              reshred += 1;
            } catch (err) {
              reshredFailed += 1;
              log({
                evt: 'run_plane.reshred_failed',
                run_id: run.run_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const last = batch[batch.length - 1];
          afterCreatedAt = last.created_at;
          afterRunId = last.run_id;
          if (batch.length < RESHRED_PAGE) break;
        }
      }
      log({
        evt: 'run_plane.recovered',
        completions_advanced: advanced,
        classify_finalized: swept,
        terminal_reshred: reshred,
        terminal_reshred_failed: reshredFailed,
      });
      // R5-01 — replay any held_by_lock response whose persona is already open
      // (crash after unlock, before/mid replay). Idempotent: an already-admitted
      // message just finalizes; a still-locked persona's items defer.
      if (heldReplay !== null) {
        const replayed = heldReplay.replayAll();
        if (replayed.published > 0 || replayed.lost > 0 || replayed.deferred > 0) {
          log({ evt: 'run_plane.held_replayed', ...replayed });
        }
      }
      // CA-9 — re-fire the classified→Activity sink for every still-`classified`
      // message. The inbox entry is a best-effort post-commit sink: a crash in
      // that gap (or a persistent durable-write failure) can leave a classified
      // ACTION invisible while it still holds an `outstanding` slot in the
      // bounded queue. Re-firing is idempotent — the inbox upserts on
      // `run-msg-<id>` and PRESERVES read state — so an already-notified message
      // re-persists harmlessly and a lost one is restored. Bounded to the
      // undecided `classified` set; on mobile (ephemeral inbox) it also
      // repopulates the Activity list a relaunch would otherwise drop.
      const onClassified = deps.onMessageClassified;
      if (onClassified !== undefined) {
        // Page the FULL classified set to exhaustion via a stable
        // `(created_at, message_id)` keyset — NOT a fixed oldest-N window, which
        // would re-fire the same page every boot and strand the N+1-th lost
        // entry (a re-fire leaves the message `classified`). Many runs can carry
        // more than one page of undecided classifieds.
        const pageSize = deps.reconcilePageSize ?? RECONCILE_PAGE;
        let reNotified = 0;
        let afterCreatedAt = 0;
        let afterMessageId = '';
        for (;;) {
          const batch = messages.listClassifiedAfter(afterCreatedAt, afterMessageId, pageSize);
          if (batch.length === 0) break;
          for (const msg of batch) {
            const run = runs.getById(msg.run_id);
            if (run === null) continue;
            try {
              onClassified(msg, run);
              reNotified += 1;
            } catch {
              /* best-effort — the classified state itself is durable regardless */
            }
          }
          const last = batch[batch.length - 1];
          afterCreatedAt = last.created_at;
          afterMessageId = last.message_id;
          if (batch.length < pageSize) break;
        }
        if (reNotified > 0) log({ evt: 'run_plane.classified_renotified', count: reNotified });
      }
      // Round-A A-01/A-05 — AFTER the replay (held rows are never residue):
      // finalize commit-crash residue, GC spool orphans, reclaim crashed
      // prepared pins, and physically GC inert blobs.
      runStorageMaintenance();
    } catch (err) {
      log({ evt: 'run_plane.recover_failed', error: err instanceof Error ? err.message : String(err) });
    }
  };

  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    engine.start();
    sweeper.start();
    // sweepTimeouts + recoverAdvance have no self-loop — wrap on a cadence.
    classifyTimer = timers.setIntervalFn(() => {
      try {
        classify.sweepTimeouts();
      } catch (err) {
        log({ evt: 'run_plane.classify_sweep_failed', error: err instanceof Error ? err.message : String(err) });
      }
    }, classifyMs);
    completionTimer = timers.setIntervalFn(() => {
      try {
        completion.recoverAdvance();
      } catch (err) {
        log({ evt: 'run_plane.completion_recover_failed', error: err instanceof Error ? err.message : String(err) });
      }
      // A-01/A-05 — the storage-maintenance pass shares the completion cadence
      // (30s default): staged residue from an ambient-tx barrier is shredded
      // shortly after its transaction lands, and payload/spool GC stays bounded.
      runStorageMaintenance();
    }, completionMs);
    (classifyTimer as { unref?: () => void }).unref?.();
    (completionTimer as { unref?: () => void }).unref?.();
    log({ evt: 'run_plane.started', engine_ms: deps.engineIntervalMs ?? 5000, classify_ms: classifyMs });
  };

  const stop = async (): Promise<void> => {
    setHeldReplayHook(null);
    setFetchEligibilityProbe(null);
    if (!started) return;
    started = false;
    // Set the stopped flags + clear the interval handles FIRST so no new tick
    // begins, then await the engine's in-flight tick so a disposer reaches
    // quiescence before the stores it reads/writes are torn down under it (§13).
    engine.stop();
    sweeper.stop();
    if (classifyTimer !== null) timers.clearIntervalFn(classifyTimer);
    if (completionTimer !== null) timers.clearIntervalFn(completionTimer);
    classifyTimer = null;
    completionTimer = null;
    await engine.drain();
  };

  // R5-01 — the persona-unlock points (owner unlock route, agent-grant
  // activation) fire the registry so a held response is admitted the moment its
  // persona reopens. A degraded plane (no spool/sealer) reports zeros.
  const replayHeldForPersona = (persona: string): HeldReplayReport => {
    if (heldReplay === null) return { published: 0, lost: 0, deferred: 0 };
    const report = heldReplay.replayForPersona(persona);
    if (report.published > 0 || report.lost > 0 || report.deferred > 0) {
      log({ evt: 'run_plane.held_replayed', persona, ...report });
    }
    // A-04 — the same unlock also re-wraps any staged result card for this
    // persona under its now-live DEK.
    replayStagedCards((p) => p === persona);
    return report;
  };
  if (heldReplay !== null) {
    setHeldReplayHook((persona) => {
      replayHeldForPersona(persona);
    });
  }
  // A-11 — the owner `/status` route reads the FULL admission-derived
  // fetch-eligibility through this probe (side-effect free `gateReason`).
  setFetchEligibilityProbe((runId) => admission.gateReason(runId));

  return {
    ingestPullResponse: (correlationId, message) => ingest.ingestPullResponse(correlationId, message),
    ingestExhausted: (correlationId) => ingest.ingestExhausted(correlationId),
    ingestCompletion: (input) => completion.ingestCompletion(input),
    recoverOnBoot,
    replayHeldForPersona,
    start,
    stop,
    engine,
    sweeper,
    classify,
    ingest,
    completion,
    termination,
    admission,
    dispatch,
    payloads,
    runService,
    heldReplay,
    lockedArrival: lockedArrival ?? null,
  };
}
