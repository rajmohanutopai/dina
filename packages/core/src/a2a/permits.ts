/**
 * From the owner's decision to a dispatchable operation (design §6.2 step 6,
 * §6.3), and back out again when the owner cancels.
 *
 * `WorkflowService.approve` commits the approval and its `approved` event,
 * THEN calls the decision handler and swallows its errors. So minting is an
 * idempotent step keyed by the approval task id: the handler runs it at once,
 * and `sweepA2AOutbound` re-runs it for an approved consent card that has no
 * permit while its operation is still pending. In one transaction the mint
 *  - re-checks that the card is approved, that its consent hash is the
 *    operation's, and that the authority it was approved under still holds;
 *  - inserts the permit (a UNIQUE index on `approval_task_id` over every
 *    outbound permit, voided ones included, so one approval mints at most
 *    one permit, ever);
 *  - creates the dispatch child on the `a2a:<agent>` lane and its
 *    `a2a_task_children` row;
 *  - moves the operation to `queued`, and completes the consent card.
 * A crash anywhere in it leaves nothing behind, and the sweeper mints again.
 * A cancelled or failed operation is never minted for.
 */

import { a2aLaneFor } from '@dina/a2a';

import { getServiceGrantRepository } from '../service/service_grant_repository';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../workflow/domain';

import { inboundRequeueObserver } from './delivery';
import { canonicalDigest } from './digest';
import { a2aDispatchKey, a2aDispatchTaskId, newA2AId } from './ids';
import { inboundEgressGate, makeInboundDecisionHandler } from './inbound';
import { endOutboundOperation } from './operation_end';
import {
  A2A_DISPATCH_PAYLOAD_TYPE,
  currentAuthority,
  parseDelegationConsentCard,
  type ConsentPayload,
  type OutboundSnapshot,
} from './proposal';

import type { InboundCore } from './inbound_view';
import type { A2ARuntime } from './runtime';
import type { A2ATaskRow } from './store';
import type { ApprovalDecisionHandler, WorkflowHooks } from '../workflow/service';

/** How long a minted permit may wait for its dispatch. */
export const PERMIT_TTL_MS = 60 * 60_000;
/** How long the dispatch child stays alive: the queue wait plus the remote work. */
export const DISPATCH_TTL_MS = 2 * 60 * 60_000;

export type MintOutcome =
  | 'minted'
  | 'already_minted'
  | 'not_a2a'
  | 'not_pending'
  | 'not_approved'
  | 'consent_mismatch'
  | 'stale_authority';

/** A JSON column Core wrote itself; null when absent or unreadable. */
export function parseStored<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Settle an approval card that is `queued` (approved) by running it to a terminal state. */
function settleApproval(
  runtime: A2ARuntime,
  approvalTaskId: string,
  outcome: { ok: true; result: Record<string, string> } | { ok: false; reason: string },
): void {
  runtime.workflow
    .store()
    .transition(approvalTaskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, runtime.nowMs());
  if (outcome.ok) {
    runtime.workflow.complete(approvalTaskId, JSON.stringify(outcome.result), 'approved and queued');
  } else {
    runtime.workflow.fail(approvalTaskId, outcome.reason);
  }
}

function operationOfApproval(runtime: A2ARuntime, approvalTaskId: string): A2ATaskRow | null {
  const child = runtime.store.getChild(approvalTaskId);
  if (child === null || child.role !== 'approval') return null;
  const op = runtime.store.getTask(child.operation_ref);
  return op !== null && op.direction === 'outbound' ? op : null;
}

/**
 * Mint the permit and dispatch child for an approved consent card. Safe to
 * call any number of times, from the handler and the sweeper alike.
 */
export function mintOutboundPermit(runtime: A2ARuntime, approvalTaskId: string): MintOutcome {
  try {
    return runtime.store.transaction((): MintOutcome => {
      const op = operationOfApproval(runtime, approvalTaskId);
      if (op === null) return 'not_a2a';
      if (op.state !== 'pending_decision') return 'not_pending';
      if (runtime.store.getOutboundPermitByApproval(approvalTaskId) !== null) return 'already_minted';
      const approval = runtime.workflow.store().getById(approvalTaskId);
      if (approval === null || approval.status !== WorkflowTaskState.Queued) return 'not_approved';
      const card = parseDelegationConsentCard(approval.payload);
      if (card === null || card.consent_hash !== op.request_hash) return 'consent_mismatch';
      const consent = parseStored<ConsentPayload>(op.consent_json);
      const snapshot = parseStored<Omit<OutboundSnapshot, 'approval_task_id'>>(op.snapshot_json);
      if (consent === null || snapshot === null || canonicalDigest(consent) !== op.request_hash) {
        return 'consent_mismatch';
      }
      const now = runtime.nowMs();

      const authority = currentAuthority(runtime, consent.remote_agent_id, consent.skill);
      const drift = authority.ok ? snapshotDrift(snapshot, authority) : authority.reason;
      if (drift !== null) {
        endOutboundOperation(runtime, op, ['pending_decision'], { state: 'stale_authority', reason_code: drift });
        settleApproval(runtime, approvalTaskId, { ok: false, reason: `stale_authority: ${drift}` });
        return 'stale_authority';
      }

      const dispatchId = a2aDispatchTaskId();
      const permitId = newA2AId();
      const fullSnapshot: OutboundSnapshot = { ...snapshot, approval_task_id: approvalTaskId };
      runtime.store.insertPermit({
        permit_id: permitId,
        direction: 'outbound',
        operation_ref: op.id,
        execution_child_id: '',
        approval_task_id: approvalTaskId,
        payload_hash: op.request_hash ?? '',
        action_class: consent.action_class,
        pep_did: null,
        authority_snapshot_json: JSON.stringify(fullSnapshot),
        state: 'minted',
        void_reason: null,
        expires_at: now + PERMIT_TTL_MS,
        created_at: now,
        consumed_at: null,
      });
      runtime.workflow.create({
        id: dispatchId,
        kind: WorkflowTaskKind.Delegation,
        description: approval.description,
        payload: JSON.stringify({ type: A2A_DISPATCH_PAYLOAD_TYPE, operation_id: op.external_id }),
        expiresAtSec: Math.floor((now + DISPATCH_TTL_MS) / 1000),
        correlationId: op.external_id,
        priority: WorkflowTaskPriority.UserBlocking,
        origin: 'system',
        idempotencyKey: a2aDispatchKey(op.external_id),
        initialState: WorkflowTaskState.Queued,
        requestedRunner: a2aLaneFor(consent.remote_agent_id),
      });
      runtime.store.insertChild({
        child_task_id: dispatchId,
        operation_ref: op.id,
        generation: 0,
        role: 'dispatch',
        created_at: now,
      });
      runtime.store.updateTask(
        op.id,
        ['pending_decision'],
        {
          state: 'queued',
          internal_id: dispatchId,
          submission_phase: 'built',
          snapshot_json: JSON.stringify(fullSnapshot),
        },
        now,
      );
      settleApproval(runtime, approvalTaskId, {
        ok: true,
        result: { operation_id: op.external_id, permit_id: permitId, dispatch_task_id: dispatchId },
      });
      return 'minted';
    });
  } catch (err) {
    // The approval-keyed unique index refused a second permit when another
    // writer minted between our read and our insert. Judge by what is stored
    // now, never by the error's text: a permit for this approval means
    // another mint won; anything else is a real fault.
    if (runtime.store.getOutboundPermitByApproval(approvalTaskId) !== null) return 'already_minted';
    throw err;
  }
}

/** The first snapshot field the live authority no longer matches, or null. */
export function snapshotDrift(
  snapshot: Omit<OutboundSnapshot, 'approval_task_id'>,
  authority: Extract<ReturnType<typeof currentAuthority>, { ok: true }>,
): string | null {
  const { agent, binding, credential } = authority;
  if (agent.card_hash !== snapshot.card_hash) return 'card_changed';
  if (agent.endpoint !== snapshot.endpoint || agent.endpoint_tenant !== snapshot.endpoint_tenant) {
    return 'endpoint_changed';
  }
  if (binding.revision !== snapshot.binding_revision) return 'binding_changed';
  if (binding.action_class !== snapshot.action_class) return 'binding_changed';
  if (binding.credential_ref !== snapshot.credential_ref) return 'credential_changed';
  if (credential.revision !== snapshot.credential_revision) return 'credential_changed';
  return null;
}

/** The owner said no, or let the card lapse: the operation ends, nothing was minted. */
function closeUndecided(runtime: A2ARuntime, approvalTaskId: string, state: 'refused' | 'expired'): void {
  const op = operationOfApproval(runtime, approvalTaskId);
  if (op === null) return;
  endOutboundOperation(runtime, op, ['pending_decision'], { state, reason_code: state });
}

export function makeA2ADecisionHandler(runtime: () => A2ARuntime | null): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    if (parseDelegationConsentCard(task.payload) === null) return;
    const rt = runtime();
    if (rt === null) return;
    if (decision === 'approved') mintOutboundPermit(rt, task.id);
    else closeUndecided(rt, task.id, decision === 'denied' ? 'refused' : 'expired');
  };
}

/**
 * A2A's contribution to the workflow service, composed at every host: the
 * outbound consent card's decision (M1a), inbound's review card and result
 * routing (M2), and inbound task events on a requeue (M3). The gate runs on every D2D completion, so a runtime
 * that cannot be built here means "not an A2A task": D2D answers carry on.
 */
export function a2aWorkflowHooks(runtime: () => A2ARuntime | null): WorkflowHooks {
  const inbound = (): InboundCore | null => {
    let a2a: A2ARuntime | null;
    try {
      a2a = runtime();
    } catch {
      return null;
    }
    return a2a === null ? null : { a2a, grants: getServiceGrantRepository() };
  };
  const outboundDecision = makeA2ADecisionHandler(runtime);
  const inboundDecision = makeInboundDecisionHandler(inbound);
  return {
    responseEgressGate: inboundEgressGate(inbound),
    approvalDecisionHandler: (args) => {
      outboundDecision(args);
      inboundDecision(args);
    },
    // M3: an inbound child requeued after a lost lease reads SUBMITTED again.
    onTaskRequeued: inboundRequeueObserver(inbound),
  };
}

export interface SweepCounts {
  minted: number;
  closed: number;
  expired: number;
  orphaned: number;
  /** Operations whose repair threw; each is retried on the next sweep, and the rest still ran. */
  failed: number;
}

/**
 * Repair what a crash or a missed handler left: mint for approved cards with
 * no permit, close operations whose card was denied or lapsed, expire queued
 * operations whose permit or dispatch child ran out, and mark running
 * operations whose dispatch child ended without a report. Each operation is
 * repaired on its own, so one that cannot be never holds up the others.
 */
export function sweepA2AOutbound(runtime: A2ARuntime): SweepCounts {
  const counts: SweepCounts = { minted: 0, closed: 0, expired: 0, orphaned: 0, failed: 0 };
  for (const op of runtime.store.listTasksInStates('outbound', ['pending_decision', 'queued', 'running'])) {
    try {
      const outcome = sweepOne(runtime, op);
      if (outcome !== null) counts[outcome] += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

function sweepOne(runtime: A2ARuntime, op: A2ATaskRow): Exclude<keyof SweepCounts, 'failed'> | null {
  const now = runtime.nowMs();
  const tasks = runtime.workflow.store();
  if (op.state === 'pending_decision') {
    const approval = runtime.store.childrenOf(op.id, 'approval')[0];
    const card = approval === undefined ? null : tasks.getById(approval.child_task_id);
    if (approval === undefined || card === null) {
      // No card was ever written, so no task can carry a notice: end it untold.
      return endOutboundOperation(
        runtime,
        op,
        ['pending_decision'],
        { state: 'failed', reason_code: 'approval_missing' },
        { untold: true },
      )
        ? 'orphaned'
        : null;
    }
    if (card.status === WorkflowTaskState.Queued) return mintOutboundPermit(runtime, card.id) === 'minted' ? 'minted' : null;
    if (card.status === WorkflowTaskState.Cancelled) {
      return endOutboundOperation(runtime, op, ['pending_decision'], { state: 'refused', reason_code: 'refused' }) ? 'closed' : null;
    }
    if (card.status === WorkflowTaskState.Failed) {
      return endOutboundOperation(runtime, op, ['pending_decision'], { state: 'expired', reason_code: 'expired' }) ? 'closed' : null;
    }
    return null;
  }
  const dispatch = runtime.store.childrenOf(op.id, 'dispatch')[0];
  const child = dispatch === undefined ? null : tasks.getById(dispatch.child_task_id);
  if (op.state === 'queued') {
    const permit = runtime.store.permitsOf(op.id).find((p) => p.state === 'minted');
    const childDead = child === null || (child.status !== WorkflowTaskState.Queued && child.status !== WorkflowTaskState.Running);
    const permitDead = permit === undefined || permit.expires_at <= now;
    if (!childDead && !permitDead) return null;
    return runtime.store.transaction(() => {
      if (permit !== undefined) runtime.store.voidPermit(permit.permit_id, 'expired');
      const ended = endOutboundOperation(runtime, op, ['queued'], { state: 'expired', reason_code: 'dispatch_expired' });
      if (child !== null && child.status === WorkflowTaskState.Queued) runtime.workflow.cancel(child.id, 'a2a permit expired');
      return ended ? 'expired' : null;
    });
  }
  // running: the dispatch child ended (lease swept, deadline passed) with no report.
  if (child === null || ['failed', 'cancelled', 'outcome_unknown', 'completed'].includes(child.status)) {
    return endOutboundOperation(runtime, op, ['running'], {
      state: 'outcome_unknown',
      reason_code: 'dispatch_ended_unreported',
      submission_phase: 'terminal',
    })
      ? 'orphaned'
      : null;
  }
  return null;
}

export type CancelOutcome =
  | { ok: true; state: 'cancelled' | 'cancel_requested' }
  | { ok: false; reason: 'not_found' | 'already_finished' | 'cancel_refused' };

/**
 * The owner cancels an outbound operation (design §6.4). Before dispatch it
 * ends here: the card is withdrawn, or the permit voided and the dispatch
 * child cancelled. After dispatch the request is recorded, claim-independent,
 * and the runner holding the dispatch (or the next one) asks the remote to
 * cancel and settles the outcome honestly. There is one request per
 * operation: once the remote has refused it, asking again answers
 * `cancel_refused`, never a request that will not be sent.
 */
export function cancelOutboundOperation(runtime: A2ARuntime, operationId: string): CancelOutcome {
  const now = runtime.nowMs();
  return runtime.store.transaction((): CancelOutcome => {
    const op = runtime.store.getTaskByExternal('outbound', 'owner', operationId);
    if (op === null) return { ok: false, reason: 'not_found' };
    if (op.state === 'pending_decision') {
      runtime.store.requestCancel(op.id, now);
      runtime.store.updateCancelRequest(op.id, ['requested'], 'confirmed', { nowMs: now });
      endOutboundOperation(runtime, op, ['pending_decision'], { state: 'cancelled', reason_code: 'cancelled_by_owner' });
      const approval = runtime.store.childrenOf(op.id, 'approval')[0];
      const card = approval === undefined ? null : runtime.workflow.store().getById(approval.child_task_id);
      if (card !== null && card.status === WorkflowTaskState.PendingApproval) {
        runtime.workflow.cancel(card.id, 'cancelled by the owner');
      }
      return { ok: true, state: 'cancelled' };
    }
    if (op.state === 'queued') {
      runtime.store.requestCancel(op.id, now);
      runtime.store.updateCancelRequest(op.id, ['requested'], 'confirmed', { nowMs: now });
      for (const permit of runtime.store.permitsOf(op.id)) runtime.store.voidPermit(permit.permit_id, 'cancelled');
      endOutboundOperation(runtime, op, ['queued'], { state: 'cancelled', reason_code: 'cancelled_by_owner', submission_phase: 'terminal' });
      const dispatch = runtime.store.childrenOf(op.id, 'dispatch')[0];
      const child = dispatch === undefined ? null : runtime.workflow.store().getById(dispatch.child_task_id);
      if (child !== null && child.status === WorkflowTaskState.Queued) runtime.workflow.cancel(child.id, 'cancelled by the owner');
      return { ok: true, state: 'cancelled' };
    }
    if (op.state === 'running') {
      runtime.store.requestCancel(op.id, now);
      if (runtime.store.getCancelRequest(op.id)?.state === 'refused') return { ok: false, reason: 'cancel_refused' };
      return { ok: true, state: 'cancel_requested' };
    }
    return { ok: false, reason: 'already_finished' };
  });
}

