/**
 * The two total state maps (design §6.4, §7.4).
 *
 * Inbound: a Dina workflow task's state → the A2A `TaskState` a remote
 * caller sees. Outbound: a remote task's `TaskState` → what Dina's runner
 * does next. Both are `Record`s over the full enum, so a new state on
 * either side is a compile error here, not a silent fall-through.
 *
 * The workflow state names are spelled out (this package cannot import
 * Core); Core's tests assert this list equals `WorkflowTaskState` exactly.
 */

import type { TaskState } from './types';

export const DINA_WORKFLOW_STATES = [
  'created',
  'pending',
  'queued',
  'claimed',
  'running',
  'awaiting',
  'pending_approval',
  'scheduled',
  'completed',
  'failed',
  'cancelled',
  'outcome_unknown',
  'recorded',
] as const;
export type DinaWorkflowState = (typeof DINA_WORKFLOW_STATES)[number];

export interface InboundTaskView {
  state: TaskState;
  /** Set only for `outcome_unknown`: the effect may or may not have happened. */
  outcome?: 'unknown';
  /** `recorded` should never reach an A2A caller; seeing it is an audit anomaly. */
  anomaly?: true;
}

/**
 * Design §7.4. Approval is invisible to the caller (`pending_approval` reads
 * as WORKING); `outcome_unknown` is FAILED with `outcome: "unknown"`, since
 * claiming success or a clean failure would both be dishonest. A child
 * `awaiting` reads as WORKING here; Core's view of an inbound call shows
 * INPUT_REQUIRED instead while its round waits on the caller's answer
 * (§7.7), since only Core knows the question.
 */
export const WORKFLOW_TO_A2A: Readonly<Record<DinaWorkflowState, InboundTaskView>> = Object.freeze({
  created: { state: 'TASK_STATE_SUBMITTED' },
  pending: { state: 'TASK_STATE_SUBMITTED' },
  queued: { state: 'TASK_STATE_SUBMITTED' },
  scheduled: { state: 'TASK_STATE_SUBMITTED' },
  claimed: { state: 'TASK_STATE_WORKING' },
  running: { state: 'TASK_STATE_WORKING' },
  awaiting: { state: 'TASK_STATE_WORKING' },
  pending_approval: { state: 'TASK_STATE_WORKING' },
  completed: { state: 'TASK_STATE_COMPLETED' },
  failed: { state: 'TASK_STATE_FAILED' },
  cancelled: { state: 'TASK_STATE_CANCELED' },
  outcome_unknown: { state: 'TASK_STATE_FAILED', outcome: 'unknown' },
  recorded: { state: 'TASK_STATE_FAILED', anomaly: true },
});

/** A gate refusal has no workflow task; it is always one collapsed REJECTED (A2A-I4). */
export const REFUSAL_VIEW: InboundTaskView = Object.freeze({ state: 'TASK_STATE_REJECTED' });

export type OutboundDisposition =
  /** Keep polling. */
  | { kind: 'running' }
  /** The task finished; its artifacts go through the result pipeline (§6.5). */
  | { kind: 'completed' }
  /** End the workflow task as failed with this sanitized reason. */
  | {
      kind: 'fail';
      reason: 'remote_needs_input' | 'remote_needs_auth' | 'remote_failed' | 'remote_rejected';
    }
  | { kind: 'cancelled' }
  /** Re-poll; past the deadline, end as `outcome_unknown`. */
  | { kind: 'unknown' };

/** Design §6.4. `INPUT_REQUIRED` fails: outbound multi-turn is out of scope through M4. */
export const A2A_TO_OUTBOUND: Readonly<Record<TaskState, OutboundDisposition>> = Object.freeze({
  TASK_STATE_SUBMITTED: { kind: 'running' },
  TASK_STATE_WORKING: { kind: 'running' },
  TASK_STATE_INPUT_REQUIRED: { kind: 'fail', reason: 'remote_needs_input' },
  TASK_STATE_AUTH_REQUIRED: { kind: 'fail', reason: 'remote_needs_auth' },
  TASK_STATE_COMPLETED: { kind: 'completed' },
  TASK_STATE_FAILED: { kind: 'fail', reason: 'remote_failed' },
  TASK_STATE_REJECTED: { kind: 'fail', reason: 'remote_rejected' },
  TASK_STATE_CANCELED: { kind: 'cancelled' },
  TASK_STATE_UNSPECIFIED: { kind: 'unknown' },
});

const ANOMALY_VIEW: InboundTaskView = Object.freeze({ state: 'TASK_STATE_FAILED', anomaly: true });

/**
 * Total over any string, since states are read back from storage: a value
 * outside the workflow enum fails closed as FAILED and is flagged as an
 * anomaly for the audit log (design §7.4).
 */
export function inboundView(state: string): InboundTaskView {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_TO_A2A, state)
    ? WORKFLOW_TO_A2A[state as DinaWorkflowState]
    : ANOMALY_VIEW;
}

/**
 * Total over any string, since states arrive from a remote peer: a state
 * outside the v1.0 enum is treated like `UNSPECIFIED` (re-poll, then
 * `outcome_unknown` at the deadline), never as success or failure.
 */
export function outboundDisposition(state: string): OutboundDisposition {
  return Object.prototype.hasOwnProperty.call(A2A_TO_OUTBOUND, state)
    ? A2A_TO_OUTBOUND[state as TaskState]
    : { kind: 'unknown' };
}
