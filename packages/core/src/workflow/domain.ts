/**
 * Workflow-task domain model — single durable work-item shape used by
 * service queries, approvals, delegations, timers, watches, and generic
 * work.
 *
 * Replaces the earlier `DelegatedTask` surface. Wire field is `status`
 * (not `state`) for backward compatibility with any clients that already
 * speak to the old endpoints.
 *
 * Source of truth: main dina `core/internal/domain/workflow.go`
 * (commit 9c01611, updated through 4848a93).
 */

// ---------------------------------------------------------------------------
// State + kind + priority enums
// ---------------------------------------------------------------------------

/** Lifecycle states a workflow task can be in. */
export type WorkflowTaskState =
  | 'created'
  | 'pending'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting'
  | 'pending_approval'
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recorded';

/** Const record of state literals — matches the Go `WF*` constants for direct porting. */
export const WorkflowTaskState = Object.freeze({
  Created: 'created',
  Pending: 'pending',
  Queued: 'queued',
  Claimed: 'claimed',
  Running: 'running',
  Awaiting: 'awaiting',
  PendingApproval: 'pending_approval',
  Scheduled: 'scheduled',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Recorded: 'recorded',
} as const satisfies Record<string, WorkflowTaskState>);

/** Kind classifies what the task is for. */
export type WorkflowTaskKind =
  | 'delegation'
  | 'approval'
  | 'service_query'
  | 'timer'
  | 'watch'
  | 'generic';

export const WorkflowTaskKind = Object.freeze({
  Delegation: 'delegation',
  Approval: 'approval',
  ServiceQuery: 'service_query',
  Timer: 'timer',
  Watch: 'watch',
  Generic: 'generic',
} as const satisfies Record<string, WorkflowTaskKind>);

/** Priority drives queue ordering under contention. */
export type WorkflowTaskPriority = 'user_blocking' | 'normal' | 'background';

export const WorkflowTaskPriority = Object.freeze({
  UserBlocking: 'user_blocking',
  Normal: 'normal',
  Background: 'background',
} as const satisfies Record<string, WorkflowTaskPriority>);

/**
 * Allowed values for the `origin` field — the `origin` column carries a
 * CHECK constraint in SQL that matches this list. Include the empty string
 * for legacy rows that predate the constraint.
 */
export const AllowedOrigins: readonly string[] = Object.freeze([
  '',
  'telegram',
  'api',
  'd2d',
  'admin',
  'system',
  'cli',
]);

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Durable work-item model. All 28 fields mirror the Go `WorkflowTask`
 * struct. JSON serialisation uses the wire name `status` for the state
 * field — preserving compatibility with existing endpoints that were
 * first built on the `DelegatedTask` surface.
 *
 * Fields beyond the identity triple (`id`, `kind`, `status`) are optional
 * in practice; the SQL store fills numeric fields with `0` for "unset"
 * (idiomatic for Go), and string fields with `''`. Callers should treat
 * empty values as absent.
 */
export interface WorkflowTask {
  id: string;
  kind: string; // WorkflowTaskKind — widened to string for wire compat
  status: string; // WorkflowTaskState — widened to string for wire compat
  correlation_id?: string;
  parent_id?: string;
  proposal_id?: string;
  priority: string; // WorkflowTaskPriority — widened to string
  description: string;
  /** JSON-encoded payload. Shape is kind-specific. */
  payload: string;
  /** JSON-encoded result. Populated on completion. */
  result?: string;
  result_summary: string;
  /** JSON-encoded policy config. Shape is kind-specific. */
  policy: string;
  error?: string;
  requested_runner?: string;
  assigned_runner?: string;
  agent_did?: string;
  run_id?: string;
  progress_note?: string;
  lease_expires_at?: number;
  origin?: string; // AllowedOrigins
  session_name?: string;
  idempotency_key?: string;
  expires_at?: number;
  next_run_at?: number;
  recurrence?: string;
  /**
   * NOT serialised on the wire. Holds internal recovery data (e.g. the
   * pre-signed service.response body stashed before send, to be re-played
   * by the sweeper on transient failure).
   */
  internal_stash?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Audit/delivery record associated with a `WorkflowTask`. The store emits
 * one event per state transition (plus separate events for approval,
 * completion details, etc.). The delivery fields let a scheduler
 * retry failed event fanout.
 */
export interface WorkflowEvent {
  event_id: number;
  task_id: string;
  at: number;
  event_kind: string;
  needs_delivery: boolean;
  delivery_attempts: number;
  next_delivery_at?: number;
  delivering_until?: number;
  delivered_at?: number;
  acknowledged_at?: number;
  delivery_failed: boolean;
  /** JSON-encoded event details. Shape is event-kind-specific. */
  details: string;
}

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

/**
 * Legal state transitions. Key = current state, value = set of states the
 * task may move to. Terminal states map to at most `recorded` (the archive
 * state); everything else keeps a `failed` / `cancelled` escape.
 *
 * Derived directly from the Go `ValidTransitions` map. Any drift here
 * will silently break cross-runtime compatibility with main dina, so
 * keep these two tables synchronised.
 */
export const ValidTransitions: Readonly<
  Record<WorkflowTaskState, ReadonlyArray<WorkflowTaskState>>
> = Object.freeze({
  created: ['pending', 'queued', 'pending_approval', 'running', 'completed', 'failed', 'cancelled'],
  pending: ['running', 'queued', 'cancelled'],
  queued: ['claimed', 'running', 'cancelled'],
  claimed: ['running', 'failed', 'cancelled'],
  running: ['awaiting', 'completed', 'failed', 'cancelled', 'queued'],
  awaiting: ['running', 'completed', 'failed', 'cancelled'],
  pending_approval: ['pending', 'queued', 'failed', 'cancelled'],
  scheduled: ['pending', 'running', 'cancelled'],
  completed: ['recorded'],
  failed: ['scheduled', 'queued', 'recorded', 'cancelled'],
  cancelled: [],
  recorded: [],
}) as unknown as Readonly<Record<WorkflowTaskState, ReadonlyArray<WorkflowTaskState>>>;

/** Terminal states — no further transitions change the task's content. */
const TERMINAL_STATES: ReadonlySet<WorkflowTaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'recorded',
]);

/**
 * Returns `true` iff `from → to` is on the `ValidTransitions` allowlist.
 * Unknown `from` states (drift, corruption) always fail — no transition
 * is safe from an unrecognised origin.
 */
export function isValidTransition(from: WorkflowTaskState, to: WorkflowTaskState): boolean {
  const allowed = ValidTransitions[from];
  if (allowed === undefined) return false;
  return allowed.includes(to);
}

/** Returns `true` iff the state is terminal. */
export function isTerminal(state: WorkflowTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Narrowing type-guard for `origin` — verifies a candidate string is on
 * the `AllowedOrigins` list. Useful at API boundaries where the incoming
 * string hasn't yet been checked.
 */
export function isAllowedOrigin(s: string): boolean {
  return AllowedOrigins.includes(s);
}
