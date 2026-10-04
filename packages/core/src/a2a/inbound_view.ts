/**
 * What an outside client sees of its task (design §7.3, §7.4), and the
 * egress check that decides it. Pure reads, shared by every way a client
 * learns of a task: the ingress answers (`inbound.ts`), which settle first,
 * and the delivery outbox (`delivery.ts`), which records each change at the
 * moment it happens. One projection for both is what keeps a streamed task
 * the same as a polled one.
 */

import {
  DINA_A2A_EXTENSION_URI,
  REFUSAL_VIEW,
  inboundView,
  isPlainObject,
  type InboundTaskView,
  type JsonObject,
  type JsonValue,
  type Message,
  type Task,
} from '@dina/a2a';

import { clientIdOfPrincipal, getA2AClient } from './clients';
import { TERMINAL_INBOUND_STATES, type A2ATaskRow, type InboundOperationState } from './store';

import type { InboundActionClass } from './action_registry';
import type { A2AExecutor, AccessMode } from './inbound_resolve';
import type { A2ARuntime } from './runtime';
import type { ServiceGrantRepository } from '../service/service_grant_repository';

/** The authority an accepted call runs under, frozen at commit (§7.2 step 9). */
export interface InboundSnapshot {
  v: 1;
  principal: string;
  skill: string;
  rkey: string;
  configured_key: string;
  canonical: string;
  action_class: InboundActionClass;
  registry_revision: string;
  config_revision: number;
  config_digest: string;
  executor: A2AExecutor;
  response_policy: 'auto' | 'review';
  mode: AccessMode;
  grant_id?: string;
  schema_hash: string;
  schemas: { params: Record<string, unknown>; result: Record<string, unknown> };
  params: JsonObject;
  pre_hash: string;
  post_hash: string;
  service_name: string;
  /**
   * The listing's creation time when the call was accepted: a listing
   * deleted and made again under the same rkey is another listing, and the
   * call's authority does not pass to it. Absent on calls accepted before M3.
   */
  listing_created_at?: number;
}

/** A runner's question, as it asks it. */
export interface InputRequest {
  prompt: string;
  /** A JSON Schema of `type: "object"` that Core can enforce in full. */
  input_schema: Record<string, unknown>;
}

/** The question an operation is waiting on (`a2a_tasks.input_required_json`). */
export interface InboundQuestion extends InputRequest {
  /** The round that asked it. */
  round: number;
  asked_at: number;
  expires_at: number;
}

/** The question an operation is waiting on, or null. */
export function inboundQuestionOf(op: A2ATaskRow): InboundQuestion | null {
  if (op.input_required_json === null) return null;
  try {
    const q = JSON.parse(op.input_required_json) as InboundQuestion;
    return typeof q.prompt === 'string' && isPlainObject(q.input_schema) && Number.isInteger(q.round) ? q : null;
  } catch {
    return null;
  }
}

/**
 * The status message an asking task carries (A2A v1.0 `TaskStatus.message`):
 * the prompt as text, then the schema the answer must meet as a data part
 * typed `application/schema+json`. Its id names the round, so each question
 * is a distinct message.
 */
export function inboundQuestionMessage(op: A2ATaskRow, question: InboundQuestion): Message {
  return {
    messageId: `${op.external_id}-input-${question.round}`,
    ...(op.context_id === null ? {} : { contextId: op.context_id }),
    taskId: op.external_id,
    role: 'ROLE_AGENT',
    parts: [
      { text: question.prompt },
      { data: question.input_schema as JsonObject, mediaType: 'application/schema+json' },
    ],
  };
}

/** What settling, the authority check and the commit read: the A2A runtime and the grants. */
export interface InboundCore {
  a2a: A2ARuntime;
  grants: ServiceGrantRepository | null;
}

export function readInboundSnapshot(op: A2ATaskRow): InboundSnapshot | null {
  if (op.snapshot_json === null) return null;
  try {
    return JSON.parse(op.snapshot_json) as InboundSnapshot;
  } catch {
    return null;
  }
}

/**
 * The egress check (§7.3 "revalidation at every data egress"): may this
 * client still be handed what its call produced? Runs at settle, on every
 * read that would hand a result out, and at every delivery claim.
 *
 * Only final losses count, so an answer never flips back: the client
 * revoked; its grant (if the call used one) revoked or expired; the listing
 * deleted, even if one was made again under its rkey (another listing: its
 * creation time differs from the one the call pinned, or, for a call
 * accepted before the pin, it was made after the call). A paused listing,
 * a draft, or one moved off the services surface stops new calls
 * (admission) and new runs (the claim's authority check, through the pinned
 * revision), and does not withhold work already done.
 */
export function inboundEgressLoss(
  rt: InboundCore,
  op: A2ATaskRow,
  snapshot: InboundSnapshot,
): 'authority_revoked' | null {
  const clientId = clientIdOfPrincipal(snapshot.principal);
  const client = clientId === null ? null : getA2AClient(rt.a2a.store, clientId);
  if (client === null || client.status !== 'active') return 'authority_revoked';
  if (snapshot.grant_id !== undefined) {
    const live =
      rt.grants?.isAuthorized({
        granteeDid: snapshot.principal,
        serviceRkey: snapshot.rkey,
        capability: snapshot.configured_key,
        grantId: snapshot.grant_id,
        nowSec: Math.floor(rt.a2a.nowMs() / 1000),
      }) ?? false;
    if (!live) return 'authority_revoked';
  }
  const row = rt.a2a.store.db.query('SELECT created_at FROM service_configs WHERE rkey = ?', [snapshot.rkey]) as {
    created_at: number;
  }[];
  const listing = row[0];
  if (listing === undefined) return 'authority_revoked';
  const sameListing =
    snapshot.listing_created_at !== undefined
      ? listing.created_at === snapshot.listing_created_at
      : listing.created_at <= op.created_at;
  return sameListing ? null : 'authority_revoked';
}

/**
 * Whether this client's events must wait (§7.3, notes M4 step 1): it is a
 * DID-bound client whose key the re-check found gone from its document, so
 * it cannot authenticate until the owner binds it again. Unlike a loss, a
 * hold ends: binding again releases what waited, and revoking turns it into
 * a loss.
 */
export function inboundEgressHeld(rt: InboundCore, snapshot: InboundSnapshot): boolean {
  const clientId = clientIdOfPrincipal(snapshot.principal);
  const client = clientId === null ? null : getA2AClient(rt.a2a.store, clientId);
  return client !== null && client.status === 'active' && client.credential === 'did_key_removed';
}

/**
 * The client's view of one operation as it stands (§7.4); it never settles.
 * A completed result whose egress is lost shows a neutral FAILED; the reads
 * that see it also end the task for good (`endLostEgress`).
 */
export function projectInboundTask(rt: InboundCore, op: A2ATaskRow): Task {
  let view: InboundTaskView;
  let result: JsonValue | undefined;
  let message: Message | undefined;
  switch (op.state as InboundOperationState) {
    case 'rejected':
      view = REFUSAL_VIEW;
      break;
    case 'completed': {
      // Re-checked on every read (§7.3).
      const snapshot = readInboundSnapshot(op);
      if (snapshot === null || inboundEgressLoss(rt, op, snapshot) !== null) {
        view = { state: 'TASK_STATE_FAILED' };
        break;
      }
      view = { state: 'TASK_STATE_COMPLETED' };
      try {
        result = op.result_json === null ? undefined : (JSON.parse(op.result_json) as JsonValue);
      } catch {
        result = undefined;
      }
      break;
    }
    case 'failed':
      view = { state: 'TASK_STATE_FAILED' };
      break;
    case 'canceled':
      view = { state: 'TASK_STATE_CANCELED' };
      break;
    case 'outcome_unknown':
      view = { state: 'TASK_STATE_FAILED', outcome: 'unknown' };
      break;
    default: {
      const child = op.internal_id === null ? null : rt.a2a.workflow.store().getById(op.internal_id);
      view = child === null ? { state: 'TASK_STATE_SUBMITTED' } : inboundView(child.status);
      // A round waiting on the caller asks its question (§7.7), which is
      // egress like a result: shown only while the call's authority holds,
      // and a call that lost it can never run again. A round that continues
      // a call is work already under way, never SUBMITTED.
      const question = child?.status === 'awaiting' ? inboundQuestionOf(op) : null;
      if (question !== null) {
        const snapshot = readInboundSnapshot(op);
        if (snapshot === null || inboundEgressLoss(rt, op, snapshot) !== null) {
          view = { state: 'TASK_STATE_FAILED' };
        } else {
          view = { state: 'TASK_STATE_INPUT_REQUIRED' };
          message = inboundQuestionMessage(op, question);
        }
      } else if (view.state === 'TASK_STATE_SUBMITTED' && op.continuation_generation > 0) {
        view = { state: 'TASK_STATE_WORKING' };
      }
    }
  }
  const task: Task = {
    id: op.external_id,
    ...(op.context_id === null ? {} : { contextId: op.context_id }),
    status: {
      state: view.state,
      ...(message === undefined ? {} : { message }),
      timestamp: new Date(op.status_updated_at).toISOString(),
    },
  };
  if (result !== undefined) {
    task.artifacts = [{ artifactId: 'result', parts: [{ data: result, mediaType: 'application/json' }] }];
  }
  // Design §7.6: on a task's result the Dina extension carries outcome and
  // receiptId. The receipt id is the hash of the request as the client sent
  // it (sha256 over its canonical params), which the client can compute
  // itself: Dina's word that it took exactly that request, never a row id.
  const settled = TERMINAL_INBOUND_STATES.has(op.state as InboundOperationState);
  if (settled || view.outcome === 'unknown') {
    task.metadata = {
      [DINA_A2A_EXTENSION_URI]: {
        ...(view.outcome === 'unknown' ? { outcome: 'unknown' } : {}),
        ...(settled && op.request_hash !== null ? { receiptId: op.request_hash } : {}),
      },
    };
  }
  return task;
}

/**
 * What of a view a client could tell apart from the last one it was sent:
 * the state, whether the outcome is unknown, and which question it asks
 * (each round's has its own message id, so a second question is an event
 * even when the client never saw the state between). A change here is a
 * change worth an event (§7.5); a new timestamp alone is not.
 */
export function inboundViewKey(task: Task): string {
  const outcome = task.metadata === undefined ? '' : ':unknown';
  const question = task.status.message === undefined ? '' : `:${task.status.message.messageId}`;
  return `${task.status.state}${outcome}${question}`;
}
