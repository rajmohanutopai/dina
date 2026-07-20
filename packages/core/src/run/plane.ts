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

import { AdmissionService } from './admission';
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
import { RunEngine, type EmitDelegationEffect, type EmitQueryEffect } from './engine';
import { SQLiteErasureKeyStore, getErasureKeyStore, type ErasureKeyStore } from './erasure_store';
import {
  RunResponseIngest,
  type PullIngestOutcome,
  type VerifiedRunMessage,
} from './ingest';
import { getMessageRepository, type MessageRecord, type MessageRepository } from './message';
import { PayloadStore, type PersonaCipher } from './payload_store';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository } from './reservation';
import { RunService, setRunService } from './service';
import { RunSweeper, RunTerminationService } from './termination';
import { makeReentrantTxRunner, type TxRunner } from './tx';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** Keyset page size for the terminal-run re-shred recovery scan (§13, E76-09).
 *  Recovery pages the FULL terminal set to exhaustion (not a fixed oldest-N
 *  window) so no crash-gap run is ever stranded; this only bounds each page's
 *  size. `shredRun` is idempotent, so re-visiting already-clean runs is a no-op. */
const RESHRED_PAGE = 500;

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
   *  reclaims expired leases). Run once at boot before starting the loops. */
  recoverOnBoot: () => void;
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
        if (r !== null) messages.expireDecidable(runId, now(), r.expires_at);
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
  });

  const completion = new CompletionService({
    messageRepo: messages,
    receiptRepo: receipts,
    runRepo: runs,
    verifyReceipt: deps.verifyReceipt,
    nowMsFn: now,
  });

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
  });

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
    // discardHeld (locked-arrival spool crypto-shred) composes with the fs-spool
    // adapter (§13, conformance-gated) — left to the erasure store's degraded
    // path until that backend is wired.
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
    }, completionMs);
    (classifyTimer as { unref?: () => void }).unref?.();
    (completionTimer as { unref?: () => void }).unref?.();
    log({ evt: 'run_plane.started', engine_ms: deps.engineIntervalMs ?? 5000, classify_ms: classifyMs });
  };

  const stop = async (): Promise<void> => {
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

  return {
    ingestPullResponse: (correlationId, message) => ingest.ingestPullResponse(correlationId, message),
    ingestExhausted: (correlationId) => ingest.ingestExhausted(correlationId),
    ingestCompletion: (input) => completion.ingestCompletion(input),
    recoverOnBoot,
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
  };
}
