/**
 * The dispatch transaction and everything the runner reports after it
 * (design §6.3, §6.4). Core keeps every decision; the host runner only
 * carries bytes.
 *
 * `beginOutboundDispatch` runs in ONE transaction adjacent to the send:
 * claim check, cancellation check, consent re-hash, snapshot re-check
 * against the live agent, binding and credential, permit consume (CAS),
 * and the move to `transmitting` with a fresh `messageId`. Any drift voids
 * the permit and ends the operation `stale_authority`, before a byte leaves.
 *
 * Recovery is phase-aware. A dispatch child whose lease was lost comes back
 * to a runner, and the operation's phase says what is safe:
 *  - `built` with a minted permit: dispatch as normal (nothing was sent);
 *  - `transmitting`: the request may have reached the remote, so the
 *    operation ends `outcome_unknown` (never re-sent, A2A-I8);
 *  - `acknowledged`: the remote returned a task id, so polling resumes.
 *    GetTask is a read; resuming it re-executes nothing. (The design's
 *    lease rule says `transmitting`+ → `outcome_unknown`; resuming at
 *    `acknowledged` is a deliberate refinement, see implementation notes.)
 *
 * Every report is claim-bound: it applies only while the reporter still
 * holds the dispatch child's claim, and the operation row and the child
 * change in the same transaction, so neither can end without the other.
 */

import { JSONRPC_ERROR_CODES, canonicalize, isPlainObject, type JsonObject } from '@dina/a2a';

import { WorkflowTaskState } from '../workflow/domain';

import { canonicalDigest } from './digest';
import { newA2AId } from './ids';
import { endOutboundOperation } from './operation_end';
import { parseStored, snapshotDrift } from './permits';
import { currentAuthority, type ConsentPayload, type OutboundSnapshot, type OutgoingPart } from './proposal';
import { ingestRemoteResult } from './result_ingest';

import type { AuthProblem } from './credentials';
import type { A2ARuntime } from './runtime';
import type { A2ATaskRow, OutboundActionClass, OutboundOperationState } from './store';

export const GUARD_SCANNER_VERSION = 'a2a-guard-v1';

/** Who is reporting: the dispatch child, and the claim the runner holds on it. */
export interface DispatchClaim {
  childTaskId: string;
  claimId: string;
  runnerDid: string;
}

export interface DispatchTarget {
  operationRef: number;
  operationId: string;
  endpoint: string;
  tenant: string;
  /** The credential the owner approved; the runner builds its headers per request (§5.3). */
  credentialRef: string;
}

export type DispatchStart =
  /** `sentAt`: when the operation entered `transmitting`; its poll ends a fixed time after it. */
  | (DispatchTarget & { kind: 'send'; messageId: string; parts: OutgoingPart[]; sentAt: number })
  | (DispatchTarget & { kind: 'resume'; remoteTaskId: string; sentAt: number })
  | { kind: 'settled'; state: OutboundOperationState; reason: string }
  /** The runner no longer holds the claim; it stops without touching anything. */
  | { kind: 'not_ours' };

class ClaimLost extends Error {}

function heldChild(runtime: A2ARuntime, claim: DispatchClaim): void {
  const child = runtime.workflow.store().getById(claim.childTaskId);
  if (child === null || child.status !== WorkflowTaskState.Running || child.claim_id !== claim.claimId) {
    throw new ClaimLost();
  }
}

function operationOf(runtime: A2ARuntime, childTaskId: string): A2ATaskRow | null {
  const link = runtime.store.getChild(childTaskId);
  if (link === null || link.role !== 'dispatch') return null;
  return runtime.store.getTask(link.operation_ref);
}

/** End the dispatch child to match the operation: failed, cancelled, or outcome unknown. */
function endChild(
  runtime: A2ARuntime,
  claim: DispatchClaim,
  how: 'fail' | 'cancel' | 'unknown',
  code: string,
): void {
  const message = `a2a: ${code}`;
  if (how === 'cancel') runtime.workflow.cancel(claim.childTaskId, message);
  else if (how === 'unknown') {
    runtime.workflow.failEffectfulUnknown(claim.childTaskId, message, '', claim.runnerDid, claim.claimId);
  } else runtime.workflow.fail(claim.childTaskId, message, claim.runnerDid, claim.claimId);
}

function target(op: A2ATaskRow, snapshot: OutboundSnapshot): DispatchTarget {
  return {
    operationRef: op.id,
    operationId: op.external_id,
    endpoint: snapshot.endpoint,
    tenant: snapshot.endpoint_tenant,
    credentialRef: snapshot.credential_ref,
  };
}

/**
 * The credential a claimed dispatch child will send under, read before the
 * dispatch transaction so the runner can build its headers (an OAuth token
 * may take a network round trip) BEFORE the permit is consumed. Null when the
 * child is no A2A dispatch or its snapshot cannot be read.
 */
export function dispatchCredentialRef(runtime: A2ARuntime, childTaskId: string): string | null {
  const op = operationOf(runtime, childTaskId);
  const snapshot = op === null ? null : parseStored<OutboundSnapshot>(op.snapshot_json);
  return snapshot?.credential_ref ?? null;
}

/**
 * Run the dispatch transaction for a claimed dispatch child. `credential` is
 * the runner's account of the headers it built: for WHICH reference, and
 * whether they could be built. Headers built for another reference than the
 * one approved void the dispatch; unusable ones end a send here, before the
 * permit is consumed, with nothing sent.
 */
export function beginOutboundDispatch(
  runtime: A2ARuntime,
  claim: DispatchClaim,
  /** The credential the runner built headers from, and why it could not, if it could not. */
  opts: { credential?: { ref: string; problem: AuthProblem | null } } = {},
): DispatchStart {
  try {
    return runtime.store.transaction((): DispatchStart => {
      heldChild(runtime, claim);
      const now = runtime.nowMs();
      const op = operationOf(runtime, claim.childTaskId);
      if (op === null || op.direction !== 'outbound') {
        endChild(runtime, claim, 'fail', 'not_an_a2a_dispatch');
        return { kind: 'settled', state: 'failed', reason: 'not_an_a2a_dispatch' };
      }
      const settle = (
        state: OutboundOperationState,
        reason: string,
        how: 'fail' | 'cancel' | 'unknown',
      ): DispatchStart => {
        endOutboundOperation(runtime, op, [op.state as OutboundOperationState], { state, reason_code: reason, submission_phase: 'terminal' });
        endChild(runtime, claim, how, reason);
        return { kind: 'settled', state, reason };
      };
      const snapshot = parseStored<OutboundSnapshot>(op.snapshot_json);
      const consent = parseStored<ConsentPayload>(op.consent_json);

      if (op.state === 'running') {
        if (op.submission_phase === 'acknowledged' && op.remote_task_id !== null && op.sent_at !== null && snapshot !== null) {
          return { ...target(op, snapshot), kind: 'resume', remoteTaskId: op.remote_task_id, sentAt: op.sent_at };
        }
        return settle('outcome_unknown', 'lease_lost_after_send', 'unknown');
      }
      if (op.state === 'cancelled') {
        endChild(runtime, claim, 'cancel', 'cancelled_by_owner');
        return { kind: 'settled', state: 'cancelled', reason: 'cancelled_by_owner' };
      }
      if (op.state !== 'queued' || op.submission_phase !== 'built') {
        endChild(runtime, claim, 'fail', `operation_${op.state}`);
        return { kind: 'settled', state: op.state as OutboundOperationState, reason: `operation_${op.state}` };
      }

      const permit = runtime.store.permitsOf(op.id).find((p) => p.direction === 'outbound' && p.state === 'minted');
      const voidAndSettle = (reason: string, state: OutboundOperationState): DispatchStart => {
        if (permit !== undefined) runtime.store.voidPermit(permit.permit_id, reason);
        return settle(state, reason, state === 'cancelled' ? 'cancel' : 'fail');
      };
      const cancel = runtime.store.getCancelRequest(op.id);
      if (cancel !== null && cancel.state === 'requested') {
        runtime.store.updateCancelRequest(op.id, ['requested'], 'confirmed', { nowMs: now });
        return voidAndSettle('cancelled_by_owner', 'cancelled');
      }
      if (permit === undefined) return voidAndSettle('no_permit', 'stale_authority');
      if (snapshot === null || consent === null) return voidAndSettle('snapshot_unreadable', 'stale_authority');
      const consentHash = canonicalDigest(consent);
      if (consentHash !== op.request_hash || consentHash !== permit.payload_hash || consentHash !== snapshot.consent_hash) {
        return voidAndSettle('consent_mismatch', 'stale_authority');
      }
      const approval = runtime.workflow.store().getById(snapshot.approval_task_id);
      if (approval === null || approval.status !== WorkflowTaskState.Completed) {
        return voidAndSettle('approval_not_intact', 'stale_authority');
      }
      const authority = currentAuthority(runtime, consent.remote_agent_id, consent.skill);
      const drift = authority.ok ? snapshotDrift(snapshot, authority) : authority.reason;
      if (drift !== null) return voidAndSettle(drift, 'stale_authority');
      if (opts.credential !== undefined) {
        if (opts.credential.ref !== snapshot.credential_ref) return voidAndSettle('credential_changed', 'stale_authority');
        // Nothing is sent either way; the owner reads which it was.
        if (opts.credential.problem !== null) return voidAndSettle(opts.credential.problem, 'failed');
      }
      if (!runtime.store.consumePermit(permit.permit_id, now)) return voidAndSettle('permit_expired', 'expired');

      const messageId = newA2AId();
      runtime.store.updateTask(
        op.id,
        ['queued'],
        { state: 'running', submission_phase: 'transmitting', message_id: messageId, sent_at: now },
        now,
      );
      return { ...target(op, snapshot), kind: 'send', messageId, parts: consent.projection.parts, sentAt: now };
    });
  } catch (err) {
    if (err instanceof ClaimLost) return { kind: 'not_ours' };
    throw err;
  }
}

/** Sanitized, Dina-authored reasons a remote outcome can end in. Remote text never becomes one. */
export type RemoteFailureReason =
  | 'remote_needs_input'
  | 'remote_needs_auth'
  /** The remote refused the credential (HTTP 401/403): the request was turned away before it ran. */
  | 'remote_auth_refused'
  | 'remote_failed'
  | 'remote_rejected'
  | 'remote_error'
  | 'remote_protocol_error';

export type RemoteOutcome =
  /** The remote returned a task to poll. */
  | { kind: 'acknowledged'; remoteTaskId: string; remoteContextId?: string }
  /** A finished answer: a direct `Message`'s parts, or a completed task's artifact parts. */
  | { kind: 'result'; parts: unknown }
  | { kind: 'failed'; reason: RemoteFailureReason }
  /** The transport failed before any request byte could have left. */
  | { kind: 'not_sent'; reason: string }
  /** The remote confirmed the task cancelled. */
  | { kind: 'cancelled' }
  /** The remote answered `SendMessage` with a JSON-RPC error; Core decides what it means. */
  | { kind: 'send_error'; code: number }
  /** Dina cannot know what happened remotely. */
  | { kind: 'unknown'; reason: string };

/**
 * JSON-RPC errors that say the remote refused the request before acting on
 * it: the request's shape, method, version, extensions or content were not
 * acceptable. Any other error (an internal error, or a code this list does
 * not name) may follow a side effect.
 */
const REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([
  JSONRPC_ERROR_CODES.parseError,
  JSONRPC_ERROR_CODES.invalidRequest,
  JSONRPC_ERROR_CODES.methodNotFound,
  JSONRPC_ERROR_CODES.invalidParams,
  JSONRPC_ERROR_CODES.pushNotificationNotSupported,
  JSONRPC_ERROR_CODES.unsupportedOperation,
  JSONRPC_ERROR_CODES.contentTypeNotSupported,
  JSONRPC_ERROR_CODES.extensionSupportRequired,
  JSONRPC_ERROR_CODES.versionNotSupported,
]);

/** Action classes whose request cannot change anything at the remote. */
const NO_SIDE_EFFECT: ReadonlySet<OutboundActionClass> = new Set(['read', 'quote']);

export type RecordOutcome =
  | { ok: true; state: OutboundOperationState }
  | { ok: false; reason: 'claim_lost' | 'not_in_flight' };

/** Record what the remote said, claim-bound, with the dispatch child in the same commit. */
export function recordRemoteOutcome(
  runtime: A2ARuntime,
  claim: DispatchClaim,
  outcome: RemoteOutcome,
): RecordOutcome {
  try {
    return runtime.store.transaction((): RecordOutcome => {
      heldChild(runtime, claim);
      const op = operationOf(runtime, claim.childTaskId);
      if (op === null || op.state !== 'running') return { ok: false, reason: 'not_in_flight' };
      const now = runtime.nowMs();
      const end = (
        state: OutboundOperationState,
        reason: string,
        how: 'fail' | 'cancel' | 'unknown',
      ): RecordOutcome => {
        endOutboundOperation(runtime, op, ['running'], { state, reason_code: reason, submission_phase: 'terminal' });
        endChild(runtime, claim, how, reason);
        return { ok: true, state };
      };

      switch (outcome.kind) {
        case 'acknowledged':
          runtime.store.updateTask(
            op.id,
            ['running'],
            {
              submission_phase: 'acknowledged',
              remote_task_id: outcome.remoteTaskId,
              ...(outcome.remoteContextId !== undefined ? { remote_context_id: outcome.remoteContextId } : {}),
            },
            now,
          );
          return { ok: true, state: 'running' };
        case 'failed':
          return end('failed', outcome.reason, 'fail');
        case 'not_sent':
          return end('failed', `remote_unreachable:${outcome.reason}`, 'fail');
        case 'unknown':
          return end('outcome_unknown', outcome.reason, 'unknown');
        case 'send_error': {
          if (REFUSED_BEFORE_ACTING.has(outcome.code)) return end('failed', 'remote_rejected', 'fail');
          const snapshot = parseStored<OutboundSnapshot>(op.snapshot_json);
          // An error after the request arrived may follow a side effect (A2A-I8):
          // only a class that cannot change anything is a plain failure.
          return snapshot !== null && NO_SIDE_EFFECT.has(snapshot.action_class)
            ? end('failed', 'remote_error', 'fail')
            : end('outcome_unknown', 'remote_error_after_send', 'unknown');
        }
        case 'cancelled': {
          const cancel = runtime.store.getCancelRequest(op.id);
          if (cancel !== null && cancel.state !== 'confirmed') {
            runtime.store.updateCancelRequest(op.id, [cancel.state], 'confirmed', { nowMs: now });
          }
          return end('cancelled', cancel === null ? 'cancelled_by_remote' : 'cancelled_by_owner', 'cancel');
        }
        case 'result': {
          const snapshot = parseStored<OutboundSnapshot>(op.snapshot_json);
          // The remote says it finished: only its answer is refused (A2A-I8).
          // A class that can change something may have changed it, so the
          // call ends "unknown", never a plain failure that invites a retry;
          // an unreadable snapshot hides the class, and is judged the same.
          const refused = (reason: string): RecordOutcome =>
            snapshot !== null && NO_SIDE_EFFECT.has(snapshot.action_class)
              ? end('failed', `result_refused:${reason}`, 'fail')
              : end('outcome_unknown', `result_refused:${reason}`, 'unknown');
          if (snapshot === null) return refused('snapshot_unreadable');
          let pinned: Record<string, unknown> | undefined;
          if (snapshot.result_schema_json !== null) {
            const parsed = parseStored<Record<string, unknown>>(snapshot.result_schema_json);
            // The schema in force at consent cannot be read: refuse, never fall back to the default envelope.
            if (parsed === null) return refused('schema_unreadable');
            pinned = parsed;
          }
          const ingested = ingestRemoteResult(outcome.parts, pinned);
          if (!ingested.ok) return refused(ingested.reason);
          runtime.store.updateTask(
            op.id,
            ['running'],
            {
              state: 'quarantined',
              submission_phase: 'terminal',
              result_quarantine: canonicalize(ingested.result.value),
              quarantine_digest: ingested.result.digest,
            },
            now,
          );
          runtime.store.insertGuardJob({
            job_id: newA2AId(),
            operation_ref: op.id,
            quarantine_digest: ingested.result.digest,
            scanner_version: GUARD_SCANNER_VERSION,
            state: 'pending',
            claim_id: null,
            claimed_until: null,
            verdict_json: null,
            held_notice_at: null,
            created_at: now,
            resolved_at: null,
          });
          // The child's own result carries no remote content: that waits in
          // quarantine for the guard, and only its release is delivered.
          runtime.workflow.complete(
            claim.childTaskId,
            JSON.stringify({ operation_id: op.external_id, outcome: 'held_for_guard' }),
            'result held for the guard',
            claim.runnerDid,
            claim.claimId,
          );
          return { ok: true, state: 'quarantined' };
        }
      }
    });
  } catch (err) {
    if (err instanceof ClaimLost) return { ok: false, reason: 'claim_lost' };
    throw err;
  }
}

/**
 * A cancel request this claim should act on (design §6.4): one that is
 * `requested`, or `attempting` under an earlier claim (the request survives
 * re-claim). Binds the request to this claim and returns true; the runner
 * then asks the remote to cancel.
 */
export function takeCancelRequest(runtime: A2ARuntime, claim: DispatchClaim): boolean {
  try {
    return runtime.store.transaction((): boolean => {
      heldChild(runtime, claim);
      const op = operationOf(runtime, claim.childTaskId);
      if (op === null || op.state !== 'running') return false;
      const request = runtime.store.getCancelRequest(op.id);
      if (request === null) return false;
      const now = runtime.nowMs();
      if (request.state === 'requested') {
        return runtime.store.updateCancelRequest(op.id, ['requested'], 'attempting', { resolvingClaimId: claim.claimId, nowMs: now });
      }
      if (request.state === 'attempting' && request.resolving_claim_id !== claim.claimId) {
        return runtime.store.updateCancelRequest(op.id, ['attempting'], 'attempting', { resolvingClaimId: claim.claimId, nowMs: now });
      }
      return false;
    });
  } catch (err) {
    if (err instanceof ClaimLost) return false;
    throw err;
  }
}

/** The remote refused or could not take the cancel: the request is resolved, the operation runs on. */
export function recordCancelRefused(runtime: A2ARuntime, claim: DispatchClaim): boolean {
  const op = operationOf(runtime, claim.childTaskId);
  if (op === null) return false;
  return runtime.store.updateCancelRequest(op.id, ['attempting'], 'refused', {
    requireClaimId: claim.claimId,
    nowMs: runtime.nowMs(),
  });
}

/** True while an operation has an unresolved cancel request. */
export function hasOpenCancelRequest(runtime: A2ARuntime, claim: DispatchClaim): boolean {
  const op = operationOf(runtime, claim.childTaskId);
  if (op === null) return false;
  const request = runtime.store.getCancelRequest(op.id);
  return request !== null && (request.state === 'requested' || request.state === 'attempting');
}

/** Shape check for the parts of a direct `Message` or a completed task's artifacts, before ingest. */
export function artifactParts(task: JsonObject): unknown[] {
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const parts: unknown[] = [];
  for (const artifact of artifacts) {
    if (isPlainObject(artifact) && Array.isArray(artifact.parts)) parts.push(...artifact.parts);
  }
  return parts;
}
