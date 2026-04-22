/**
 * Workflow business-logic layer.
 *
 * Sits on top of the `WorkflowRepository` (pure storage). The service owns:
 *   - Input validation (kind/origin/priority shape-checks).
 *   - Transition validation (`isValidTransition` guard before each state change).
 *   - Event fan-out on lifecycle changes.
 *   - Timestamp injection (seconds for `expires_at`, ms for `created_at` /
 *     `updated_at` — see `repository.ts` for the unit contract).
 *
 * Handlers call the service, not the repository directly.
 *
 * Source: `core/internal/service/workflow.go` (commit 9c01611+).
 */

import {
  AllowedOrigins,
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  isValidTransition,
  type WorkflowEvent,
  type WorkflowTask,
} from './domain';
import { WorkflowConflictError, type WorkflowRepository } from './repository';

/** Input for `WorkflowService.create`. */
export interface CreateWorkflowTaskInput {
  id: string;
  kind: string;
  description: string;
  /** JSON-encoded payload. Shape is kind-specific. */
  payload: string;
  /** Unix SECONDS. Null/undefined = no expiry. */
  expiresAtSec?: number;
  correlationId?: string;
  parentId?: string;
  proposalId?: string;
  priority?: string;
  origin?: string;
  sessionName?: string;
  idempotencyKey?: string;
  /** JSON-encoded policy blob. Optional. */
  policy?: string;
  /** Initial state. Defaults to `created`. */
  initialState?: WorkflowTaskState;
}

/** Structured error surfaces raised by the service. */
export class WorkflowValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export class WorkflowTransitionError extends Error {
  constructor(
    message: string,
    readonly from: WorkflowTaskState,
    readonly to: WorkflowTaskState,
  ) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

/**
 * Payload shape the Response Bridge receives when a delegation task whose
 * payload.type is `service_query_execution` reaches `completed`. Matches
 * the fields `ServiceHandler.createExecutionTaskRaw` persists (see
 * `brain/src/service/service_handler.ts`).
 */
export interface ServiceQueryBridgeContext {
  taskId: string;
  fromDID: string;
  queryId: string;
  capability: string;
  ttlSeconds: number;
  /** JSON string — the task's `result` column as stored by `complete`. */
  resultJSON: string;
  serviceName: string;
  /**
   * GAP-SH-05 / GAP-WIRE-01: the provider's published schema as of
   * task-creation time, captured by `ServiceHandler` into
   * `payload.schema_snapshot`. Propagated here so the Response Bridge
   * can validate the runner's output against the `result` schema the
   * requester saw on AppView — not whatever the live config says at
   * completion time. Absent when the provider publishes no schema for
   * the capability. Field names are snake_case to match main-dina's
   * persisted shape exactly.
   */
  schemaSnapshot?: {
    params: Record<string, unknown>;
    result: Record<string, unknown>;
    schema_hash: string;
  };
}

/**
 * Callback fired from `WorkflowService.complete` when a delegation task
 * with `payload.type === 'service_query_execution'` finishes. The bridge
 * synthesises a `service.response` D2D and hands it to Core's egress —
 * keeping Brain agnostic of the response wire format.
 *
 * Contract: the sender MUST throw (or return a rejected promise) when
 * the outbound send fails. The bridge relies on this to distinguish
 * "delivered — clear the durable stash" from "failed — leave for
 * sweeper retry" (main-dina 4848a934). Silently swallowing errors
 * breaks durability.
 *
 * The completion has already landed when this fires — the sender is
 * called post-completion, so its failure can't roll back the task
 * state.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P3-I01 / I02.
 */
export type ResponseBridgeSender = (ctx: ServiceQueryBridgeContext) => Promise<void>;

/**
 * Prefix marking `internal_stash` entries that hold a pending bridge
 * send waiting to be retried. Format:
 *   `bridge_pending:<JSON-encoded ServiceQueryBridgeContext>`
 */
const BRIDGE_PENDING_PREFIX = 'bridge_pending:';

/**
 * Hard timeout for a single bridge-send attempt. Without this a
 * transport promise that never settles would pin the task in
 * `bridgeInFlight` indefinitely, blocking every subsequent retry
 * (review #1). On timeout the claim is released and the stash is
 * left for the sweeper's next tick.
 */
const BRIDGE_SEND_TIMEOUT_MS = 30_000;

/**
 * Max retries for the post-send `setInternalStash(null)` clear. If
 * the clear keeps failing we eventually give up and push the taskId
 * into `bridgeDeliveredAwaitingClear` so the retry sweeper skips it
 * even though the durable state still shows `bridge_pending:`
 * (review #3).
 */
const STASH_CLEAR_MAX_ATTEMPTS = 3;

/**
 * Generic timeout wrapper — resolves with the task's value or
 * rejects with a timeout Error. The returned promise is backed by
 * the same `Promise.race` idiom used elsewhere in Core.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label}: timeout after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function serialiseBridgeCtx(ctx: ServiceQueryBridgeContext): string {
  // JSON.stringify yields stable keys on a plain object literal;
  // recovery reads the exact shape back.
  return JSON.stringify(ctx);
}

function deserialiseBridgeCtx(raw: string): ServiceQueryBridgeContext | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceQueryBridgeContext>;
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.fromDID !== 'string' ||
      typeof parsed.queryId !== 'string' ||
      typeof parsed.capability !== 'string' ||
      typeof parsed.ttlSeconds !== 'number' ||
      typeof parsed.resultJSON !== 'string' ||
      typeof parsed.serviceName !== 'string'
    ) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      fromDID: parsed.fromDID,
      queryId: parsed.queryId,
      capability: parsed.capability,
      ttlSeconds: parsed.ttlSeconds,
      resultJSON: parsed.resultJSON,
      serviceName: parsed.serviceName,
      schemaSnapshot: parseSchemaSnapshot(parsed.schemaSnapshot),
    };
  } catch {
    return null;
  }
}

/**
 * Accept-or-reject a `schema_snapshot` shape from either the task
 * payload (written by `ServiceHandler`) or a stash ctx (written by
 * `serialiseBridgeCtx`). Returns `undefined` for anything that isn't
 * a plain object with the three required keys — a malformed snapshot
 * shouldn't block the bridge, just skip result validation.
 */
function parseSchemaSnapshot(value: unknown): ServiceQueryBridgeContext['schemaSnapshot'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.params !== 'object' ||
    obj.params === null ||
    typeof obj.result !== 'object' ||
    obj.result === null
  ) {
    return undefined;
  }
  // GAP-WIRE-01: accept either `schema_hash` (main / current mobile)
  // or `schemaHash` (legacy mobile snapshots persisted before the
  // wire-alignment fix). Always emit the canonical snake_case shape
  // so downstream consumers (response_bridge_sender) don't need to
  // branch.
  const hash =
    typeof obj.schema_hash === 'string'
      ? obj.schema_hash
      : typeof obj.schemaHash === 'string'
        ? obj.schemaHash
        : undefined;
  if (hash === undefined) return undefined;
  return {
    params: obj.params as Record<string, unknown>,
    result: obj.result as Record<string, unknown>,
    schema_hash: hash,
  };
}

/** `getWorkflowService` returns null when no repo is wired. */
export interface WorkflowServiceOptions {
  repository: WorkflowRepository;
  /** Returns current ms. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Optional Response Bridge. When set, `complete()` invokes this after a
   * delegation task with `payload.type === 'service_query_execution'` lands
   * so the D2D `service.response` can be emitted. Null/absent = bridging
   * skipped.
   */
  responseBridgeSender?: ResponseBridgeSender | null;
}

const VALID_KINDS = new Set<string>([
  WorkflowTaskKind.Delegation,
  WorkflowTaskKind.Approval,
  WorkflowTaskKind.ServiceQuery,
  WorkflowTaskKind.Timer,
  WorkflowTaskKind.Watch,
  WorkflowTaskKind.Generic,
]);

const VALID_PRIORITIES = new Set<string>([
  WorkflowTaskPriority.UserBlocking,
  WorkflowTaskPriority.Normal,
  WorkflowTaskPriority.Background,
]);

const VALID_ORIGINS = new Set<string>(AllowedOrigins);

export class WorkflowService {
  private readonly repo: WorkflowRepository;
  private readonly nowMsFn: () => number;
  private readonly responseBridgeSender: ResponseBridgeSender | null;
  /**
   * Task IDs whose bridge-send is currently in flight — either the
   * detached initial send fired by `bridgeServiceQueryCompletion`, or
   * an active retry from `retryPendingBridges`. Used to skip a stash
   * that is actively being sent so a slow first attempt can't get
   * resend in parallel by the sweeper (review #1). Cleared when the
   * send resolves (success or failure).
   */
  private readonly bridgeInFlight = new Set<string>();
  /**
   * Detached promises kicked off by `bridgeServiceQueryCompletion` —
   * stored so `flushBridgeInFlight()` (and the test `drainOnce()`)
   * can wait for them to settle deterministically.
   */
  private readonly bridgeDetached = new Set<Promise<unknown>>();
  /**
   * Task IDs whose send DID deliver but whose stash-clear failed. On
   * the next tick the bridge retry skips these — re-sending a
   * delivered response would produce a duplicate envelope at the
   * requester. Cleared only when a subsequent clear lands (review
   * #3).
   */
  private readonly bridgeDeliveredAwaitingClear = new Set<string>();
  /**
   * In-memory fallback for tasks whose INITIAL `setInternalStash`
   * write threw. Without this, an initial-stash failure followed by
   * a send failure would lose the retry record entirely (review #4).
   * The retry sweeper walks this map alongside the durable stash.
   */
  private readonly bridgeInMemoryFallback = new Map<string, ServiceQueryBridgeContext>();
  /**
   * Active `retryPendingBridges` call — `null` when idle. The sweeper
   * tests for this before starting a tick so two overlapping ticks
   * can't race the same batch of stashes (review #1).
   */
  private retryInFlight: Promise<number> | null = null;

  constructor(options: WorkflowServiceOptions) {
    if (!options.repository) {
      throw new Error('WorkflowService: repository is required');
    }
    this.repo = options.repository;
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.responseBridgeSender = options.responseBridgeSender ?? null;
  }

  /** Expose the underlying repository for callers that need read access (e.g. sweepers). */
  store(): WorkflowRepository {
    return this.repo;
  }

  /**
   * Validate, create, and emit a `created` event for a new task.
   * Idempotency is enforced by the repository via the partial unique index;
   * duplicates raise `WorkflowConflictError`.
   */
  create(input: CreateWorkflowTaskInput): WorkflowTask {
    this.validateInput(input);

    const nowMs = this.nowMsFn();
    const task: WorkflowTask = {
      id: input.id,
      kind: input.kind,
      status: input.initialState ?? WorkflowTaskState.Created,
      priority: input.priority ?? WorkflowTaskPriority.Normal,
      description: input.description,
      payload: input.payload,
      result_summary: '',
      policy: input.policy ?? '{}',
      correlation_id: input.correlationId,
      parent_id: input.parentId,
      proposal_id: input.proposalId,
      origin: input.origin ?? '',
      session_name: input.sessionName,
      idempotency_key: input.idempotencyKey,
      expires_at: input.expiresAtSec,
      created_at: nowMs,
      updated_at: nowMs,
    };
    this.repo.create(task);

    // Emit the `created` event. Needs delivery so Brain can observe new
    // tasks (e.g. approval tasks that need operator attention).
    this.repo.appendEvent({
      task_id: task.id,
      at: nowMs,
      event_kind: 'created',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        kind: task.kind,
        state: task.status,
        correlation_id: task.correlation_id ?? '',
      }),
    });
    return task;
  }

  /**
   * Approve a task that's waiting for operator review. Moves
   * `pending_approval → queued` and emits an `approved` event whose
   * `details` embed the task payload so Brain can kick off execution
   * without an extra roundtrip.
   */
  approve(id: string): WorkflowTask {
    const task = this.repo.getById(id);
    if (task === null) {
      throw new WorkflowValidationError(`task "${id}" not found`, 'id');
    }
    this.guardTransition(task.status as WorkflowTaskState, WorkflowTaskState.Queued);
    const nowMs = this.nowMsFn();
    const moved = this.repo.transition(
      id,
      WorkflowTaskState.PendingApproval,
      WorkflowTaskState.Queued,
      nowMs,
    );
    if (!moved) {
      // Either someone else transitioned first, or it was never in
      // pending_approval. Surface as a transition error with current state.
      const fresh = this.repo.getById(id);
      throw new WorkflowTransitionError(
        `task "${id}" cannot be approved from state ${fresh?.status ?? 'unknown'}`,
        (fresh?.status ?? task.status) as WorkflowTaskState,
        WorkflowTaskState.Queued,
      );
    }
    this.repo.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'approved',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        task_payload: task.payload,
        kind: task.kind,
      }),
    });
    const updated = this.repo.getById(id);
    return updated ?? task;
  }

  /**
   * Transition a task to `completed`, attach result + summary, emit the
   * `completed` event. Requires the task to be in an active (non-terminal)
   * state.
   */
  complete(id: string, resultJSON: string, resultSummary: string, agentDID = ''): WorkflowTask {
    const task = this.repo.getById(id);
    if (task === null) {
      throw new WorkflowValidationError(`task "${id}" not found`, 'id');
    }
    this.guardTransition(task.status as WorkflowTaskState, WorkflowTaskState.Completed);
    const eventId = this.repo.completeWithDetails(
      id,
      agentDID,
      resultSummary,
      resultJSON,
      JSON.stringify({ state: 'completed' }),
      this.nowMsFn(),
    );
    if (eventId === 0) {
      throw new WorkflowTransitionError(
        `task "${id}" was terminal before completion landed`,
        task.status as WorkflowTaskState,
        WorkflowTaskState.Completed,
      );
    }
    const updated = this.repo.getById(id);
    this.bridgeServiceQueryCompletion(updated ?? task, resultJSON);
    return updated ?? task;
  }

  /**
   * Fire the Response Bridge if the completed task is a service-query
   * delegation. No-op when the bridge isn't wired, the task isn't a
   * delegation, or the payload isn't JSON / lacks the expected type.
   *
   * Durability (main-dina 4848a934): stash `bridge_pending:<ctx-json>`
   * in the task's `internal_stash` BEFORE calling the sender, clear
   * it on success. A send failure leaves the stash in place so the
   * `BridgePendingSweeper` can retry on a later tick — otherwise a
   * transient D2D failure leaves the requester hanging until TTL
   * expires with no signal.
   *
   * Best-effort: the caller of `complete()` / `fail()` is not blocked
   * on the bridge. The send is launched on a detached promise; the
   * sync stash write happens first so a process crash in the middle
   * still leaves a retryable record.
   */
  private bridgeServiceQueryCompletion(task: WorkflowTask, resultJSON: string): void {
    const send = this.responseBridgeSender;
    if (send === null) return;
    if (task.kind !== WorkflowTaskKind.Delegation) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(task.payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (payload.type !== 'service_query_execution') return;
    const fromDID = typeof payload.from_did === 'string' ? payload.from_did : '';
    const queryId = typeof payload.query_id === 'string' ? payload.query_id : '';
    const capability = typeof payload.capability === 'string' ? payload.capability : '';
    if (fromDID === '' || queryId === '' || capability === '') return;
    const ttlSeconds =
      typeof payload.ttl_seconds === 'number' && Number.isFinite(payload.ttl_seconds)
        ? payload.ttl_seconds
        : 60;
    const serviceName = typeof payload.service_name === 'string' ? payload.service_name : '';
    const schemaSnapshot = parseSchemaSnapshot(payload.schema_snapshot);

    const ctx: ServiceQueryBridgeContext = {
      taskId: task.id,
      fromDID,
      queryId,
      capability,
      ttlSeconds,
      resultJSON,
      serviceName,
      schemaSnapshot,
    };

    // Durable stash BEFORE send. The prefix `bridge_pending:` lets
    // the retry sweeper find this entry via `listTasksWithStashPrefix`.
    //
    // Review #4: if the initial stash write fails, fall back to an
    // in-memory queue so we don't lose the retry record if the send
    // then also fails. `retryPendingBridges` walks both surfaces.
    let stashWritten = false;
    try {
      this.repo.setInternalStash(
        task.id,
        BRIDGE_PENDING_PREFIX + serialiseBridgeCtx(ctx),
        this.nowMsFn(),
      );
      stashWritten = true;
    } catch {
      this.bridgeInMemoryFallback.set(task.id, ctx);
    }

    // Claim in-flight BEFORE firing the detached send (review #1).
    // `retryPendingBridges` checks `bridgeInFlight` and skips any
    // task currently being sent — prevents double-dispatch.
    this.bridgeInFlight.add(task.id);

    // Track the detached promise so `flushBridgeInFlight()` can wait
    // for it deterministically. The set removal happens INSIDE the
    // IIFE's `finally` so any code awaiting `flush` sees an empty
    // `bridgeDetached` set by the time its `Promise.allSettled`
    // continuation runs (a trailing `.finally(...)` chain would fire
    // in a separate microtask and race the flush loop).
    const detachedContainer: { promise: Promise<void> | null } = { promise: null };
    const detached = (async () => {
      try {
        // Review #1: bound the send by a hard timeout so a transport
        // promise that never settles can't pin the in-flight claim
        // forever. On timeout the claim is released (in `finally`)
        // and the stash / fallback is left for the sweeper.
        await withTimeout(send(ctx), BRIDGE_SEND_TIMEOUT_MS, 'bridge.send');
        // Delivered — clear the durable record(s) with bounded retries
        // so a transient SQLite write error doesn't produce a
        // duplicate send on the next tick (review #3).
        await this.clearBridgeRecord(task.id, stashWritten);
      } catch {
        // Timeout OR transport failure — leave stash/fallback in
        // place. The sweeper will retry on a later tick.
      } finally {
        this.bridgeInFlight.delete(task.id);
        if (detachedContainer.promise !== null) {
          this.bridgeDetached.delete(detachedContainer.promise);
        }
      }
    })();
    detachedContainer.promise = detached;
    this.bridgeDetached.add(detached);
    void detached;
  }

  /**
   * Clear the durable stash (or in-memory fallback) for a task whose
   * bridge-send succeeded. Retries up to `STASH_CLEAR_MAX_ATTEMPTS`
   * times on SQLite write error; if all retries fail the taskId is
   * parked in `bridgeDeliveredAwaitingClear` so `retryPendingBridges`
   * knows not to re-dispatch it (review #3). The flag is cleared
   * only when a subsequent clear succeeds.
   */
  private async clearBridgeRecord(taskId: string, stashWritten: boolean): Promise<void> {
    // In-memory fallback first — always succeeds.
    this.bridgeInMemoryFallback.delete(taskId);
    if (!stashWritten) {
      this.bridgeDeliveredAwaitingClear.delete(taskId);
      return;
    }
    for (let attempt = 0; attempt < STASH_CLEAR_MAX_ATTEMPTS; attempt++) {
      try {
        this.repo.setInternalStash(taskId, null, this.nowMsFn());
        this.bridgeDeliveredAwaitingClear.delete(taskId);
        return;
      } catch {
        // Back off slightly before retrying. The repo is likely
        // sync (SQLite via op-sqlite) so a short wait is enough for
        // a mutex contention to clear.
        await new Promise<void>((r) => setTimeout(r, 5 * (attempt + 1)));
      }
    }
    // Out of attempts — record that we delivered but couldn't clear.
    // The retry sweeper checks this set and skips the task so we
    // don't duplicate the send.
    this.bridgeDeliveredAwaitingClear.add(taskId);
  }

  /**
   * Wait for every detached initial-send promise to settle. Used by
   * `drainOnce()` to ensure "complete then retry" ordering is
   * deterministic: without flushing, a caller could see a stash
   * still present right after `drainOnce` resolved even though the
   * send had just delivered (review #7).
   */
  async flushBridgeInFlight(): Promise<void> {
    while (this.bridgeDetached.size > 0) {
      // Snapshot — new promises added concurrently are picked up on
      // the next loop iteration.
      const pending = Array.from(this.bridgeDetached);
      await Promise.allSettled(pending);
    }
  }

  /**
   * Retry every task with a `bridge_pending:` internal_stash entry —
   * called by `BridgePendingSweeper`. Returns the number of stashes
   * that were successfully cleared this tick (i.e. resends that
   * delivered). Best-effort: per-task errors are swallowed so one
   * stuck entry can't block the rest of the batch.
   *
   * Concurrency (review #1):
   *   - Coalesces overlapping calls via `retryInFlight`. A sweeper
   *     tick arriving while the previous tick is still awaiting sends
   *     returns the same promise instead of racing on the same
   *     stashes.
   *   - Skips tasks whose bridge send is already in flight (either
   *     the detached initial send OR a claim we took earlier in this
   *     tick). Without this, a slow first send would be picked up as
   *     pending and resent in parallel → two identical
   *     `service.response` envelopes for one completion.
   */
  retryPendingBridges(limit = 50): Promise<number> {
    if (this.retryInFlight !== null) return this.retryInFlight;
    const send = this.responseBridgeSender;
    if (send === null) return Promise.resolve(0);
    const promise = (async () => {
      let cleared = 0;
      // --- Durable stashes first ---
      const tasks = this.repo.listTasksWithStashPrefix(BRIDGE_PENDING_PREFIX, limit);
      for (const task of tasks) {
        // Skip anything currently being sent (detached initial send
        // or an earlier retry from this tick) — review #1.
        if (this.bridgeInFlight.has(task.id)) continue;
        // Skip tasks that already delivered but whose stash-clear
        // hasn't landed yet — re-sending would duplicate the
        // envelope (review #3). Opportunistically try the clear
        // again here; on success the marker is dropped and the
        // stash is gone, so the next tick won't see it at all.
        if (this.bridgeDeliveredAwaitingClear.has(task.id)) {
          try {
            this.repo.setInternalStash(task.id, null, this.nowMsFn());
            this.bridgeDeliveredAwaitingClear.delete(task.id);
          } catch {
            /* leave for the next tick */
          }
          continue;
        }
        const stash = task.internal_stash;
        if (typeof stash !== 'string' || !stash.startsWith(BRIDGE_PENDING_PREFIX)) continue;
        const ctx = deserialiseBridgeCtx(stash.slice(BRIDGE_PENDING_PREFIX.length));
        if (ctx === null) {
          // Corrupt stash — clear so we don't retry it forever.
          try {
            this.repo.setInternalStash(task.id, null, this.nowMsFn());
          } catch {
            /* ignore */
          }
          continue;
        }
        this.bridgeInFlight.add(task.id);
        try {
          await withTimeout(send(ctx), BRIDGE_SEND_TIMEOUT_MS, 'bridge.send');
          await this.clearBridgeRecord(task.id, true);
          cleared++;
        } catch {
          /* send still failing — leave stash for the next tick */
        } finally {
          this.bridgeInFlight.delete(task.id);
        }
      }
      // --- In-memory fallback queue (review #4) ---
      // Tasks whose initial durable stash failed to write. Process
      // under the same in-flight / awaiting-clear gates.
      const fallback = Array.from(this.bridgeInMemoryFallback.entries()).slice(0, limit);
      for (const [taskId, ctx] of fallback) {
        if (this.bridgeInFlight.has(taskId)) continue;
        if (this.bridgeDeliveredAwaitingClear.has(taskId)) continue;
        this.bridgeInFlight.add(taskId);
        try {
          await withTimeout(send(ctx), BRIDGE_SEND_TIMEOUT_MS, 'bridge.send');
          // Success — drop the in-memory entry and attempt a
          // durable clear (might be a no-op; might finally succeed
          // now that whatever was blocking SQLite is back).
          await this.clearBridgeRecord(taskId, false);
          cleared++;
        } catch {
          /* leave in fallback for the next tick */
        } finally {
          this.bridgeInFlight.delete(taskId);
        }
      }
      return cleared;
    })();
    // Identity-checked cleanup: if another caller arrived after us
    // and installed its own promise, don't clobber theirs. This also
    // avoids a subtle ordering bug where a fully-synchronous
    // opportunistic-clear tick (no awaits on the hot path) would
    // complete its `finally` BEFORE the outer assignment below, and
    // the outer assignment would then install a stale "in-flight"
    // reference that pins subsequent callers out.
    this.retryInFlight = promise;
    promise.finally(() => {
      if (this.retryInFlight === promise) this.retryInFlight = null;
    });
    return promise;
  }

  /** Mark a task as failed with a reason. */
  fail(id: string, errorMsg: string, agentDID = ''): WorkflowTask {
    const task = this.repo.getById(id);
    if (task === null) {
      throw new WorkflowValidationError(`task "${id}" not found`, 'id');
    }
    this.guardTransition(task.status as WorkflowTaskState, WorkflowTaskState.Failed);
    const eventId = this.repo.fail(id, agentDID, errorMsg, this.nowMsFn());
    if (eventId === 0) {
      throw new WorkflowTransitionError(
        `task "${id}" was terminal before failure landed`,
        task.status as WorkflowTaskState,
        WorkflowTaskState.Failed,
      );
    }
    const updated = this.repo.getById(id);
    // Fire the Response Bridge with an error envelope for service-query
    // delegation failures (issue #7). Without this, a runner-side error
    // leaves the requester waiting out TTL with no signal.
    this.bridgeServiceQueryCompletion(
      updated ?? task,
      JSON.stringify({ status: 'error', error: errorMsg }),
    );
    return updated ?? task;
  }

  /**
   * Cancel an active task. No-op on already-terminal tasks (throws
   * `WorkflowTransitionError` so callers see the reason).
   */
  cancel(id: string, reason: string): WorkflowTask {
    const task = this.repo.getById(id);
    if (task === null) {
      throw new WorkflowValidationError(`task "${id}" not found`, 'id');
    }
    this.guardTransition(task.status as WorkflowTaskState, WorkflowTaskState.Cancelled);
    const eventId = this.repo.cancel(id, reason, this.nowMsFn());
    if (eventId === 0) {
      throw new WorkflowTransitionError(
        `task "${id}" was terminal before cancel landed`,
        task.status as WorkflowTaskState,
        WorkflowTaskState.Cancelled,
      );
    }
    const updated = this.repo.getById(id);
    return updated ?? task;
  }

  /**
   * Return events for a task, most-recent last, optionally filtered.
   */
  deliverEventsForTask(
    taskId: string,
    eligibility?: { eventKind?: string; needsDelivery?: boolean },
  ): WorkflowEvent[] {
    const events = this.repo.listEventsForTask(taskId);
    if (eligibility === undefined) return events;
    return events.filter((e) => {
      if (eligibility.eventKind !== undefined && e.event_kind !== eligibility.eventKind) {
        return false;
      }
      if (
        eligibility.needsDelivery !== undefined &&
        e.needs_delivery !== eligibility.needsDelivery
      ) {
        return false;
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private validateInput(input: CreateWorkflowTaskInput): void {
    if (input.id === '') {
      throw new WorkflowValidationError('id is required', 'id');
    }
    if (!VALID_KINDS.has(input.kind)) {
      throw new WorkflowValidationError(
        `kind "${input.kind}" is not a valid WorkflowTaskKind`,
        'kind',
      );
    }
    if (input.priority !== undefined && !VALID_PRIORITIES.has(input.priority)) {
      throw new WorkflowValidationError(
        `priority "${input.priority}" is not a valid WorkflowTaskPriority`,
        'priority',
      );
    }
    if (input.origin !== undefined && !VALID_ORIGINS.has(input.origin)) {
      throw new WorkflowValidationError(
        `origin "${input.origin}" is not on AllowedOrigins`,
        'origin',
      );
    }
    if (input.initialState !== undefined && !isValidInitialState(input.initialState)) {
      throw new WorkflowValidationError(
        `initialState "${input.initialState}" cannot start a new task`,
        'initialState',
      );
    }
    if (
      input.expiresAtSec !== undefined &&
      (!Number.isFinite(input.expiresAtSec) || input.expiresAtSec < 0)
    ) {
      throw new WorkflowValidationError(
        'expiresAtSec must be a non-negative finite number',
        'expiresAtSec',
      );
    }
    if (input.payload === undefined || input.payload === '') {
      throw new WorkflowValidationError(
        'payload is required (use "{}" for an empty payload)',
        'payload',
      );
    }
  }

  private guardTransition(from: WorkflowTaskState, to: WorkflowTaskState): void {
    if (!isValidTransition(from, to)) {
      throw new WorkflowTransitionError(
        `transition ${from} → ${to} is not allowed by ValidTransitions`,
        from,
        to,
      );
    }
  }
}

/**
 * Sensible initial states — only these can seed a new task. A task never
 * starts life in a terminal or claim state.
 */
function isValidInitialState(state: WorkflowTaskState): boolean {
  return (
    state === WorkflowTaskState.Created ||
    state === WorkflowTaskState.Pending ||
    state === WorkflowTaskState.Queued ||
    state === WorkflowTaskState.PendingApproval ||
    state === WorkflowTaskState.Scheduled
  );
}

// ---------------------------------------------------------------------------
// Global accessor — matches the `reminders/service.ts` convention so HTTP
// handlers don't have to thread the service through every caller.
// ---------------------------------------------------------------------------

let instance: WorkflowService | null = null;

export function setWorkflowService(s: WorkflowService | null): void {
  instance = s;
}

export function getWorkflowService(): WorkflowService | null {
  return instance;
}

/** Forward re-export so route files don't import from two locations. */
export { WorkflowConflictError };
