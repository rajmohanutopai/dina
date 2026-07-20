/**
 * Workflow-task SQL repository. Backs the durable workflow_tasks and
 * workflow_events tables added in migration v3.
 *
 * Mirrors `core/internal/adapter/sqlite/workflow.go` from main dina. This
 * file implements the **storage** primitives; business logic (transitions,
 * claim semantics, completion-with-event) lives alongside in `service.ts`
 * (future CORE-P2-F task).
 *
 * Two-tier pattern (matches `reminders/repository.ts`): a global setter
 * hooks in the SQLite-backed `SQLiteWorkflowRepository` at startup; tests
 * may inject `InMemoryWorkflowRepository` instead. When nothing is wired,
 * getters return `null` and business logic runs in a pure in-memory mode.
 *
 * **Sync-by-design — exempt from the async-port rule.** Atomic state
 * transitions (`transition`, `claimDelegationTask`, `claimApprovalForExecution`,
 * `heartbeatTask`, `completeWithEvent`) compose multiple statements
 * inside `db.transaction(fn)`; the callback contract requires the body
 * to run to completion synchronously before COMMIT. Wrapping these in
 * `Promise<T>` would force the transaction to either resolve before
 * COMMIT (breaking atomicity) or block the JS event loop on the inner
 * promise (which the sync DB doesn't support). The underlying
 * `DatabaseAdapter` is already EXEMPT for the same reason. Pinned in
 * `__tests__/port_async_gate.test.ts` EXEMPTED list.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { LOCAL_RUNNER_NAME, isPluginLane } from '@dina/protocol';

import { recordDecisionSafe } from '../plugins/decisions';

import { WorkflowTaskState, isTerminal, type WorkflowEvent, type WorkflowTask } from './domain';
import {
  PLUGIN_RETRY,
  isDeclaredEffectful,
  mayAutoRetry,
  nextRetryAtSec,
  parsePluginEnvelope,
} from './plugin_envelope';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/**
 * P2-10: surface a plugin late report as an owner-facing DECISION (so it shows
 * in Activity), alongside the raw evidence event. `recordLateReport` only fires
 * for plugin tasks, so `task` always carries a plugin envelope here; no-op for
 * anything else. Best-effort — a missing decision repo must not break the
 * completion path.
 */
function surfaceLateReportDecision(task: WorkflowTask | null, verb: string, nowMs: number): void {
  if (task === null) return;
  const envelope = parsePluginEnvelope(task.payload);
  if (envelope === null) return;
  // PLG-28 #2: this runs INSIDE the completion db.transaction — a throwing audit
  // write would roll back the late-report evidence event and surface a 500. The
  // fire-safe wrapper swallows it so the evidence event stays committed.
  recordDecisionSafe({
    installId: envelope.install_id,
    capability: envelope.capability_id,
    decision: 'late_report_received',
    reason: `${verb} lost the claim CAS`,
    nowSec: Math.floor(nowMs / 1000),
  });
}

/**
 * Round-15 #19: cap owner-facing evidence by UTF-8 BYTE budget, not JS string
 * length. `.slice(0, 4096)` bounds UTF-16 code units, so 4096 multibyte (e.g.
 * CJK) chars produce a ~12 KB row — ~3× the intended bound. Truncate on a code-
 * point boundary (astral-safe) once the byte budget is exceeded. Returns the
 * input unchanged when it already fits, matching the prior no-marker behaviour.
 */
export const MAX_EVIDENCE_BYTES = 4096;
const EVIDENCE_TRUNCATION_MARKER = '…[truncated]';
export function capEvidence(s: string): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= MAX_EVIDENCE_BYTES) return s;
  // Round-16 #11: reserve the marker's bytes so the FINAL string (input prefix +
  // marker) honors MAX_EVIDENCE_BYTES. Filling the whole budget and THEN
  // appending the marker overran the advertised cap by the marker's ~14 bytes.
  const budget = MAX_EVIDENCE_BYTES - enc.encode(EVIDENCE_TRUNCATION_MARKER).length;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const chBytes = enc.encode(ch).length;
    if (bytes + chBytes > budget) break;
    out += ch;
    bytes += chBytes;
  }
  return `${out}${EVIDENCE_TRUNCATION_MARKER}`;
}

/**
 * Unit conventions in this file:
 *
 *   - `expires_at` / `nowSec` / `extendSec` — **Unix seconds**. Matches
 *     the wire format (`ttl_seconds` on `service.query`/`service.response`)
 *     and the main-dina Go reference. Compared directly to `expires_at`
 *     inside SQL predicates.
 *
 *   - `updated_at` / `created_at` / `at` / `nowMs` — **Milliseconds**
 *     (whatever `Date.now()` produces). Stored in the DB as ms; never
 *     compared to `expires_at` anywhere, so the two units never mix.
 *
 * Callers crossing HTTP / D2D boundaries convert at that boundary — the
 * Phase-2 HTTP handlers own the `now` capture and pass both units.
 */

/** Error thrown on SQL UNIQUE / PRIMARY KEY collision during insert. */
export class WorkflowConflictError extends Error {
  constructor(
    message: string,
    readonly code: 'duplicate_id' | 'duplicate_idempotency' | 'duplicate_correlation',
  ) {
    super(message);
    this.name = 'WorkflowConflictError';
  }
}

export interface WorkflowRepository {
  // -- core CRUD --
  create(task: WorkflowTask): void;
  getById(id: string): WorkflowTask | null;
  getByProposalId(proposalId: string): WorkflowTask | null;
  getByIdempotencyKey(key: string): WorkflowTask | null;
  getActiveByIdempotencyKey(key: string): WorkflowTask | null;
  getByCorrelationId(corrId: string): WorkflowTask[];

  // -- state mutations --
  /**
   * Atomic state transition — updates ONLY if the current state matches
   * `from`. Returns `true` iff the transition was applied.
   */
  transition(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    updatedAtMs: number,
  ): boolean;

  /**
   * Round-15 #3: atomically transition `from`→`to` AND append the `approved`
   * event in ONE transaction. Returns the new event id, or 0 when the
   * transition didn't match (stale/terminal task). Replaces the two-op
   * service-layer compose that could strand a queued approval with no event.
   */
  approveWithEvent(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    eventDetails: string,
    nowMs: number,
  ): number;

  /** Set the run_id (crash-recovery marker). Returns true if the row exists. */
  setRunId(id: string, runId: string, updatedAtMs: number): boolean;

  /** Set internal_stash. Returns true if the row exists. */
  setInternalStash(id: string, stash: string | null, updatedAtMs: number): boolean;

  /**
   * Reschedule a poll-mode `watch` (PSVC-0). Sets `next_run_at` (SECONDS, the
   * store's unit) on a `kind='watch'`, `state='running'` row WITHOUT changing
   * state; passing `null` clears it (a PAUSE — a null `next_run_at` is never
   * due). Returns true iff a running watch row was updated (a cancelled or
   * missing watch is a no-op). Scoped to watches so it can never perturb a
   * delegation's retry-backoff `next_run_at`.
   */
  setWatchNextRun(id: string, nextRunAtSec: number | null, updatedAtMs: number): boolean;

  /**
   * R4-05 — list the DUE poll-mode watches directly: `kind='watch'`,
   * `state='running'`, `next_run_at` set (NOT null/0 → not paused) and `<= nowSec`,
   * ordered by `next_run_at` ASC (most-overdue first) so a fixed page can never let
   * paused/future rows permanently hide a due watch behind them. `limit` bounds the
   * per-tick burst; ASC-by-due ordering guarantees eventual firing across ticks.
   */
  listDueWatches(nowSec: number, limit: number): WorkflowTask[];

  /**
   * R4-04 — reschedule a fired watch ONLY IF its `next_run_at` still equals the
   * value the sweeper fired (`expectedNextRunAtSec`). A compare-and-set: if a
   * concurrent pause set `next_run_at = null` (or a resume/steer changed it) while
   * the poll was in flight, the CAS misses and the reschedule is dropped — so an
   * in-flight poll can never silently undo a pause. Scoped to running watches.
   * Returns true iff the reschedule was applied.
   */
  rescheduleWatch(
    id: string,
    expectedNextRunAtSec: number,
    newNextRunAtSec: number,
    updatedAtMs: number,
  ): boolean;

  // -- lifecycle helpers --

  /**
   * Specialized lookup for `service.response` ingress: find a
   * service_query task with matching correlation_id (== query_id), peer
   * DID (stored in payload `to_did`), capability (payload `capability`),
   * and an unexpired lifetime. Returns `null` on no match and throws
   * `WorkflowConflictError { code: 'duplicate_correlation' }` on more than
   * one live match (data-integrity violation — callers log + drop).
   */
  findServiceQueryTask(
    queryId: string,
    peerDID: string,
    capability: string,
    nowSec: number,
  ): WorkflowTask | null;

  /**
   * Atomic approval-task claim for execution: `queued → running` AND
   * extend `expires_at` by `extendSec`. Only succeeds when the row is in
   * kind=approval AND state=queued. Returns `false` on any miss so the
   * caller can disambiguate (terminal, wrong kind, already running).
   */
  claimApprovalForExecution(id: string, extendSec: number, nowSec: number): boolean;

  /**
   * Atomic agent-pull claim: picks the oldest `kind=delegation state=queued`
   * task that hasn't expired, transitions it to `running`, stamps
   * `agent_did` + `lease_expires_at`, and appends a `claimed` audit event.
   * Concurrent callers serialize: exactly one wins per task; losers return
   * null (and may retry). Returns the claimed task (with fresh state /
   * agent_did / lease_expires_at) or null when no eligible task exists.
   *
   * This is the server side of `POST /v1/workflow/tasks/claim` used by
   * paired dina-agent instances (role='agent') in the service-discovery path.
   *
   * `runnerFilter` (the daemon's registered runner name) scopes the claim on
   * a multi-runner provider: a non-empty filter only matches tasks whose
   * `requested_runner` equals it OR is unset; an empty filter matches any
   * task (the single-runner default). This is what stops one provider's
   * eta_query daemon from grabbing a price_check task meant for another.
   */
  claimDelegationTask(
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    runnerFilter?: string,
  ): WorkflowTask | null;

  /**
   * Park a RUNNING task as `outcome_unknown` (§9.5): execution started,
   * no terminal report from the executing instance, and Dina cannot
   * know whether the external action occurred. Terminal — nothing
   * transitions out. Returns the event id or 0 when the task is not
   * running.
   *
   * Round-12 #5: `opts.claimId` adds the claim-CAS (`AND claim_id = ?`) so a
   * plugin runner can only park the task it actually holds — required for the
   * schema-rejected-completion path, where an effectful runner's malformed
   * result must terminalize as outcome_unknown (the effect MAY have happened),
   * not `failed`. `opts.evidence` retains the rejected result as reconciliation
   * evidence in the event (never applied to task state; capped).
   */
  markOutcomeUnknown(
    id: string,
    reason: string,
    nowMs: number,
    opts?: { claimId?: string; evidence?: string; agentDID?: string },
  ): number;

  /**
   * Extend a claimed task's lease. Only the agent that holds the claim
   * can heartbeat (agent_did match is required). Returns true on extension,
   * false when task is missing, not running, or held by a different agent.
   */
  heartbeatTask(
    id: string,
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    claimId?: string,
  ): boolean;

  /**
   * Update a running task's progress note. Same caller-agent guard as
   * heartbeat: only the claim holder can update progress.
   */
  updateTaskProgress(
    id: string,
    agentDID: string,
    progressNote: string,
    nowMs: number,
    claimId?: string,
  ): boolean;

  /**
   * Revert tasks whose lease expired (agent died mid-execution) back to
   * `queued` for re-claim. Uses the `running → queued` transition and
   * clears `agent_did` + `lease_expires_at`. Appends a `lease_expired`
   * event per reverted task. Returns the list of reverted tasks so the
   * sweeper can emit audit entries.
   */
  expireLeasedTasks(nowMs: number): WorkflowTask[];

  /**
   * Atomic task completion: target state `completed`, attach `result` +
   * `result_summary` + `agent_did`, and append a `workflow_event` with
   * `event_kind='completed'` and caller-supplied JSON `details`. Returns
   * the new event_id, or `0` on no-such-task / already-terminal.
   */
  completeWithDetails(
    id: string,
    agentDID: string,
    resultSummary: string,
    resultJSON: string,
    eventDetails: string,
    nowMs: number,
    claimId?: string,
  ): number;

  /**
   * When `claimId` is provided the terminal transition is a CAS on
   * `(task_id, claim_id, running)` — the §9.1 lease-token discipline. A
   * stale execution (older claim) loses the CAS: its report is recorded
   * as a `late_report` event (evidence, never a result) and 0 is
   * returned. Legacy agent callers that predate claim tokens omit it
   * and keep the state-only guard + route-level ownership check.
   */

  /**
   * Atomic task failure: target state `failed`, attach `error`, append a
   * `workflow_event` with `event_kind='failed'`. Returns the new event_id
   * or 0 on miss.
   */
  fail(id: string, agentDID: string, errorMsg: string, nowMs: number, claimId?: string): number;

  /**
   * Atomic task cancel: target state `cancelled` + append a cancel event.
   * Only active tasks may cancel — terminal tasks are no-op (returns 0).
   * Returns the new event_id or 0 on miss.
   */
  cancel(id: string, reason: string, nowMs: number): number;

  // -- sweeper surfaces --

  /**
   * List approval tasks whose expiry has passed. Ordered by `expires_at`
   * ASC so the sweeper works oldest-first.
   */
  listExpiringApprovalTasks(nowSec: number, limit: number): WorkflowTask[];

  /**
   * Mark any non-terminal task whose `expires_at` has passed as `failed`
   * with `error='expired'`. Returns the list of tasks that were expired —
   * callers use this to emit audit events or send downstream notifications.
   */
  expireTasks(nowSec: number, nowMs: number): WorkflowTask[];

  // -- events --
  appendEvent(event: Omit<WorkflowEvent, 'event_id'>): number;
  listEventsForTask(taskId: string): WorkflowEvent[];

  /**
   * List events awaiting delivery (needs_delivery=true) whose
   * `next_delivery_at` is due (<= nowMs) AND whose `at >= sinceMs`.
   * Ordered by `at` ASC so older events are delivered first.
   *
   * Passing `sinceMs: 0` returns every due undelivered event; higher
   * values let the delivery scheduler page from a known cursor
   * instead of post-filtering (review #7: post-filtering hid recent
   * events behind older undelivered ones when the batch exceeded
   * the limit).
   */
  listUndeliveredEvents(nowMs: number, sinceMs: number, limit: number): WorkflowEvent[];

  /**
   * List ALL events (delivered + undelivered) since `sinceMs`. Ordered
   * by `at` ASC; capped at `limit`. Used by the diagnostics-oriented
   * `/v1/workflow/events?needs_delivery=false` surface where the
   * delivery scheduler's hot-path filter would hide history (issue #18).
   */
  listAllEventsSince(sinceMs: number, limit: number): WorkflowEvent[];

  /** Mark an event as delivered at `nowMs`. Clears `needs_delivery`. */
  markEventDelivered(eventId: number, nowMs: number): boolean;

  /** Mark an event as acknowledged by its consumer at `nowMs`. */
  markEventAcknowledged(eventId: number, nowMs: number): boolean;

  /**
   * Mark an event as having failed a delivery attempt. Sets
   * `delivery_failed=true`, increments `delivery_attempts`, and pushes
   * `next_delivery_at` out. Returns `true` iff the row exists.
   */
  markEventDeliveryFailed(eventId: number, nextDeliveryAt: number, nowMs: number): boolean;

  // -- diagnostics / sweeper --
  listByKindAndState(kind: string, state: WorkflowTaskState, limit: number): WorkflowTask[];
  /**
   * All NON-terminal tasks on a runner lane (e.g. `plugin:<install>`). Used to
   * terminate in-flight work when an install/device is revoked or uninstalled
   * (P1-4) — the caller `cancel()`s each so running effectful tasks park as
   * `outcome_unknown` and queued ones cancel.
   */
  listNonTerminalByRunner(runner: string): WorkflowTask[];
  /**
   * List tasks whose `internal_stash` value starts with `prefix`. Used by
   * the Response Bridge retry sweeper to find tasks with a pending
   * bridge_pending entry that needs re-sending (main-dina 4848a934).
   * Ordered by `updated_at` ASC so the oldest stuck entries retry first.
   */
  listTasksWithStashPrefix(prefix: string, limit: number): WorkflowTask[];
  size(): number;

  /**
   * Subscribe to newly-created `kind === 'approval'` tasks. Listeners
   * fire synchronously after the row is recorded, with a defensive
   * shallow clone so an observer mutating the task can't corrupt
   * storage. Returns a disposer.
   *
   * The notifications-inbox bridge is the canonical consumer — it surfaces
   * `/v1/agent/validate` proposals + service.query review-policy approvals
   * (both go directly to `workflow_tasks`, bypassing `ApprovalManager`)
   * into the unified Notifications screen.
   *
   * Listeners that throw are isolated — one bad observer must not break
   * the create() path or starve other observers.
   */
  subscribeApprovalCreated(listener: ApprovalCreatedListener): () => void;
}

export type ApprovalCreatedListener = (task: WorkflowTask) => void;

// ---------------------------------------------------------------------------
// Global repository accessor (follows the existing `reminders/repository.ts`
// convention). Startup wires the SQLite-backed instance; tests override via
// `setWorkflowRepository(new InMemoryWorkflowRepository())`.
// ---------------------------------------------------------------------------

let repo: WorkflowRepository | null = null;

export function setWorkflowRepository(r: WorkflowRepository | null): void {
  repo = r;
}

export function getWorkflowRepository(): WorkflowRepository | null {
  return repo;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

const TASK_COLUMNS = `
  id, kind, state, correlation_id, parent_id, proposal_id,
  priority, description, payload, result, result_summary, policy,
  error, requested_runner, assigned_runner, agent_did, run_id,
  progress_note, lease_expires_at, origin, session_name,
  idempotency_key, expires_at, next_run_at, recurrence,
  internal_stash, claim_id, attempt, first_claimed_at,
  created_at, updated_at
`.trim();

/**
 * Terminal-state SQL fragment — ONE definition so every WHERE clause
 * agrees with `domain.ts` TERMINAL_STATES. `outcome_unknown` is
 * terminal (§9.5): a parked effectful task must be as untouchable as
 * a completed one.
 */
const TERMINAL_STATES_SQL = `('completed','failed','cancelled','outcome_unknown','recorded')`;

/** Random per-claim lease token (§9.1). 32 hex chars. */
function newClaimId(): string {
  return bytesToHex(randomBytes(16));
}

type LeaseLossVerdict =
  | { kind: 'requeue'; nextRunAtSec?: number }
  | { kind: 'outcome_unknown' }
  | { kind: 'failed'; error: string };

/**
 * What happens to a RUNNING task whose lease lapsed — ONE decision
 * table shared by the SQLite and in-memory stores so they cannot
 * diverge (§9.1/§9.5):
 *
 *   non-plugin task          → requeue (existing agent behavior).
 *   plugin, idempotent +
 *     inside retry budget    → requeue with exponential backoff.
 *   plugin, declared-effectful otherwise → outcome_unknown.
 *   plugin, declared-read otherwise      → failed (a dead read is not
 *                                          a mystery; §9.5 anti-dilution).
 */
function classifyLeaseLoss(task: WorkflowTask, nowMs: number): LeaseLossVerdict {
  const envelope = parsePluginEnvelope(task.payload);
  if (envelope === null) return { kind: 'requeue' };
  // Round-15 #15: fail CLOSED on a corrupt attempt counter. A non-finite value
  // hydrates to undefined (→ `?? 0` would RESET a maxed-out task to 0 and grant
  // fresh retries); a negative/fractional value slips the `>= MAX_ATTEMPTS`
  // gate. A count we can't trust as a non-negative integer is treated as
  // budget-exhausted, so an EFFECTFUL task fails closed on corrupt metadata
  // rather than auto-retrying a possibly-already-performed side effect.
  const attempt =
    typeof task.attempt === 'number' && Number.isInteger(task.attempt) && task.attempt >= 0
      ? task.attempt
      : PLUGIN_RETRY.MAX_ATTEMPTS;
  if (
    mayAutoRetry({
      envelope,
      attempt,
      firstClaimedAtMs: task.first_claimed_at,
      nowMs,
    })
  ) {
    return { kind: 'requeue', nextRunAtSec: nextRetryAtSec(attempt, nowMs) };
  }
  if (isDeclaredEffectful(envelope)) return { kind: 'outcome_unknown' };
  return {
    kind: 'failed',
    error: 'lease lost — retry not permitted without an idempotency contract (§9.1)',
  };
}

const EVENT_COLUMNS = `
  event_id, task_id, at, event_kind, needs_delivery,
  delivery_attempts, next_delivery_at, delivering_until,
  delivered_at, acknowledged_at, delivery_failed, details
`.trim();

export class SQLiteWorkflowRepository implements WorkflowRepository {
  private readonly approvalListeners = new Set<ApprovalCreatedListener>();

  constructor(private readonly db: DatabaseAdapter) {}

  create(task: WorkflowTask): void {
    // Convention: unset idempotency_key stored as NULL so the partial
    // UNIQUE index does not collide on empty strings.
    const idemKey =
      task.idempotency_key !== undefined && task.idempotency_key !== ''
        ? task.idempotency_key
        : null;
    try {
      this.db.execute(
        `INSERT INTO workflow_tasks (
          id, kind, state, correlation_id, parent_id, proposal_id,
          priority, description, payload, result, result_summary, policy,
          error, requested_runner, assigned_runner, agent_did, run_id,
          progress_note, lease_expires_at, origin, session_name,
          idempotency_key, expires_at, next_run_at, recurrence,
          internal_stash, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          task.id,
          task.kind,
          task.status,
          optionalStr(task.correlation_id),
          optionalStr(task.parent_id),
          optionalStr(task.proposal_id),
          task.priority,
          task.description,
          task.payload,
          optionalStr(task.result),
          task.result_summary,
          task.policy,
          optionalStr(task.error),
          optionalStr(task.requested_runner),
          optionalStr(task.assigned_runner),
          optionalStr(task.agent_did),
          optionalStr(task.run_id),
          optionalStr(task.progress_note),
          task.lease_expires_at ?? null,
          optionalStr(task.origin),
          optionalStr(task.session_name),
          idemKey,
          task.expires_at ?? null,
          task.next_run_at ?? null,
          optionalStr(task.recurrence),
          null, // internal_stash is set via setInternalStash, never on insert
          task.created_at,
          task.updated_at,
        ],
      );
    } catch (err) {
      throw classifyConflict(err, task, idemKey !== null);
    }
    fanOutApprovalCreated(this.approvalListeners, task);
  }

  subscribeApprovalCreated(listener: ApprovalCreatedListener): () => void {
    this.approvalListeners.add(listener);
    return () => {
      this.approvalListeners.delete(listener);
    };
  }

  getById(id: string): WorkflowTask | null {
    const rows = this.db.query(`SELECT ${TASK_COLUMNS} FROM workflow_tasks WHERE id = ?`, [id]);
    return rows.length > 0 ? rowToTask(rows[0]) : null;
  }

  getByProposalId(proposalId: string): WorkflowTask | null {
    if (proposalId === '') return null;
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks WHERE proposal_id = ? LIMIT 1`,
      [proposalId],
    );
    return rows.length > 0 ? rowToTask(rows[0]) : null;
  }

  getByIdempotencyKey(key: string): WorkflowTask | null {
    if (key === '') return null;
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks WHERE idempotency_key = ? LIMIT 1`,
      [key],
    );
    return rows.length > 0 ? rowToTask(rows[0]) : null;
  }

  getActiveByIdempotencyKey(key: string): WorkflowTask | null {
    if (key === '') return null;
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE idempotency_key = ?
         AND state NOT IN ${TERMINAL_STATES_SQL}
       LIMIT 1`,
      [key],
    );
    return rows.length > 0 ? rowToTask(rows[0]) : null;
  }

  getByCorrelationId(corrId: string): WorkflowTask[] {
    if (corrId === '') return [];
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE correlation_id = ? ORDER BY created_at ASC`,
      [corrId],
    );
    return rows.map(rowToTask);
  }

  transition(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    updatedAtMs: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE workflow_tasks SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
      [to, updatedAtMs, id, from],
    );
    return affected > 0;
  }

  approveWithEvent(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    eventDetails: string,
    nowMs: number,
  ): number {
    // Round-15 #3: the state transition and its `approved` event commit in ONE
    // transaction, mirroring completeWithDetails/fail/cancel. The old service-
    // layer compose (transition, then a separate appendEvent) could crash
    // between the two, stranding a `queued` approval with no event to start
    // execution — and a retry then fails because it's no longer pending.
    let eventId = 0;
    this.db.transaction(() => {
      const affected = this.db.run(
        `UPDATE workflow_tasks SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
        [to, nowMs, id, from],
      );
      if (affected === 0) return;
      eventId = this.appendEvent({
        task_id: id,
        at: nowMs,
        event_kind: 'approved',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: eventDetails,
      });
    });
    return eventId;
  }

  setRunId(id: string, runId: string, updatedAtMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_tasks SET run_id = ?, updated_at = ? WHERE id = ?`,
      [runId, updatedAtMs, id],
    );
    return affected > 0;
  }

  setInternalStash(id: string, stash: string | null, updatedAtMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_tasks SET internal_stash = ?, updated_at = ? WHERE id = ?`,
      [stash, updatedAtMs, id],
    );
    return affected > 0;
  }

  setWatchNextRun(id: string, nextRunAtSec: number | null, updatedAtMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_tasks SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND kind = 'watch' AND state = 'running'`,
      [nextRunAtSec, updatedAtMs, id],
    );
    return affected > 0;
  }

  listDueWatches(nowSec: number, limit: number): WorkflowTask[] {
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE kind = 'watch' AND state = 'running'
         AND next_run_at IS NOT NULL AND next_run_at > 0 AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [nowSec, limit],
    );
    return rows.map(rowToTask);
  }

  rescheduleWatch(
    id: string,
    expectedNextRunAtSec: number,
    newNextRunAtSec: number,
    updatedAtMs: number,
  ): boolean {
    // CAS on next_run_at: only reschedule if the row still holds the value the
    // sweeper fired. A pause (→ null) or resume/steer in the interim misses.
    const affected = this.db.run(
      `UPDATE workflow_tasks SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND kind = 'watch' AND state = 'running' AND next_run_at = ?`,
      [newNextRunAtSec, updatedAtMs, id, expectedNextRunAtSec],
    );
    return affected > 0;
  }

  appendEvent(event: Omit<WorkflowEvent, 'event_id'>): number {
    this.db.execute(
      `INSERT INTO workflow_events (
        task_id, at, event_kind, needs_delivery,
        delivery_attempts, next_delivery_at, delivering_until,
        delivered_at, acknowledged_at, delivery_failed, details
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.task_id,
        event.at,
        event.event_kind,
        event.needs_delivery ? 1 : 0,
        event.delivery_attempts,
        event.next_delivery_at ?? null,
        event.delivering_until ?? null,
        event.delivered_at ?? null,
        event.acknowledged_at ?? null,
        event.delivery_failed ? 1 : 0,
        event.details,
      ],
    );
    const rows = this.db.query<{ event_id: number }>(
      `SELECT event_id FROM workflow_events WHERE task_id = ? ORDER BY event_id DESC LIMIT 1`,
      [event.task_id],
    );
    return rows.length > 0 ? Number(rows[0].event_id) : 0;
  }

  listEventsForTask(taskId: string): WorkflowEvent[] {
    const rows = this.db.query(
      `SELECT ${EVENT_COLUMNS} FROM workflow_events WHERE task_id = ? ORDER BY at ASC`,
      [taskId],
    );
    return rows.map(rowToEvent);
  }

  listByKindAndState(kind: string, state: WorkflowTaskState, limit: number): WorkflowTask[] {
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE kind = ? AND state = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [kind, state, limit],
    );
    return rows.map(rowToTask);
  }

  listNonTerminalByRunner(runner: string): WorkflowTask[] {
    if (runner === '') return [];
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE requested_runner = ? AND state NOT IN ${TERMINAL_STATES_SQL}
       ORDER BY created_at ASC`,
      [runner],
    );
    return rows.map(rowToTask);
  }

  listTasksWithStashPrefix(prefix: string, limit: number): WorkflowTask[] {
    // LIKE pattern — escape the SQL wildcards that might appear in the
    // prefix. `prefix` is internal (always a literal like
    // `bridge_pending:`) so the narrow character class is enough.
    const like = prefix.replace(/[%_]/g, (c) => `\\${c}`) + '%';
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE internal_stash LIKE ? ESCAPE '\\'
       ORDER BY updated_at ASC
       LIMIT ?`,
      [like, limit],
    );
    return rows.map(rowToTask);
  }

  findServiceQueryTask(
    queryId: string,
    peerDID: string,
    capability: string,
    nowSec: number,
  ): WorkflowTask | null {
    if (queryId === '' || peerDID === '' || capability === '') return null;
    // Narrow via SQL (kind + correlation + live state + expiry); the
    // payload field match runs in app-layer because the SQLCipher bundle
    // does not ship JSON1.
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE kind = 'service_query'
         AND correlation_id = ?
         AND state IN ('created','running')
         AND (expires_at IS NULL OR expires_at > ?)`,
      [queryId, nowSec],
    );
    const candidates = rows.map(rowToTask);
    return matchPayloadTuple(candidates, peerDID, capability, queryId);
  }

  claimApprovalForExecution(id: string, extendSec: number, nowSec: number): boolean {
    const nowMs = nowSec * 1000;
    // Claim both `queued` (operator-approved) AND `pending_approval`
    // (operator not yet approved). The pending_approval path is used by
    // `/service_deny` + the expiry reconciler to push an "unavailable"
    // response to the requester before the task is cancelled/failed.
    // Issue #10.
    //
    // Review #3: extend from `max(now, expires_at)`, NOT from the
    // stale `expires_at`. Previously an already-expired task would be
    // moved to `running` but keep an expires_at that was ALREADY in
    // the past (old_expires_at + extend might still be < now), which
    // raced badly with the expiry sweeper — the task flipped to
    // running and then the next sweep expired it out from under the
    // executor. SQLite's MAX(nowSec, expires_at) returns a sane
    // floor; nulls collapse to nowSec via COALESCE.
    const affected = this.db.run(
      `UPDATE workflow_tasks
       SET state = 'running',
           expires_at = MAX(COALESCE(expires_at, ?), ?) + ?,
           updated_at = ?
       WHERE id = ? AND kind = 'approval'
         AND state IN ('queued','pending_approval')`,
      [nowSec, nowSec, extendSec, nowMs, id],
    );
    return affected > 0;
  }

  claimDelegationTask(
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    runnerFilter = '',
  ): WorkflowTask | null {
    if (leaseMs <= 0) {
      throw new Error('claimDelegationTask: leaseMs must be positive');
    }
    const nowSec = Math.floor(nowMs / 1000);
    const leaseExpiresAt = nowMs + leaseMs;
    let claimed: WorkflowTask | null = null;
    this.db.transaction(() => {
      // Runner routing — three claim modes (docs/SERVICE_PROVIDER_TIERS.md):
      //   ''            → any task EXCEPT the reserved 'dina.local' lane
      //                   (a generic external daemon claiming a Tier 1
      //                   task would fail a capability it can't run).
      //   'dina.local'  → EXACT match only. The reserved lane does NOT
      //                   get the "non-empty filter also takes untagged
      //                   tasks" convenience: untagged delegations (e.g.
      //                   delegate_to_agent free_form_task) belong to the
      //                   paired external agent — the always-on in-process
      //                   runner must never claim-and-fail them.
      //   other filter  → unset/'' requested_runner OR exact match (the
      //                   single-runner back-compat behavior).
      // Plugin lanes (`plugin:<install_id>`) are EXACT match only, like
      // the reserved dina.local lane: the back-compat "named filter also
      // takes untagged tasks" clause is exactly how a plugin would claim
      // generic agent work (PLUGIN_ARCHITECTURE.md §9.1 launch gate).
      const exactOnly = runnerFilter === LOCAL_RUNNER_NAME || isPluginLane(runnerFilter);
      const runnerClause =
        runnerFilter === ''
          ? `(requested_runner IS NULL OR (requested_runner != ? AND requested_runner NOT LIKE 'plugin:%'))`
          : exactOnly
            ? `requested_runner = ?`
            : `(requested_runner IS NULL OR requested_runner = '' OR requested_runner = ?)`;
      const runnerParam = runnerFilter === '' ? LOCAL_RUNNER_NAME : runnerFilter;
      // `next_run_at` gates claim ELIGIBILITY: a requeued task carrying a
      // retry-backoff timestamp (§9.1) is invisible to claimers until it
      // comes due. NULL / 0 = immediately eligible (legacy rows).
      const rows = this.db.query(
        `SELECT ${TASK_COLUMNS} FROM workflow_tasks
         WHERE kind = 'delegation'
           AND state = 'queued'
           AND (expires_at IS NULL OR expires_at > ?)
           AND (next_run_at IS NULL OR next_run_at = 0 OR next_run_at <= ?)
           AND ${runnerClause}
         ORDER BY created_at ASC
         LIMIT 1`,
        [nowSec, nowSec, runnerParam],
      );
      if (rows.length === 0) return;
      const candidate = rowToTask(rows[0]);
      // §9.1 lease token: every claim mints a fresh claim_id, advances
      // `attempt` (a lease reclaim IS a new attempt), and anchors
      // `first_claimed_at` on the FIRST dispatch only.
      const claimId = newClaimId();
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'running',
             agent_did = ?,
             lease_expires_at = ?,
             claim_id = ?,
             attempt = attempt + 1,
             first_claimed_at = COALESCE(first_claimed_at, ?),
             updated_at = ?
         WHERE id = ? AND state = 'queued'`,
        [agentDID, leaseExpiresAt, claimId, nowMs, nowMs, candidate.id],
      );
      if (affected === 0) return; // race lost — another agent claimed first
      this.appendEvent({
        task_id: candidate.id,
        at: nowMs,
        event_kind: 'claimed',
        needs_delivery: false, // internal audit, not for Brain delivery
        delivery_attempts: 0,
        delivery_failed: false,
        details: JSON.stringify({
          agent_did: agentDID,
          lease_expires_at: leaseExpiresAt,
          claim_id: claimId,
          attempt: (candidate.attempt ?? 0) + 1,
        }),
      });
      claimed = {
        ...candidate,
        status: 'running',
        agent_did: agentDID,
        lease_expires_at: leaseExpiresAt,
        claim_id: claimId,
        attempt: (candidate.attempt ?? 0) + 1,
        first_claimed_at: candidate.first_claimed_at ?? nowMs,
        updated_at: nowMs,
      };
    });
    return claimed;
  }

  heartbeatTask(
    id: string,
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    claimId?: string,
  ): boolean {
    if (leaseMs <= 0) {
      throw new Error('heartbeatTask: leaseMs must be positive');
    }
    const claimClause = claimId !== undefined ? ' AND claim_id = ?' : '';
    const params: unknown[] = [nowMs + leaseMs, nowMs, id, agentDID];
    if (claimId !== undefined) params.push(claimId);
    const affected = this.db.run(
      `UPDATE workflow_tasks
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND agent_did = ?${claimClause}`,
      params,
    );
    return affected > 0;
  }

  updateTaskProgress(
    id: string,
    agentDID: string,
    progressNote: string,
    nowMs: number,
    claimId?: string,
  ): boolean {
    const claimClause = claimId !== undefined ? ' AND claim_id = ?' : '';
    const params: unknown[] = [progressNote, nowMs, id, agentDID];
    if (claimId !== undefined) params.push(claimId);
    const affected = this.db.run(
      `UPDATE workflow_tasks
       SET progress_note = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND agent_did = ?${claimClause}`,
      params,
    );
    return affected > 0;
  }

  expireLeasedTasks(nowMs: number): WorkflowTask[] {
    const reverted: WorkflowTask[] = [];
    this.db.transaction(() => {
      const rows = this.db.query(
        `SELECT ${TASK_COLUMNS} FROM workflow_tasks
         WHERE state = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?`,
        [nowMs],
      );
      for (const row of rows) {
        const task = rowToTask(row);
        const priorAgent = task.agent_did ?? '';
        const verdict = classifyLeaseLoss(task, nowMs);

        if (verdict.kind === 'outcome_unknown') {
          // §9.5: declared-effectful, no idempotency contract — Dina
          // cannot know whether the external action occurred.
          const affected = this.db.run(
            `UPDATE workflow_tasks
             SET state = 'outcome_unknown', error = ?, updated_at = ?
             WHERE id = ? AND state = 'running'`,
            ['lease lost — external outcome unknown', nowMs, task.id],
          );
          if (affected === 0) continue;
          this.appendEvent({
            task_id: task.id,
            at: nowMs,
            event_kind: 'outcome_unknown',
            needs_delivery: true,
            delivery_attempts: 0,
            delivery_failed: false,
            details: JSON.stringify({ previous_agent_did: priorAgent, reason: 'lease_expired' }),
          });
          reverted.push({ ...task, status: 'outcome_unknown', updated_at: nowMs });
          continue;
        }

        if (verdict.kind === 'failed') {
          // §9.1: post-claim, retry trusts nothing — a plugin task
          // without a consented idempotency contract (or past budget)
          // never re-dispatches. Declared-read work is plain failed.
          const affected = this.db.run(
            `UPDATE workflow_tasks
             SET state = 'failed', error = ?, updated_at = ?
             WHERE id = ? AND state = 'running'`,
            [verdict.error, nowMs, task.id],
          );
          if (affected === 0) continue;
          this.appendEvent({
            task_id: task.id,
            at: nowMs,
            event_kind: 'failed',
            needs_delivery: true,
            delivery_attempts: 0,
            delivery_failed: false,
            details: JSON.stringify({ previous_agent_did: priorAgent, error: verdict.error }),
          });
          reverted.push({ ...task, status: 'failed', error: verdict.error, updated_at: nowMs });
          continue;
        }

        // Requeue: legacy tasks unconditionally (existing behavior);
        // plugin tasks only under the consented idempotency contract,
        // with exponential-backoff eligibility via next_run_at (§9.1).
        const nextRunAt = verdict.nextRunAtSec ?? null;
        const affected = this.db.run(
          `UPDATE workflow_tasks
           SET state = 'queued',
               agent_did = NULL,
               lease_expires_at = NULL,
               claim_id = NULL,
               next_run_at = COALESCE(?, next_run_at),
               updated_at = ?
           WHERE id = ? AND state = 'running'`,
          [nextRunAt, nowMs, task.id],
        );
        if (affected === 0) continue;
        this.appendEvent({
          task_id: task.id,
          at: nowMs,
          event_kind: 'lease_expired',
          needs_delivery: false,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({ previous_agent_did: priorAgent }),
        });
        reverted.push({
          ...task,
          status: 'queued',
          agent_did: undefined,
          lease_expires_at: undefined,
          claim_id: undefined,
          ...(nextRunAt !== null ? { next_run_at: nextRunAt } : {}),
          updated_at: nowMs,
        });
      }
    });
    return reverted;
  }

  completeWithDetails(
    id: string,
    agentDID: string,
    resultSummary: string,
    resultJSON: string,
    eventDetails: string,
    nowMs: number,
    claimId?: string,
  ): number {
    let eventId = 0;
    this.db.transaction(() => {
      // §9.1 lease token: with a claimId the terminal transition is a
      // CAS on (task_id, claim_id, running). A stale execution loses
      // the CAS — its report is recorded as evidence, never applied.
      // Defense-in-depth (audit D3): a PLUGIN task (envelope-bearing)
      // may NEVER be terminalized by the state-only guard — that path
      // would let a stale attempt apply over a newer one. Require the
      // token whenever the payload is a plugin envelope, regardless of
      // caller. Round-14 #2: also require it for a task on a plugin LANE — a
      // stripped/corrupt envelope makes `parsePluginEnvelope` null, but the
      // lane still routes it as a plugin invocation, so the state-only guard
      // must not become reachable on that technicality.
      const completeTaskRow = this.getById(id);
      const isPluginTask =
        parsePluginEnvelope(completeTaskRow?.payload ?? '') !== null ||
        isPluginLane(completeTaskRow?.requested_runner ?? '');
      if (isPluginTask && claimId === undefined) {
        this.recordLateReport(id, agentDID, 'no-claim-token', 'complete', nowMs, resultJSON);
        return;
      }
      const guard =
        claimId !== undefined
          ? `state = 'running' AND claim_id = ?`
          : `state NOT IN ${TERMINAL_STATES_SQL}`;
      const params: unknown[] = [resultJSON, resultSummary, agentDID, nowMs, id];
      if (claimId !== undefined) params.push(claimId);
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'completed',
             result = ?,
             result_summary = ?,
             agent_did = ?,
             updated_at = ?
         WHERE id = ? AND ${guard}`,
        params,
      );
      if (affected === 0) {
        if (claimId !== undefined) {
          this.recordLateReport(id, agentDID, claimId, 'complete', nowMs, resultJSON);
        }
        return; // miss → no completed event appended
      }
      eventId = this.appendEvent({
        task_id: id,
        at: nowMs,
        event_kind: 'completed',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: eventDetails,
      });
    });
    return eventId;
  }

  fail(id: string, agentDID: string, errorMsg: string, nowMs: number, claimId?: string): number {
    let eventId = 0;
    this.db.transaction(() => {
      // See completeWithDetails: a plugin task requires the claim token — by
      // envelope OR by plugin lane (Round-14 #2, corrupt-envelope defense).
      const failTaskRow = this.getById(id);
      const isPluginTask =
        parsePluginEnvelope(failTaskRow?.payload ?? '') !== null ||
        isPluginLane(failTaskRow?.requested_runner ?? '');
      if (isPluginTask && claimId === undefined) {
        this.recordLateReport(id, agentDID, 'no-claim-token', 'fail', nowMs, errorMsg);
        return;
      }
      const guard =
        claimId !== undefined
          ? `state = 'running' AND claim_id = ?`
          : `state NOT IN ${TERMINAL_STATES_SQL}`;
      const params: unknown[] = [errorMsg, agentDID, nowMs, id];
      if (claimId !== undefined) params.push(claimId);
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'failed',
             error = ?,
             agent_did = ?,
             updated_at = ?
         WHERE id = ? AND ${guard}`,
        params,
      );
      if (affected === 0) {
        if (claimId !== undefined)
          this.recordLateReport(id, agentDID, claimId, 'fail', nowMs, errorMsg);
        return;
      }
      eventId = this.appendEvent({
        task_id: id,
        at: nowMs,
        event_kind: 'failed',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: JSON.stringify({ error: errorMsg }),
      });
    });
    return eventId;
  }

  /**
   * A report that lost the claim CAS (stale claim, post-revoke, or
   * already-terminal task) — retained as reconciliation EVIDENCE (§14:
   * never applied, never hidden). needs_delivery=false: evidence
   * surfaces via the decision/Activity log, not the result pipeline.
   */
  private recordLateReport(
    id: string,
    agentDID: string,
    claimId: string,
    verb: 'complete' | 'fail',
    nowMs: number,
    reported?: string,
  ): void {
    // Only record when the task actually exists — a late report against
    // a nonexistent id is noise, not evidence.
    const task = this.getById(id);
    if (task === null) return;
    // Retain the REPORTED payload as reconciliation evidence (§14). A late
    // `complete` on an outcome_unknown booking may carry the real external
    // outcome (e.g. a confirmation id) even though the claim CAS lost;
    // discarding it throws away the only proof the effect happened. Never
    // applied to task state — capped so a hostile/huge report can't bloat
    // the event row.
    const detail: Record<string, unknown> = { agent_did: agentDID, claim_id: claimId, verb };
    if (reported !== undefined && reported !== '') {
      detail.report = capEvidence(reported); // Round-15 #19: UTF-8 byte cap, not char length
    }
    this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'late_report',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify(detail),
    });
    surfaceLateReportDecision(task, verb, nowMs); // P2-10
  }

  markOutcomeUnknown(
    id: string,
    reason: string,
    nowMs: number,
    opts?: { claimId?: string; evidence?: string; agentDID?: string },
  ): number {
    let eventId = 0;
    this.db.transaction(() => {
      // §9.5 legal entry: running → outcome_unknown ONLY (execution
      // started, no terminal report). Round-12 #5: an optional claim-CAS
      // (`AND claim_id = ?`) so a runner can only park a task it holds.
      const guard =
        opts?.claimId !== undefined ? `state = 'running' AND claim_id = ?` : `state = 'running'`;
      // Round-13 #10: persist the reporting agent (attribution). The audit
      // surface for a parked EFFECTFUL task must record who produced the
      // uncertain outcome — the worst case to lack attribution on.
      const setAgent =
        opts?.agentDID !== undefined && opts.agentDID !== '' ? `, agent_did = ?` : ``;
      const params: unknown[] = [reason, nowMs];
      if (setAgent !== ``) params.push(opts?.agentDID);
      params.push(id);
      if (opts?.claimId !== undefined) params.push(opts.claimId);
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'outcome_unknown',
             error = ?,
             updated_at = ?${setAgent}
         WHERE id = ? AND ${guard}`,
        params,
      );
      if (affected === 0) {
        // Round-13 #8: a rejected EFFECTFUL result that LOST the claim CAS (stale
        // claim / post-revoke) still carries the only external-reconciliation
        // proof (confirmation/charge id). Retain it as late-report evidence
        // instead of discarding — parity with fail()/complete()'s CAS-loss paths.
        if (opts?.claimId !== undefined) {
          this.recordLateReport(
            id,
            opts.agentDID ?? '',
            opts.claimId,
            'complete',
            nowMs,
            opts.evidence,
          );
        }
        return;
      }
      // Round-12 #5: retain the rejected result as reconciliation evidence
      // (never applied). Capped so a hostile/huge report can't bloat the row.
      // Round-13 #10: also record agent_did + claim_id in the event details.
      const details: Record<string, unknown> = { reason };
      if (opts?.agentDID !== undefined && opts.agentDID !== '') details.agent_did = opts.agentDID;
      if (opts?.claimId !== undefined) details.claim_id = opts.claimId;
      if (opts?.evidence !== undefined && opts.evidence !== '') {
        details.rejected_result = capEvidence(opts.evidence); // Round-15 #19: UTF-8 byte cap
      }
      eventId = this.appendEvent({
        task_id: id,
        at: nowMs,
        event_kind: 'outcome_unknown',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: JSON.stringify(details),
      });
    });
    return eventId;
  }

  cancel(id: string, reason: string, nowMs: number): number {
    // §9.5: owner cancellation of a RUNNING declared-effectful plugin
    // task is the same epistemic situation as lease loss — execution
    // started, no terminal report — so it parks as outcome_unknown,
    // never plain cancelled ("stop tracking — the booking may already
    // have happened"). The generic terminalize-anything path below
    // remains for everything else.
    const before = this.getById(id);
    if (before !== null && before.status === 'running') {
      const envelope = parsePluginEnvelope(before.payload);
      if (envelope !== null && isDeclaredEffectful(envelope)) {
        const eventId = this.markOutcomeUnknown(id, `cancelled by owner: ${reason}`, nowMs);
        // CAS won → parked. CAS lost → the task left `running` between
        // the read and the mark (lease sweep, completion); fall through
        // to the generic cancel so the owner's cancel is never silently
        // dropped — the nonterminal guard below handles every remaining
        // interleaving correctly.
        if (eventId > 0) return eventId;
      }
    }
    let eventId = 0;
    this.db.transaction(() => {
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'cancelled',
             updated_at = ?
         WHERE id = ? AND state NOT IN ${TERMINAL_STATES_SQL}`,
        [nowMs, id],
      );
      if (affected === 0) return;
      eventId = this.appendEvent({
        task_id: id,
        at: nowMs,
        event_kind: 'cancelled',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: JSON.stringify({ reason }),
      });
    });
    return eventId;
  }

  listExpiringApprovalTasks(nowSec: number, limit: number): WorkflowTask[] {
    const rows = this.db.query(
      `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE kind = 'approval'
         AND state IN ('pending_approval','queued')
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT ?`,
      [nowSec, limit],
    );
    return rows.map(rowToTask);
  }

  expireTasks(nowSec: number, nowMs: number): WorkflowTask[] {
    // Find candidates first so callers can observe which tasks were
    // expired (audit + downstream notifications). Then update in a single
    // transaction.
    //
    // GRACE FOR LIVE EXECUTORS: a `running` task whose lease is still
    // alive has an executor actively working (and heartbeating) — yanking
    // it to `failed` mid-run discards a fully-computed result moments
    // before completion (the executor's complete() then hits a terminal
    // task). Such tasks get expired only once their lease lapses (a dead
    // executor) — the lease-expiry sweeper has requeued them by then, or
    // this sweep catches them on the next tick.
    const liveLeaseGuard = `NOT (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?)`;
    const candidates = this.db
      .query(
        `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE state NOT IN ${TERMINAL_STATES_SQL}
         AND expires_at IS NOT NULL
         AND expires_at <= ?
         AND ${liveLeaseGuard}`,
        [nowSec, nowMs],
      )
      .map(rowToTask);
    if (candidates.length === 0) return [];

    // PLG-27 #8: the candidate SELECT above runs OUTSIDE this transaction, so
    // another DB connection can complete/cancel a candidate in the gap before its
    // per-row UPDATE runs. Gate BOTH the terminal event and the returned list on
    // the UPDATE's affected-row count — appending a failed/outcome_unknown event
    // for a task that actually SUCCEEDED is a false terminal notification the
    // downstream consumer (WorkflowEventConsumer → chat) then delivers. Mirrors
    // `fail()` and `expireLeasedTasks()`, which already `continue` on affected 0.
    const transitioned: WorkflowTask[] = [];
    this.db.transaction(() => {
      // Per-row rather than one blanket UPDATE: §9.5 deadline expiry
      // MID-RUN on a declared-effectful plugin task is the same
      // epistemic situation as lease loss — execution started, no
      // terminal report — so it parks as outcome_unknown, never plain
      // failed. Everything else keeps the failed('expired') ending.
      for (const t of candidates) {
        const envelope = t.status === 'running' ? parsePluginEnvelope(t.payload) : null;
        const toUnknown = envelope !== null && isDeclaredEffectful(envelope);
        const affected = this.db.run(
          toUnknown
            ? `UPDATE workflow_tasks
               SET state = 'outcome_unknown', error = ?, updated_at = ?
               WHERE id = ? AND state = 'running'`
            : `UPDATE workflow_tasks
               SET state = 'failed', error = ?, updated_at = ?
               WHERE id = ? AND state NOT IN ${TERMINAL_STATES_SQL}`,
          [toUnknown ? 'expired mid-run — external outcome unknown' : 'expired', nowMs, t.id],
        );
        // Lost the transition (a concurrent terminal write won) — do NOT emit a
        // terminal event and do NOT report the task as expired.
        if (affected === 0) continue;
        // Emit a workflow_event per expired task so downstream consumers
        // (WorkflowEventConsumer → chat formatter) can surface the
        // timeout to the user. Without this, TTL expiry is invisible at
        // the chat surface. Issue #10.
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: toUnknown ? 'outcome_unknown' : 'failed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({
            response_status: 'expired',
            capability: inferCapability(t),
            service_name: inferServiceName(t),
            error: toUnknown ? 'expired mid-run — external outcome unknown' : 'expired',
          }),
        });
        transitioned.push(t);
      }
    });
    return transitioned;
  }

  listUndeliveredEvents(nowMs: number, sinceMs: number, limit: number): WorkflowEvent[] {
    const rows = this.db.query(
      `SELECT ${EVENT_COLUMNS} FROM workflow_events
       WHERE needs_delivery = 1
         AND (next_delivery_at IS NULL OR next_delivery_at <= ?)
         AND at >= ?
       ORDER BY at ASC
       LIMIT ?`,
      [nowMs, sinceMs, limit],
    );
    return rows.map(rowToEvent);
  }

  listAllEventsSince(sinceMs: number, limit: number): WorkflowEvent[] {
    const rows = this.db.query(
      `SELECT ${EVENT_COLUMNS} FROM workflow_events
       WHERE at >= ?
       ORDER BY at ASC
       LIMIT ?`,
      [sinceMs, limit],
    );
    return rows.map(rowToEvent);
  }

  markEventDelivered(eventId: number, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_events
       SET needs_delivery = 0,
           delivered_at = ?,
           delivery_failed = 0
       WHERE event_id = ?`,
      [nowMs, eventId],
    );
    return affected > 0;
  }

  markEventAcknowledged(eventId: number, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_events SET acknowledged_at = ? WHERE event_id = ?`,
      [nowMs, eventId],
    );
    return affected > 0;
  }

  markEventDeliveryFailed(eventId: number, nextDeliveryAt: number, _nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_events
       SET delivery_failed = 1,
           delivery_attempts = delivery_attempts + 1,
           next_delivery_at = ?
       WHERE event_id = ?`,
      [nextDeliveryAt, eventId],
    );
    return affected > 0;
  }

  size(): number {
    const rows = this.db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM workflow_tasks`);
    return rows.length > 0 ? Number(rows[0].c) : 0;
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation — used by tests that want to exercise repository
// behaviour without a real SQLite binding.
// ---------------------------------------------------------------------------

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly tasks = new Map<string, WorkflowTask>();
  private readonly events: WorkflowEvent[] = [];
  private nextEventId = 1;
  private readonly approvalListeners = new Set<ApprovalCreatedListener>();

  create(task: WorkflowTask): void {
    if (this.tasks.has(task.id)) {
      throw new WorkflowConflictError(`duplicate task id: ${task.id}`, 'duplicate_id');
    }
    const idem = task.idempotency_key;
    if (idem !== undefined && idem !== '') {
      for (const other of this.tasks.values()) {
        if (other.idempotency_key === idem && !isTerminal(other.status as WorkflowTaskState)) {
          throw new WorkflowConflictError(
            `duplicate non-terminal idempotency_key: ${idem}`,
            'duplicate_idempotency',
          );
        }
      }
    }
    // Defensive copy so callers mutating the input don't corrupt storage.
    this.tasks.set(task.id, { ...task });
    fanOutApprovalCreated(this.approvalListeners, task);
  }

  subscribeApprovalCreated(listener: ApprovalCreatedListener): () => void {
    this.approvalListeners.add(listener);
    return () => {
      this.approvalListeners.delete(listener);
    };
  }

  getById(id: string): WorkflowTask | null {
    const t = this.tasks.get(id);
    return t !== undefined ? { ...t } : null;
  }

  getByProposalId(proposalId: string): WorkflowTask | null {
    if (proposalId === '') return null;
    for (const t of this.tasks.values()) {
      if (t.proposal_id === proposalId) return { ...t };
    }
    return null;
  }

  getByIdempotencyKey(key: string): WorkflowTask | null {
    if (key === '') return null;
    for (const t of this.tasks.values()) {
      if (t.idempotency_key === key) return { ...t };
    }
    return null;
  }

  getActiveByIdempotencyKey(key: string): WorkflowTask | null {
    if (key === '') return null;
    for (const t of this.tasks.values()) {
      if (t.idempotency_key === key && !isTerminal(t.status as WorkflowTaskState)) {
        return { ...t };
      }
    }
    return null;
  }

  getByCorrelationId(corrId: string): WorkflowTask[] {
    if (corrId === '') return [];
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.correlation_id === corrId) out.push({ ...t });
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  }

  transition(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    updatedAtMs: number,
  ): boolean {
    const t = this.tasks.get(id);
    if (t === undefined || t.status !== from) return false;
    t.status = to;
    t.updated_at = updatedAtMs;
    return true;
  }

  approveWithEvent(
    id: string,
    from: WorkflowTaskState,
    to: WorkflowTaskState,
    eventDetails: string,
    nowMs: number,
  ): number {
    // Round-15 #3 parity: single-threaded — check state, flip, append, all
    // atomic; return 0 (no event) when the transition doesn't match.
    const t = this.tasks.get(id);
    if (t === undefined || t.status !== from) return 0;
    t.status = to;
    t.updated_at = nowMs;
    return this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'approved',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: eventDetails,
    });
  }

  setRunId(id: string, runId: string, updatedAtMs: number): boolean {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    t.run_id = runId;
    t.updated_at = updatedAtMs;
    return true;
  }

  setInternalStash(id: string, stash: string | null, updatedAtMs: number): boolean {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    t.internal_stash = stash ?? undefined;
    t.updated_at = updatedAtMs;
    return true;
  }

  setWatchNextRun(id: string, nextRunAtSec: number | null, updatedAtMs: number): boolean {
    const t = this.tasks.get(id);
    if (t === undefined || t.kind !== 'watch' || t.status !== 'running') return false;
    t.next_run_at = nextRunAtSec ?? undefined;
    t.updated_at = updatedAtMs;
    return true;
  }

  listDueWatches(nowSec: number, limit: number): WorkflowTask[] {
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.kind === 'watch' &&
        t.status === 'running' &&
        t.next_run_at !== undefined &&
        t.next_run_at > 0 &&
        t.next_run_at <= nowSec
      ) {
        out.push({ ...t });
      }
    }
    out.sort((a, b) => (a.next_run_at ?? 0) - (b.next_run_at ?? 0));
    return out.slice(0, limit);
  }

  rescheduleWatch(
    id: string,
    expectedNextRunAtSec: number,
    newNextRunAtSec: number,
    updatedAtMs: number,
  ): boolean {
    const t = this.tasks.get(id);
    if (
      t === undefined ||
      t.kind !== 'watch' ||
      t.status !== 'running' ||
      t.next_run_at !== expectedNextRunAtSec
    ) {
      return false;
    }
    t.next_run_at = newNextRunAtSec;
    t.updated_at = updatedAtMs;
    return true;
  }

  appendEvent(event: Omit<WorkflowEvent, 'event_id'>): number {
    const id = this.nextEventId;
    this.nextEventId += 1;
    this.events.push({ ...event, event_id: id });
    return id;
  }

  listEventsForTask(taskId: string): WorkflowEvent[] {
    return this.events
      .filter((e) => e.task_id === taskId)
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ ...e }));
  }

  listByKindAndState(kind: string, state: WorkflowTaskState, limit: number): WorkflowTask[] {
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.kind === kind && t.status === state) out.push({ ...t });
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out.slice(0, limit);
  }

  listNonTerminalByRunner(runner: string): WorkflowTask[] {
    if (runner === '') return [];
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.requested_runner === runner && !isTerminal(t.status as WorkflowTaskState)) {
        out.push({ ...t });
      }
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  }

  listTasksWithStashPrefix(prefix: string, limit: number): WorkflowTask[] {
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (typeof t.internal_stash === 'string' && t.internal_stash.startsWith(prefix)) {
        out.push({ ...t });
      }
    }
    out.sort((a, b) => a.updated_at - b.updated_at);
    return out.slice(0, limit);
  }

  findServiceQueryTask(
    queryId: string,
    peerDID: string,
    capability: string,
    nowSec: number,
  ): WorkflowTask | null {
    if (queryId === '' || peerDID === '' || capability === '') return null;
    const candidates: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.kind === 'service_query' &&
        t.correlation_id === queryId &&
        (t.status === 'created' || t.status === 'running') &&
        (t.expires_at === undefined || t.expires_at > nowSec)
      ) {
        candidates.push({ ...t });
      }
    }
    return matchPayloadTuple(candidates, peerDID, capability, queryId);
  }

  claimApprovalForExecution(id: string, extendSec: number, nowSec: number): boolean {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    // Parity with SQLiteWorkflowRepository.claimApprovalForExecution —
    // accept both `queued` and `pending_approval` so the deny/expiry
    // paths can claim the approval task for its unavailable response.
    if (t.kind !== 'approval' || (t.status !== 'queued' && t.status !== 'pending_approval')) {
      return false;
    }
    t.status = 'running';
    // Review #3: extend from `max(now, expires_at)` so an already-
    // expired task doesn't keep its stale past expiry. Without this
    // floor, the expiry sweeper could re-expire the task immediately
    // after claim because `old_expires_at + extend` is still < now.
    const base = Math.max(t.expires_at ?? nowSec, nowSec);
    t.expires_at = base + extendSec;
    t.updated_at = nowSec * 1000;
    return true;
  }

  claimDelegationTask(
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    runnerFilter = '',
  ): WorkflowTask | null {
    if (leaseMs <= 0) {
      throw new Error('claimDelegationTask: leaseMs must be positive');
    }
    const nowSec = Math.floor(nowMs / 1000);
    // Pick the oldest queued delegation task that hasn't expired. Runner
    // routing mirrors the SQL store's three claim modes (see the SQL
    // comment): '' = any EXCEPT the reserved 'dina.local' lane;
    // 'dina.local' = EXACT match only (untagged tasks belong to the
    // external agent); other filters = unset/'' or exact match.
    const matchesFilter = (requested: string | undefined): boolean => {
      if (runnerFilter === '') {
        // Generic agents take neither the reserved in-process lane nor
        // any plugin lane (§9.1).
        return (
          requested !== LOCAL_RUNNER_NAME && !(requested !== undefined && isPluginLane(requested))
        );
      }
      if (runnerFilter === LOCAL_RUNNER_NAME || isPluginLane(runnerFilter)) {
        return requested === runnerFilter; // exact only — no untagged convenience
      }
      return requested === undefined || requested === '' || requested === runnerFilter;
    };
    const candidates: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.kind !== 'delegation') continue;
      if (t.status !== 'queued') continue;
      if (t.expires_at !== undefined && t.expires_at <= nowSec) continue;
      // Retry-backoff eligibility gate — parity with the SQL store.
      if (t.next_run_at !== undefined && t.next_run_at !== 0 && t.next_run_at > nowSec) continue;
      if (!matchesFilter(t.requested_runner)) continue;
      candidates.push(t);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.created_at - b.created_at);
    const winner = candidates[0];
    const leaseExpiresAt = nowMs + leaseMs;
    winner.status = 'running';
    winner.agent_did = agentDID;
    winner.lease_expires_at = leaseExpiresAt;
    winner.claim_id = newClaimId();
    winner.attempt = (winner.attempt ?? 0) + 1;
    winner.first_claimed_at = winner.first_claimed_at ?? nowMs;
    winner.updated_at = nowMs;
    // Route through appendEvent so event_id allocation matches every
    // other event (audit D3: the hand-rolled `++this.nextEventId` push
    // collided with appendEvent's post-read scheme, minting duplicate
    // event_ids and corrupting per-event delivery/ack addressing).
    this.appendEvent({
      task_id: winner.id,
      at: nowMs,
      event_kind: 'claimed',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        agent_did: agentDID,
        lease_expires_at: leaseExpiresAt,
        claim_id: winner.claim_id,
        attempt: winner.attempt,
      }),
    });
    return { ...winner };
  }

  heartbeatTask(
    id: string,
    agentDID: string,
    nowMs: number,
    leaseMs: number,
    claimId?: string,
  ): boolean {
    if (leaseMs <= 0) {
      throw new Error('heartbeatTask: leaseMs must be positive');
    }
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status !== 'running' || t.agent_did !== agentDID) return false;
    if (claimId !== undefined && t.claim_id !== claimId) return false;
    t.lease_expires_at = nowMs + leaseMs;
    t.updated_at = nowMs;
    return true;
  }

  updateTaskProgress(
    id: string,
    agentDID: string,
    progressNote: string,
    nowMs: number,
    claimId?: string,
  ): boolean {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status !== 'running' || t.agent_did !== agentDID) return false;
    if (claimId !== undefined && t.claim_id !== claimId) return false;
    t.progress_note = progressNote;
    t.updated_at = nowMs;
    return true;
  }

  expireLeasedTasks(nowMs: number): WorkflowTask[] {
    const reverted: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue;
      if (t.lease_expires_at === undefined) continue;
      if (t.lease_expires_at >= nowMs) continue;
      const priorAgent = t.agent_did ?? '';
      const verdict = classifyLeaseLoss(t, nowMs);
      if (verdict.kind === 'outcome_unknown') {
        t.status = 'outcome_unknown';
        t.error = 'lease lost — external outcome unknown';
        t.updated_at = nowMs;
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: 'outcome_unknown',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({ previous_agent_did: priorAgent, reason: 'lease_expired' }),
        });
        reverted.push({ ...t });
        continue;
      }
      if (verdict.kind === 'failed') {
        t.status = 'failed';
        t.error = verdict.error;
        t.updated_at = nowMs;
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: 'failed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({ previous_agent_did: priorAgent, error: verdict.error }),
        });
        reverted.push({ ...t });
        continue;
      }
      t.status = 'queued';
      t.agent_did = undefined;
      t.lease_expires_at = undefined;
      t.claim_id = undefined;
      if (verdict.nextRunAtSec !== undefined) t.next_run_at = verdict.nextRunAtSec;
      t.updated_at = nowMs;
      this.appendEvent({
        task_id: t.id,
        at: nowMs,
        event_kind: 'lease_expired',
        needs_delivery: false,
        delivery_attempts: 0,
        delivery_failed: false,
        details: JSON.stringify({ previous_agent_did: priorAgent }),
      });
      reverted.push({ ...t });
    }
    return reverted;
  }

  completeWithDetails(
    id: string,
    agentDID: string,
    resultSummary: string,
    resultJSON: string,
    eventDetails: string,
    nowMs: number,
    claimId?: string,
  ): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    // Defense-in-depth parity (audit D3): a plugin task requires the token —
    // by envelope OR by plugin lane (Round-14 #2, corrupt-envelope defense).
    if (
      (parsePluginEnvelope(t.payload) !== null || isPluginLane(t.requested_runner ?? '')) &&
      claimId === undefined
    ) {
      this.recordLateReport(id, agentDID, 'no-claim-token', 'complete', nowMs, resultJSON);
      return 0;
    }
    if (claimId !== undefined) {
      // §9.1 CAS parity with the SQL store: stale claim → late_report
      // evidence, never a result.
      if (t.status !== 'running' || t.claim_id !== claimId) {
        this.recordLateReport(id, agentDID, claimId, 'complete', nowMs, resultJSON);
        return 0;
      }
    } else if (isTerminal(t.status as WorkflowTaskState)) {
      return 0;
    }
    t.status = 'completed';
    t.result = resultJSON;
    t.result_summary = resultSummary;
    t.agent_did = agentDID;
    t.updated_at = nowMs;
    return this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'completed',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: eventDetails,
    });
  }

  fail(id: string, agentDID: string, errorMsg: string, nowMs: number, claimId?: string): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    // Plugin task requires the token — by envelope OR by plugin lane (#2).
    if (
      (parsePluginEnvelope(t.payload) !== null || isPluginLane(t.requested_runner ?? '')) &&
      claimId === undefined
    ) {
      this.recordLateReport(id, agentDID, 'no-claim-token', 'fail', nowMs, errorMsg);
      return 0;
    }
    if (claimId !== undefined) {
      if (t.status !== 'running' || t.claim_id !== claimId) {
        this.recordLateReport(id, agentDID, claimId, 'fail', nowMs, errorMsg);
        return 0;
      }
    } else if (isTerminal(t.status as WorkflowTaskState)) {
      return 0;
    }
    t.status = 'failed';
    t.error = errorMsg;
    t.agent_did = agentDID;
    t.updated_at = nowMs;
    return this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'failed',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({ error: errorMsg }),
    });
  }

  private recordLateReport(
    id: string,
    agentDID: string,
    claimId: string,
    verb: 'complete' | 'fail',
    nowMs: number,
    reported?: string,
  ): void {
    // Parity with the SQL store: retain the reported payload as evidence,
    // capped, never applied (§14).
    const detail: Record<string, unknown> = { agent_did: agentDID, claim_id: claimId, verb };
    if (reported !== undefined && reported !== '') {
      detail.report = capEvidence(reported); // Round-15 #19: UTF-8 byte cap, not char length
    }
    this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'late_report',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify(detail),
    });
    surfaceLateReportDecision(this.tasks.get(id) ?? null, verb, nowMs); // P2-10
  }

  markOutcomeUnknown(
    id: string,
    reason: string,
    nowMs: number,
    opts?: { claimId?: string; evidence?: string; agentDID?: string },
  ): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    // Round-12 #5 claim-CAS parity + Round-13 #8: when the park is rejected
    // (task no longer running, or a claim mismatch) but the caller pinned a
    // claim, retain the rejected result as late-report evidence instead of
    // discarding it (parity with fail()/complete()).
    const casLost =
      t.status !== 'running' || (opts?.claimId !== undefined && t.claim_id !== opts.claimId);
    if (casLost) {
      if (opts?.claimId !== undefined) {
        this.recordLateReport(
          id,
          opts.agentDID ?? '',
          opts.claimId,
          'complete',
          nowMs,
          opts.evidence,
        );
      }
      return 0;
    }
    t.status = 'outcome_unknown';
    t.error = reason;
    t.updated_at = nowMs;
    if (opts?.agentDID !== undefined && opts.agentDID !== '') t.agent_did = opts.agentDID; // Round-13 #10
    const details: Record<string, unknown> = { reason };
    if (opts?.agentDID !== undefined && opts.agentDID !== '') details.agent_did = opts.agentDID;
    if (opts?.claimId !== undefined) details.claim_id = opts.claimId;
    if (opts?.evidence !== undefined && opts.evidence !== '') {
      details.rejected_result = capEvidence(opts.evidence); // Round-15 #19: UTF-8 byte cap
    }
    return this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'outcome_unknown',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify(details),
    });
  }

  cancel(id: string, reason: string, nowMs: number): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    if (isTerminal(t.status as WorkflowTaskState)) return 0;
    // §9.5 parity with the SQL store: cancelling a RUNNING
    // declared-effectful plugin task parks as outcome_unknown.
    if (t.status === 'running') {
      const envelope = parsePluginEnvelope(t.payload);
      if (envelope !== null && isDeclaredEffectful(envelope)) {
        const eventId = this.markOutcomeUnknown(id, `cancelled by owner: ${reason}`, nowMs);
        // Parity with the SQL store's race fall-through (single-threaded
        // here, but the two implementations must not diverge).
        if (eventId > 0) return eventId;
      }
    }
    t.status = 'cancelled';
    t.updated_at = nowMs;
    return this.appendEvent({
      task_id: id,
      at: nowMs,
      event_kind: 'cancelled',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({ reason }),
    });
  }

  listExpiringApprovalTasks(nowSec: number, limit: number): WorkflowTask[] {
    const out: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.kind === 'approval' &&
        (t.status === 'pending_approval' || t.status === 'queued') &&
        t.expires_at !== undefined &&
        t.expires_at <= nowSec
      ) {
        out.push({ ...t });
      }
    }
    out.sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0));
    return out.slice(0, limit);
  }

  expireTasks(nowSec: number, nowMs: number): WorkflowTask[] {
    const expired: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      // Live-executor grace — mirrors the SQL store: a running task with
      // an unexpired lease is actively being worked; expire it only once
      // the lease lapses.
      const hasLiveLease =
        t.status === 'running' && t.lease_expires_at !== undefined && t.lease_expires_at > nowMs;
      if (
        !isTerminal(t.status as WorkflowTaskState) &&
        !hasLiveLease &&
        t.expires_at !== undefined &&
        t.expires_at <= nowSec
      ) {
        expired.push({ ...t });
        // §9.5 parity with the SQL store: deadline expiry MID-RUN on a
        // declared-effectful plugin task → outcome_unknown.
        const envelope = t.status === 'running' ? parsePluginEnvelope(t.payload) : null;
        const toUnknown = envelope !== null && isDeclaredEffectful(envelope);
        t.status = toUnknown ? 'outcome_unknown' : 'failed';
        t.error = toUnknown ? 'expired mid-run — external outcome unknown' : 'expired';
        t.updated_at = nowMs;
        // Parity with SQLiteWorkflowRepository — emit a deliverable
        // event so consumers can surface the TTL expiry to chat.
        // Issue #10.
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: toUnknown ? 'outcome_unknown' : 'failed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({
            response_status: 'expired',
            capability: inferCapability(t),
            service_name: inferServiceName(t),
            error: t.error,
          }),
        });
      }
    }
    return expired;
  }

  listUndeliveredEvents(nowMs: number, sinceMs: number, limit: number): WorkflowEvent[] {
    const out = this.events
      .filter(
        (e) =>
          e.needs_delivery &&
          (e.next_delivery_at === undefined || e.next_delivery_at <= nowMs) &&
          e.at >= sinceMs,
      )
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((e) => ({ ...e }));
    return out;
  }

  listAllEventsSince(sinceMs: number, limit: number): WorkflowEvent[] {
    return this.events
      .filter((e) => e.at >= sinceMs)
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  markEventDelivered(eventId: number, nowMs: number): boolean {
    const e = this.events.find((x) => x.event_id === eventId);
    if (e === undefined) return false;
    e.needs_delivery = false;
    e.delivered_at = nowMs;
    e.delivery_failed = false;
    return true;
  }

  markEventAcknowledged(eventId: number, nowMs: number): boolean {
    const e = this.events.find((x) => x.event_id === eventId);
    if (e === undefined) return false;
    e.acknowledged_at = nowMs;
    return true;
  }

  markEventDeliveryFailed(eventId: number, nextDeliveryAt: number, _nowMs: number): boolean {
    const e = this.events.find((x) => x.event_id === eventId);
    if (e === undefined) return false;
    e.delivery_failed = true;
    e.delivery_attempts += 1;
    e.next_delivery_at = nextDeliveryAt;
    return true;
  }

  size(): number {
    return this.tasks.size;
  }
}

// ---------------------------------------------------------------------------
// Row mappers (exported for tests)
// ---------------------------------------------------------------------------

export function rowToTask(row: DBRow): WorkflowTask {
  return {
    id: String(row.id ?? ''),
    kind: String(row.kind ?? ''),
    status: String(row.state ?? ''), // wire field is "status"; column is "state"
    correlation_id: stringOrUndef(row.correlation_id),
    parent_id: stringOrUndef(row.parent_id),
    proposal_id: stringOrUndef(row.proposal_id),
    priority: String(row.priority ?? ''),
    description: String(row.description ?? ''),
    payload: String(row.payload ?? ''),
    result: stringOrUndef(row.result),
    result_summary: String(row.result_summary ?? ''),
    policy: String(row.policy ?? ''),
    error: stringOrUndef(row.error),
    requested_runner: stringOrUndef(row.requested_runner),
    assigned_runner: stringOrUndef(row.assigned_runner),
    agent_did: stringOrUndef(row.agent_did),
    run_id: stringOrUndef(row.run_id),
    progress_note: stringOrUndef(row.progress_note),
    lease_expires_at: numberOrUndef(row.lease_expires_at),
    origin: stringOrUndef(row.origin),
    session_name: stringOrUndef(row.session_name),
    idempotency_key: stringOrUndef(row.idempotency_key),
    expires_at: numberOrUndef(row.expires_at),
    next_run_at: numberOrUndef(row.next_run_at),
    claim_id: stringOrUndef(row.claim_id),
    attempt: numberOrUndef(row.attempt),
    first_claimed_at: numberOrUndef(row.first_claimed_at),
    recurrence: stringOrUndef(row.recurrence),
    internal_stash: stringOrUndef(row.internal_stash),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

export function rowToEvent(row: DBRow): WorkflowEvent {
  return {
    event_id: Number(row.event_id ?? 0),
    task_id: String(row.task_id ?? ''),
    at: Number(row.at ?? 0),
    event_kind: String(row.event_kind ?? ''),
    needs_delivery: Number(row.needs_delivery ?? 0) === 1,
    delivery_attempts: Number(row.delivery_attempts ?? 0),
    next_delivery_at: numberOrUndef(row.next_delivery_at),
    delivering_until: numberOrUndef(row.delivering_until),
    delivered_at: numberOrUndef(row.delivered_at),
    acknowledged_at: numberOrUndef(row.acknowledged_at),
    delivery_failed: Number(row.delivery_failed ?? 0) === 1,
    details: String(row.details ?? '{}'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter a list of service_query task candidates by `(to_did, capability)`
 * stored in the payload JSON. Matches Go's two-stage filtering (SQL narrows
 * by correlation_id; app-layer matches the rest of the tuple).
 *
 * Returns null on no match; throws `WorkflowConflictError` on >1 match —
 * that indicates a data-integrity violation (duplicate correlation for the
 * same peer/capability), which the handler surface logs + drops.
 */
function matchPayloadTuple(
  candidates: WorkflowTask[],
  peerDID: string,
  capability: string,
  queryId: string,
): WorkflowTask | null {
  const matched: WorkflowTask[] = [];
  for (const t of candidates) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(t.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const toDID = typeof payload.to_did === 'string' ? payload.to_did : '';
    const cap = typeof payload.capability === 'string' ? payload.capability : '';
    if (toDID === peerDID && cap === capability) {
      matched.push(t);
    }
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  throw new WorkflowConflictError(
    `findServiceQueryTask: >1 live match for queryId=${queryId} peer=${peerDID} capability=${capability}`,
    'duplicate_correlation',
  );
}

/**
 * Pull `capability` out of a workflow_task's persisted payload JSON.
 * Returns empty string when the payload is missing, malformed, or does
 * not include a capability field. Used to populate workflow_event
 * details for expiry fan-out (issue #10).
 */
function inferCapability(task: WorkflowTask): string {
  if (!task.payload) return '';
  try {
    const p = JSON.parse(task.payload) as { capability?: unknown };
    return typeof p.capability === 'string' ? p.capability : '';
  } catch {
    return '';
  }
}

/**
 * Pull `service_name` out of the payload JSON. Same contract as
 * inferCapability — empty string on any parse failure.
 */
function inferServiceName(task: WorkflowTask): string {
  if (!task.payload) return '';
  try {
    const p = JSON.parse(task.payload) as { service_name?: unknown };
    return typeof p.service_name === 'string' ? p.service_name : '';
  } catch {
    return '';
  }
}

function optionalStr(v: string | undefined): string | null {
  return v === undefined || v === '' ? null : v;
}

/**
 * Fan out a freshly-created approval task to subscribers. Shared between
 * `SQLiteWorkflowRepository` and `InMemoryWorkflowRepository` so the
 * inbox bridge fires identically regardless of which backend runs.
 *
 * Three guarantees:
 *   1. Non-approval tasks are skipped — listeners are explicitly the
 *      Notifications-inbox surface for approval-class tasks (see
 *      `WorkflowRepository.subscribeApprovalCreated`).
 *   2. Each listener receives a defensive shallow clone — a faulty
 *      observer mutating the task can't poison the canonical row that
 *      was just persisted.
 *   3. Errors are isolated — one bad observer must not break the
 *      `create()` path or starve other observers. Mirrors
 *      `ApprovalManager.requestApproval`'s try/swallow contract.
 */
function fanOutApprovalCreated(
  listeners: ReadonlySet<ApprovalCreatedListener>,
  task: WorkflowTask,
): void {
  if (task.kind !== 'approval') return;
  if (listeners.size === 0) return;
  for (const fn of listeners) {
    try {
      fn({ ...task });
    } catch {
      /* swallow — see contract above */
    }
  }
}

function stringOrUndef(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
}

function numberOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Classify a thrown SQL error into a typed `WorkflowConflictError`. Different
 * SQLite bindings produce slightly different error messages, so we match on
 * the portions every flavour includes.
 */
function classifyConflict(err: unknown, task: WorkflowTask, hasIdem: boolean): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const text = msg.toLowerCase();

  const isUnique = text.includes('unique') || text.includes('primary key');
  if (!isUnique) return err instanceof Error ? err : new Error(msg);

  if (hasIdem && text.includes('idempotency')) {
    return new WorkflowConflictError(
      `duplicate non-terminal idempotency_key for task ${task.id}`,
      'duplicate_idempotency',
    );
  }
  // Differentiate: if the failing constraint mentions the idem index, it's
  // an idempotency collision; else it's a primary-key collision on `id`.
  if (text.includes('idx_workflow_idem')) {
    return new WorkflowConflictError(
      `duplicate non-terminal idempotency_key for task ${task.id}`,
      'duplicate_idempotency',
    );
  }
  return new WorkflowConflictError(`duplicate task id: ${task.id}`, 'duplicate_id');
}
