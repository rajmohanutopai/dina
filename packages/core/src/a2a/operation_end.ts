/**
 * Ending an outbound operation, and telling the asking conversation (design
 * A2A-I7): every end — refused, lapsed, stale, cancelled, failed, unknown,
 * released, blocked — appends exactly ONE owner-delivery event, in the same
 * transaction as the state move. Brain delivers A2A outcomes from these
 * events only; the workflow's own events on A2A children (a dispatch child
 * completing, an approval card being cancelled) say nothing to the owner.
 *
 * The event rides the operation's dispatch child when it has one, else its
 * approval card: both are tasks the conversation's Core can resolve back to
 * the operation, and both carry Core-minted payloads Brain cannot forge.
 * Details carry the operation id only; Brain reads the outcome through Core.
 */

import { purgeEndedEntities } from './entities';
import { TERMINAL_INBOUND_STATES, TERMINAL_OUTBOUND_STATES } from './store';

import type { A2ARuntime } from './runtime';
import type { A2ATaskPatch, A2ATaskRow, OutboundOperationState } from './store';

/**
 * How long an ended operation stays for the owner's console before it is
 * deleted with everything that references it: its permit, guard job,
 * cancel request, child links, any blocked result held in quarantine
 * (design §9: quarantined content purges with its operation), and its
 * workflow tasks — the consent card, whose payload is the approved
 * message, and the dispatch child — with their events. The design leaves
 * retention windows open (§13); 30 days keeps a month of history.
 */
export const A2A_ENDED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Operations purged per call at most; the next call takes the rest. */
const PURGE_BATCH = 100;

/** An operation ended without a guard verdict: Brain words it from the operation's state and reason. */
export const A2A_OPERATION_ENDED_EVENT = 'a2a_operation_ended';
export const A2A_RESULT_RELEASED_EVENT = 'a2a_result_released';
export const A2A_RESULT_BLOCKED_EVENT = 'a2a_result_blocked';
/** Not an end: the result is still held, and the owner is told why. */
export const A2A_RESULT_HELD_EVENT = 'a2a_result_held';

/**
 * The task an operation's owner events ride: its dispatch child, else its
 * approval card — whichever exists as a workflow task. Null when neither
 * does (an operation whose card was never written).
 */
function anchorTaskId(runtime: A2ARuntime, op: A2ATaskRow): string | null {
  for (const role of ['dispatch', 'approval'] as const) {
    const child = runtime.store.childrenOf(op.id, role)[0];
    if (child !== undefined && runtime.repository.getById(child.child_task_id) !== null) return child.child_task_id;
  }
  return null;
}

/** Thrown inside an ending's transaction when there is no task to tell: the ending rolls back. */
export class A2ANoAnchorError extends Error {
  constructor(operationId: string) {
    super(`a2a operation ${operationId} has no task to carry its owner event`);
  }
}

/**
 * Append one owner-delivery event for `op`, inside the transaction that moved
 * it. Throws `A2ANoAnchorError` when no task carries it, so an ending can
 * never commit without its event.
 */
export function appendA2AOwnerEvent(runtime: A2ARuntime, op: A2ATaskRow, kind: string): void {
  const taskId = anchorTaskId(runtime, op);
  if (taskId === null) throw new A2ANoAnchorError(op.external_id);
  runtime.workflow.store().appendEvent({
    task_id: taskId,
    at: runtime.nowMs(),
    event_kind: kind,
    needs_delivery: true,
    delivery_attempts: 0,
    delivery_failed: false,
    details: JSON.stringify({ operation_id: op.external_id }),
  });
}

/**
 * Delete operations, outbound and inbound, that ended more than
 * `retentionMs` ago, each in its own transaction that re-checks it has
 * ended, with their A2A rows, workflow children and (inbound) receipts.
 * Returns how many went.
 */
export function purgeEndedA2AOperations(runtime: A2ARuntime, retentionMs = A2A_ENDED_RETENTION_MS): number {
  // Originals go first and sooner: 7 days after their operation ends.
  purgeEndedEntities(runtime);
  const cutoff = runtime.nowMs() - retentionMs;
  let purged = 0;
  for (const direction of ['outbound', 'inbound'] as const) {
    const ended: ReadonlySet<string> = direction === 'outbound' ? TERMINAL_OUTBOUND_STATES : TERMINAL_INBOUND_STATES;
    for (const op of runtime.store.listEndedTasksBefore(direction, cutoff, PURGE_BATCH)) {
      const gone = runtime.store.transaction((): boolean => {
        const now = runtime.store.getTask(op.id);
        if (now === null || !ended.has(now.state) || now.status_updated_at > cutoff) return false;
        const workflowTasks = runtime.store.childrenOf(op.id).map((c) => c.child_task_id);
        runtime.store.deleteTaskWithChildren(op.id);
        runtime.repository.deleteTasks(workflowTasks);
        return true;
      });
      if (gone) purged += 1;
    }
  }
  return purged;
}

/**
 * Move `op` from one of `from` to a terminal state and append its one
 * `a2a_operation_ended` event, atomically. False when `op` was no longer in
 * `from` (someone else ended it; their move carried the event).
 *
 * `untold` is for the one ending with nobody to tell: an operation whose
 * consent card was never written. Every other ending throws (and rolls
 * back) rather than end in silence.
 */
export function endOutboundOperation(
  runtime: A2ARuntime,
  op: A2ATaskRow,
  from: readonly OutboundOperationState[],
  patch: A2ATaskPatch & { state: OutboundOperationState; reason_code: string },
  options: { untold?: boolean } = {},
): boolean {
  return runtime.store.transaction((): boolean => {
    if (!runtime.store.updateTask(op.id, from, patch, runtime.nowMs())) return false;
    if (options.untold !== true) appendA2AOwnerEvent(runtime, op, A2A_OPERATION_ENDED_EVENT);
    return true;
  });
}
