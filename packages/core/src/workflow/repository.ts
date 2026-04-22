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
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import { WorkflowTaskState, isTerminal, type WorkflowEvent, type WorkflowTask } from './domain';

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

  /** Set the run_id (crash-recovery marker). Returns true if the row exists. */
  setRunId(id: string, runId: string, updatedAtMs: number): boolean;

  /** Set internal_stash. Returns true if the row exists. */
  setInternalStash(id: string, stash: string | null, updatedAtMs: number): boolean;

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
   * paired dina-agent instances (role='agent') in the Bus Driver path.
   */
  claimDelegationTask(agentDID: string, nowMs: number, leaseMs: number): WorkflowTask | null;

  /**
   * Extend a claimed task's lease. Only the agent that holds the claim
   * can heartbeat (agent_did match is required). Returns true on extension,
   * false when task is missing, not running, or held by a different agent.
   */
  heartbeatTask(id: string, agentDID: string, nowMs: number, leaseMs: number): boolean;

  /**
   * Update a running task's progress note. Same caller-agent guard as
   * heartbeat: only the claim holder can update progress.
   */
  updateTaskProgress(id: string, agentDID: string, progressNote: string, nowMs: number): boolean;

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
  ): number;

  /**
   * Atomic task failure: target state `failed`, attach `error`, append a
   * `workflow_event` with `event_kind='failed'`. Returns the new event_id
   * or 0 on miss.
   */
  fail(id: string, agentDID: string, errorMsg: string, nowMs: number): number;

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
   * List tasks whose `internal_stash` value starts with `prefix`. Used by
   * the Response Bridge retry sweeper to find tasks with a pending
   * bridge_pending entry that needs re-sending (main-dina 4848a934).
   * Ordered by `updated_at` ASC so the oldest stuck entries retry first.
   */
  listTasksWithStashPrefix(prefix: string, limit: number): WorkflowTask[];
  size(): number;
}

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
  internal_stash, created_at, updated_at
`.trim();

const EVENT_COLUMNS = `
  event_id, task_id, at, event_kind, needs_delivery,
  delivery_attempts, next_delivery_at, delivering_until,
  delivered_at, acknowledged_at, delivery_failed, details
`.trim();

export class SQLiteWorkflowRepository implements WorkflowRepository {
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
         AND state NOT IN ('completed','failed','cancelled','recorded')
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

  claimDelegationTask(agentDID: string, nowMs: number, leaseMs: number): WorkflowTask | null {
    if (leaseMs <= 0) {
      throw new Error('claimDelegationTask: leaseMs must be positive');
    }
    const nowSec = Math.floor(nowMs / 1000);
    const leaseExpiresAt = nowMs + leaseMs;
    let claimed: WorkflowTask | null = null;
    this.db.transaction(() => {
      const rows = this.db.query(
        `SELECT ${TASK_COLUMNS} FROM workflow_tasks
         WHERE kind = 'delegation'
           AND state = 'queued'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC
         LIMIT 1`,
        [nowSec],
      );
      if (rows.length === 0) return;
      const candidate = rowToTask(rows[0]);
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'running',
             agent_did = ?,
             lease_expires_at = ?,
             updated_at = ?
         WHERE id = ? AND state = 'queued'`,
        [agentDID, leaseExpiresAt, nowMs, candidate.id],
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
        }),
      });
      claimed = {
        ...candidate,
        status: 'running',
        agent_did: agentDID,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowMs,
      };
    });
    return claimed;
  }

  heartbeatTask(id: string, agentDID: string, nowMs: number, leaseMs: number): boolean {
    if (leaseMs <= 0) {
      throw new Error('heartbeatTask: leaseMs must be positive');
    }
    const affected = this.db.run(
      `UPDATE workflow_tasks
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND agent_did = ?`,
      [nowMs + leaseMs, nowMs, id, agentDID],
    );
    return affected > 0;
  }

  updateTaskProgress(id: string, agentDID: string, progressNote: string, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE workflow_tasks
       SET progress_note = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND agent_did = ?`,
      [progressNote, nowMs, id, agentDID],
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
        const affected = this.db.run(
          `UPDATE workflow_tasks
           SET state = 'queued',
               agent_did = NULL,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ? AND state = 'running'`,
          [nowMs, task.id],
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
  ): number {
    let eventId = 0;
    this.db.transaction(() => {
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'completed',
             result = ?,
             result_summary = ?,
             agent_did = ?,
             updated_at = ?
         WHERE id = ? AND state NOT IN ('completed','failed','cancelled','recorded')`,
        [resultJSON, resultSummary, agentDID, nowMs, id],
      );
      if (affected === 0) return; // miss → no event appended
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

  fail(id: string, agentDID: string, errorMsg: string, nowMs: number): number {
    let eventId = 0;
    this.db.transaction(() => {
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'failed',
             error = ?,
             agent_did = ?,
             updated_at = ?
         WHERE id = ? AND state NOT IN ('completed','failed','cancelled','recorded')`,
        [errorMsg, agentDID, nowMs, id],
      );
      if (affected === 0) return;
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

  cancel(id: string, reason: string, nowMs: number): number {
    let eventId = 0;
    this.db.transaction(() => {
      const affected = this.db.run(
        `UPDATE workflow_tasks
         SET state = 'cancelled',
             updated_at = ?
         WHERE id = ? AND state NOT IN ('completed','failed','cancelled','recorded')`,
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
    const candidates = this.db
      .query(
        `SELECT ${TASK_COLUMNS} FROM workflow_tasks
       WHERE state NOT IN ('completed','failed','cancelled','recorded')
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
        [nowSec],
      )
      .map(rowToTask);
    if (candidates.length === 0) return [];

    this.db.transaction(() => {
      this.db.run(
        `UPDATE workflow_tasks
         SET state = 'failed',
             error = 'expired',
             updated_at = ?
         WHERE state NOT IN ('completed','failed','cancelled','recorded')
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
        [nowMs, nowSec],
      );
      // Emit a `failed` workflow_event per expired task so downstream
      // consumers (WorkflowEventConsumer → chat formatter) can surface
      // the timeout to the user. Without this, TTL expiry is invisible
      // at the chat surface. Issue #10.
      for (const t of candidates) {
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: 'failed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({
            response_status: 'expired',
            capability: inferCapability(t),
            service_name: inferServiceName(t),
            error: 'expired',
          }),
        });
      }
    });
    return candidates;
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

  claimDelegationTask(agentDID: string, nowMs: number, leaseMs: number): WorkflowTask | null {
    if (leaseMs <= 0) {
      throw new Error('claimDelegationTask: leaseMs must be positive');
    }
    const nowSec = Math.floor(nowMs / 1000);
    // Pick the oldest queued delegation task that hasn't expired.
    const candidates: WorkflowTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.kind !== 'delegation') continue;
      if (t.status !== 'queued') continue;
      if (t.expires_at !== undefined && t.expires_at <= nowSec) continue;
      candidates.push(t);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.created_at - b.created_at);
    const winner = candidates[0];
    const leaseExpiresAt = nowMs + leaseMs;
    winner.status = 'running';
    winner.agent_did = agentDID;
    winner.lease_expires_at = leaseExpiresAt;
    winner.updated_at = nowMs;
    this.events.push({
      event_id: ++this.nextEventId,
      task_id: winner.id,
      at: nowMs,
      event_kind: 'claimed',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        agent_did: agentDID,
        lease_expires_at: leaseExpiresAt,
      }),
    });
    return { ...winner };
  }

  heartbeatTask(id: string, agentDID: string, nowMs: number, leaseMs: number): boolean {
    if (leaseMs <= 0) {
      throw new Error('heartbeatTask: leaseMs must be positive');
    }
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status !== 'running' || t.agent_did !== agentDID) return false;
    t.lease_expires_at = nowMs + leaseMs;
    t.updated_at = nowMs;
    return true;
  }

  updateTaskProgress(id: string, agentDID: string, progressNote: string, nowMs: number): boolean {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status !== 'running' || t.agent_did !== agentDID) return false;
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
      t.status = 'queued';
      t.agent_did = undefined;
      t.lease_expires_at = undefined;
      t.updated_at = nowMs;
      this.events.push({
        event_id: ++this.nextEventId,
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
  ): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    if (isTerminal(t.status as WorkflowTaskState)) return 0;
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

  fail(id: string, agentDID: string, errorMsg: string, nowMs: number): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    if (isTerminal(t.status as WorkflowTaskState)) return 0;
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

  cancel(id: string, reason: string, nowMs: number): number {
    const t = this.tasks.get(id);
    if (t === undefined) return 0;
    if (isTerminal(t.status as WorkflowTaskState)) return 0;
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
      if (
        !isTerminal(t.status as WorkflowTaskState) &&
        t.expires_at !== undefined &&
        t.expires_at <= nowSec
      ) {
        expired.push({ ...t });
        t.status = 'failed';
        t.error = 'expired';
        t.updated_at = nowMs;
        // Parity with SQLiteWorkflowRepository — emit a deliverable
        // `failed` event so consumers can surface the TTL expiry to
        // chat. Issue #10.
        this.appendEvent({
          task_id: t.id,
          at: nowMs,
          event_kind: 'failed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({
            response_status: 'expired',
            capability: inferCapability(t),
            service_name: inferServiceName(t),
            error: 'expired',
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
