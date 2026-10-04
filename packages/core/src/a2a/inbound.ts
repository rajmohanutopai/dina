/**
 * Inbound A2A, Lane 2 (design §7.2, §7.3, §7.4): Core's half of every call
 * an outside A2A client makes through the gateway. The gateway holds no
 * keys and resolves no principal; it forwards the client's raw request and
 * its credential evidence, and Core decides everything.
 *
 * `SendMessage` (§7.2):
 *   1. authenticate the forwarded bearer (§5.1) → the principal, or 401;
 *   3. size: the raw body is at most 256 KB, or 413;
 *      dispatch binding: Core parses the operation from the raw body itself
 *      and refuses a body the gateway routed to the wrong door;
 *   2. version: `A2A-Version` 1.0 only;
 *   4. structure: one `Message` from the user, at most 16 parts, and the
 *      §7.2a envelope — each failure a protocol error with no durable
 *      state. A message that names a task is instead the caller's answer
 *      to that task's question (M4, §7.7: `inbound_turns.ts`);
 *   5. the idempotency receipt, BEFORE rate limiting and every gate: the
 *      same call again gets the same task back; the same message id with a
 *      different request is a conflict that changes nothing;
 *   6. the principal's budget, charged to new calls only;
 *   7–8. skill resolution, the action registry, the access mode and the
 *      executor (`inbound_resolve.ts`);
 *   9. normalization (`normalize.ts`), then ONE commit: the receipt, the
 *      operation with its frozen authority snapshot, its first child (a
 *      review card under `review`; an execution child on the frozen
 *      executor's lane under `auto`) and, for an effectful class, the
 *      permit that child's claim will consume.
 * A refusal at 7–9 commits the receipt and a `rejected` operation in one
 * transaction: the caller sees the one collapsed REJECTED (A2A-I4), and a
 * replay sees it again.
 *
 * An operation is `open` until it settles. While open, the caller sees its
 * current child's workflow state (§7.4). It settles once, in `settleInbound`:
 * from the bridge when the child completes (the egress gate answers
 * `delivered`, so nothing goes out over D2D), from a task read, or from the
 * sweep — whichever comes first. Settling runs the egress check (§7.3),
 * which counts only final losses (the client revoked, the grant revoked or
 * expired, the listing deleted or replaced), and validates the result
 * against the pinned result schema. A lost egress ends the call with a
 * neutral end, `outcome_unknown` once an effect may have run, else FAILED,
 * and keeps the result for the owner. A paused or edited listing refuses
 * new runs (the claim's authority check) but does not hold back a result
 * already produced.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  A2A_CREDENTIAL_GEN_HEADER,
  A2A_EVENT_SEQ_HEADER,
  A2A_LIMITS,
  A2A_SEND_WAIT_MS,
  A2A_STREAM_CLIENT_HEADER,
  MAX_ID_LENGTH,
  STREAM_ENDING_TASK_STATES,
  TERMINAL_TASK_STATES,
  a2aError,
  base64urlDecodeUtf8,
  base64urlEncodeUtf8,
  canonicalize,
  isPlainObject,
  jsonRpcError,
  jsonRpcResult,
  parseInvocationEnvelope,
  qualifySkill,
  skillIdFits,
  skillShareFits,
  validateMessage,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
  type Task,
  ingressRouteOf,
} from '@dina/a2a';
import {
  effectiveDiscoverability,
  effectiveListingStatus,
  effectiveSurface,
  getCatalogCapability,
  parseServiceQueryExecutionPayload,
  pinnedSchemaProblems,
  reviewRulesFor,
} from '@dina/protocol';

import { validateAgainstSchema } from '../plugins/schema_validate';
import { getServiceConfig } from '../service/service_config';
import { getServiceGrantRepository } from '../service/service_grant_repository';
import { WorkflowTaskKind, WorkflowTaskState, isTerminal } from '../workflow/domain';
import {
  WorkflowTransitionError,
  getWorkflowService,
  type ServiceQueryBridgeContext,
  type WorkflowService,
} from '../workflow/service';

import { ACTION_REGISTRY_REVISION, INBOUND_EFFECTFUL_CLASSES } from './action_registry';
import { inboundChangeSignal } from './change_signal';
import { clientIdOfPrincipal, credentialGenOf, endExpiredBearers, getA2AClient, streamClientKeyOf } from './clients';
import { endLostEgress, noteInboundCreated, recordInboundChange } from './delivery';
import { sha256HexOfText } from './digest';
import { newA2AId } from './ids';
import { projectionCapability } from './inbound_card';
import {
  INBOUND_REVIEW_DEADLINE_SECONDS,
  InboundCommitRefused,
  endInboundOperation,
  inboundReviewTaskId,
  inboundRoundHash,
  mintExecutionChild,
} from './inbound_children';
import { resolveInboundSkill, selectA2AExecutor, type ResolvedInboundSkill } from './inbound_resolve';
import { A2A_INBOUND_REVIEW_TYPE, inboundReviewDisplay, parseInboundReviewCard, type InboundReviewCard } from './inbound_review_card';
import { continueInboundCall } from './inbound_turns';
import {
  inboundEgressLoss,
  projectInboundTask,
  readInboundSnapshot,
  type InboundCore,
  type InboundSnapshot,
} from './inbound_view';
import {
  admitIngress,
  ownedOperation,
  rpcError,
  slowDown,
  unauthenticated,
  type GatewayAnswer,
  type GatewayEnvelope,
  type InboundRuntime,
} from './ingress_common';
import { ingressFailureResponse, type IngressFailure } from './ingress_outcome';
import { normalizeInvocation, type PinnedSchemaPair } from './normalize';
import { addPushConfig, parsePushConfigInput, type PushConfigInput } from './push_configs';
import { checkReceipt, insertReceipt } from './receipts';
import { getA2ARuntime, getA2AStore, type A2ARuntime } from './runtime';

import type { A2ATaskRow, InboundOperationState, NewA2ATask } from './store';

export const MAX_LIST_PAGE = 50;

// ---------------------------------------------------------------- views

/**
 * The caller's view of one operation (§7.4). Settles it first if its child
 * ended, and ends for good a result whose authority is revoked, so a later
 * read can never show it again (§7.3).
 */
export function inboundTaskView(rt: InboundCore, op: A2ATaskRow): Task {
  const settled = settleInbound(rt, op) ?? op;
  return projectInboundTask(rt, endLostEgress(rt, settled) ?? settled);
}

// ---------------------------------------------------------------- authority

export type AuthorityLoss = 'authority_revoked' | 'stale_authority';

/**
 * May the call still run (§7.3)? Checked at claim and at the owner's
 * approval, before anything runs. Its egress must hold (else
 * `authority_revoked`, a neutral end), and the listing must be live on the
 * services surface (a paused listing starts no new work; also
 * `authority_revoked`); the listing, the capability, the registry and the
 * executor must be what the snapshot pinned (else `stale_authority`).
 */
export function inboundAuthorityLoss(rt: InboundCore, op: A2ATaskRow, snapshot: InboundSnapshot): AuthorityLoss | null {
  const egress = inboundEgressLoss(rt, op, snapshot);
  if (egress !== null) return egress;
  const live = getServiceConfig(snapshot.rkey);
  if (live === null || effectiveListingStatus(live) !== 'active' || effectiveSurface(live) !== 'services') {
    return 'authority_revoked';
  }
  if (snapshot.registry_revision !== ACTION_REGISTRY_REVISION) return 'stale_authority';
  const row = rt.a2a.store.db.query('SELECT revision FROM service_configs WHERE rkey = ?', [snapshot.rkey]) as {
    revision: number;
  }[];
  if (row[0]?.revision !== snapshot.config_revision) return 'stale_authority';
  const config = getServiceConfig(snapshot.rkey);
  const cap = config?.capabilities[snapshot.configured_key];
  if (config === null || cap === undefined || configDigest(config) !== snapshot.config_digest) return 'stale_authority';
  const executor = selectA2AExecutor(rt.a2a.store, cap, snapshot.action_class);
  if (executor === null || canonicalize(executor as unknown as JsonValue) !== canonicalize(snapshot.executor as unknown as JsonValue)) {
    return 'stale_authority';
  }
  return null;
}

function configDigest(config: unknown): string {
  try {
    return sha256HexOfText(canonicalize(config as JsonValue));
  } catch {
    return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(config))));
  }
}

// ---------------------------------------------------------------- settle

/**
 * Settle an open operation whose current child has ended: once, by the
 * first caller to see it. Returns the settled row, or null when there is
 * nothing to settle (still running, or already settled).
 */
export function settleInbound(rt: InboundCore, op: A2ATaskRow): A2ATaskRow | null {
  if (op.direction !== 'inbound' || op.state !== 'open' || op.internal_id === null) return null;
  const child = rt.a2a.workflow.store().getById(op.internal_id);
  if (child === null || !isTerminal(child.status as WorkflowTaskState)) return null;
  const snapshot = readInboundSnapshot(op);
  return rt.a2a.store.transaction(() => {
    const fresh = rt.a2a.store.getTask(op.id);
    if (fresh === null || fresh.state !== 'open') return null;
    const effectStarted = fresh.effect_phase === 'effect_started';
    // Anything Core cannot hand back after the effect began ends "unknown",
    // never a plain failure that invites a retry (A2A-I8): the work may be done.
    const unusable = (reason: string): A2ATaskRow | null =>
      endInboundOperation(rt, fresh, { state: effectStarted ? 'outcome_unknown' : 'failed', reason_code: reason });
    if (snapshot === null) return unusable('snapshot_unreadable');
    switch (child.status) {
      case WorkflowTaskState.Completed: {
        // Result attachment is an egress (§7.3): the client, its grant and
        // the listing must still stand. Drift in the listing's config was
        // judged at claim, before anything ran; judging it again here would
        // report an effect that happened as one that did not. A result whose
        // authority is revoked is kept for the owner; the caller gets a
        // neutral end: "unknown" once an effect may have run, else a plain
        // failure. A paused listing does not hold back work already done.
        if (inboundEgressLoss(rt, fresh, snapshot) !== null) {
          return endInboundOperation(rt, fresh, {
            state: effectStarted ? 'outcome_unknown' : 'failed',
            reason_code: 'authority_revoked',
            result_json: child.result ?? undefined,
          });
        }
        // A result schema with a keyword the validator would skip checks nothing
        // there: no such result is released (a call pinned before admission
        // refused these schemas).
        if (pinnedSchemaProblems(snapshot.schemas.result, 'pinned_runtime').length > 0) {
          return unusable('result_schema_unenforceable');
        }
        let result: unknown;
        try {
          result = JSON.parse(child.result ?? 'null');
        } catch {
          return unusable('result_unreadable');
        }
        if (!validateAgainstSchema(result, snapshot.schemas.result).ok) return unusable('result_schema_mismatch');
        let json: string;
        try {
          json = canonicalize(result as JsonValue);
        } catch {
          return unusable('result_unreadable');
        }
        return endInboundOperation(rt, fresh, { state: 'completed', result_json: json, effect_phase: 'done' });
      }
      case WorkflowTaskState.OutcomeUnknown:
        return endInboundOperation(rt, fresh, { state: 'outcome_unknown', reason_code: 'outcome_unknown' });
      case WorkflowTaskState.Cancelled: {
        // A review card the owner refused, or that lapsed, ends neutral.
        const role = rt.a2a.store.getChild(child.id)?.role;
        if (role === 'approval') return endInboundOperation(rt, fresh, { state: 'failed', reason_code: 'declined' });
        // An execution stopped after its effect began may have done it: never
        // "canceled" (A2A-I8, §10 "false canceled"), which invites a retry.
        return effectStarted
          ? endInboundOperation(rt, fresh, { state: 'outcome_unknown', reason_code: 'canceled_after_effect' })
          : endInboundOperation(rt, fresh, { state: 'canceled', reason_code: 'canceled' });
      }
      default:
        return endInboundOperation(rt, fresh, {
          state: effectStarted ? 'outcome_unknown' : 'failed',
          reason_code:
            child.status !== WorkflowTaskState.Failed
              ? `child_${child.status}`
              : // A waiting round fails only when its deadline passes (§7.7).
                fresh.input_required_json !== null
                ? 'input_not_received'
                : 'execution_failed',
        });
    }
  });
}

/**
 * The bridge's gate for inbound children (§7.3, "response routing"): a
 * completed child of an inbound operation settles its operation and leaves
 * nothing for D2D to send.
 */
export function inboundEgressGate(rt: () => InboundCore | null) {
  return (ctx: ServiceQueryBridgeContext): { kind: 'passthrough' } | { kind: 'delivered' } => {
    const runtime = rt();
    if (runtime === null) return { kind: 'passthrough' };
    const child = runtime.a2a.store.getChild(ctx.taskId);
    if (child === null) return { kind: 'passthrough' };
    const op = runtime.a2a.store.getTask(child.operation_ref);
    if (op === null || op.direction !== 'inbound') return { kind: 'passthrough' };
    settleInbound(runtime, op);
    return { kind: 'delivered' };
  };
}

// ---------------------------------------------------------------- commit

function commitRefusal(
  rt: InboundCore,
  args: { principal: string; messageId: string; preHash: string; contextId: string; reason: IngressFailure },
): A2ATaskRow {
  const now = rt.a2a.nowMs();
  return rt.a2a.store.transaction(() => {
    const op = rt.a2a.store.insertTask(blankInbound({ ...args, state: 'rejected', reason: args.reason, now }));
    noteInboundCreated(rt, op.id);
    insertReceipt(rt.a2a.store, {
      principal: args.principal,
      operation: 'SendMessage',
      message_id: args.messageId,
      request_hash_pre: args.preHash,
      request_hash_post: null,
      mapped_external_id: op.external_id,
      status: 'rejected',
      created_at: now,
    });
    return op;
  });
}

function blankInbound(args: {
  principal: string;
  messageId: string;
  preHash: string;
  contextId: string;
  state: InboundOperationState;
  reason?: string;
  now: number;
}): NewA2ATask {
  return {
    external_id: newA2AId(),
    direction: 'inbound',
    principal: args.principal,
    internal_id: null,
    context_id: args.contextId,
    state: args.state,
    reason_code: args.reason ?? null,
    result_json: null,
    result_quarantine: null,
    quarantine_digest: null,
    guard_receipt_id: null,
    message_id: args.messageId,
    request_hash: args.preHash,
    card_hash: null,
    submission_phase: null,
    effect_phase: null,
    continuation_generation: 0,
    input_required_json: null,
    snapshot_json: null,
    consent_json: null,
    reply_to: null,
    release_session_id: null,
    remote_agent_id: null,
    remote_task_id: null,
    remote_context_id: null,
    status_updated_at: args.now,
    created_at: args.now,
  };
}

function commitAccepted(
  rt: InboundCore,
  args: {
    principal: string;
    messageId: string;
    preHash: string;
    contextId: string;
    resolved: ResolvedInboundSkill;
    schemas: PinnedSchemaPair;
    normalized: { params: JsonObject; schemaHash: string; postHash: string; skill: string };
    /** A webhook the call configured inline (`SendMessageConfiguration`), already checked. */
    pushConfig?: PushConfigInput;
  },
): A2ATaskRow {
  const { resolved, normalized } = args;
  const now = rt.a2a.nowMs();
  return rt.a2a.store.transaction(() => {
    const row = rt.a2a.store.db.query('SELECT revision, created_at FROM service_configs WHERE rkey = ?', [
      resolved.rkey,
    ]) as {
      revision: number;
      created_at: number;
    }[];
    if (row[0] === undefined) throw new InboundCommitRefused('skill_unknown');
    // The listing's policy, raised to review wherever the listing validator
    // requires it: a valid listing already says so, and a row the validator
    // never saw cannot lower it.
    const def = getCatalogCapability(resolved.canonical);
    const mustReview = def === null || reviewRulesFor(def, effectiveDiscoverability(resolved.config)).length > 0;
    const policy = resolved.cap.responsePolicy === 'review' || mustReview ? 'review' : 'auto';
    const snapshot: InboundSnapshot = {
      v: 1,
      principal: args.principal,
      skill: normalized.skill,
      rkey: resolved.rkey,
      configured_key: resolved.configuredKey,
      canonical: resolved.canonical,
      action_class: resolved.actionClass,
      registry_revision: ACTION_REGISTRY_REVISION,
      config_revision: row[0].revision,
      listing_created_at: row[0].created_at,
      config_digest: configDigest(resolved.config),
      executor: resolved.executor,
      response_policy: policy,
      mode: resolved.mode,
      ...(resolved.grantId === undefined ? {} : { grant_id: resolved.grantId }),
      schema_hash: normalized.schemaHash,
      schemas: { params: args.schemas.params, result: args.schemas.result },
      params: normalized.params,
      pre_hash: args.preHash,
      post_hash: normalized.postHash,
      service_name: resolved.config.name,
    };
    const op = rt.a2a.store.insertTask({
      ...blankInbound({ ...args, state: 'open', now }),
      snapshot_json: JSON.stringify(snapshot),
    });
    // A new task has no configs yet, so the cap cannot refuse this one.
    if (args.pushConfig !== undefined) addPushConfig(rt.a2a.store, op.id, args.pushConfig, now);
    if (policy === 'review') {
      const cardId = inboundReviewTaskId(op.external_id);
      const clientId = clientIdOfPrincipal(args.principal) ?? '';
      const client = getA2AClient(rt.a2a.store, clientId);
      rt.a2a.workflow.create({
        id: cardId,
        kind: WorkflowTaskKind.Approval,
        description: `A2A call: ${normalized.skill}`,
        payload: JSON.stringify({
          type: A2A_INBOUND_REVIEW_TYPE,
          operation_id: op.external_id,
          client_id: clientId,
          client_name: client?.display_name ?? '',
          skill: normalized.skill,
          action_class: resolved.actionClass,
          params: normalized.params,
          service_name: resolved.config.name,
          post_hash: normalized.postHash,
          display: inboundReviewDisplay({
            client_name: client?.display_name ?? '',
            skill: normalized.skill,
            action_class: resolved.actionClass,
            params: normalized.params,
            service_name: resolved.config.name,
            // A client that bound a DID has no token: it signed this call with the DID's key.
            proof:
              client?.credential === 'did' && client.bound_did !== null
                ? { kind: 'did', did: client.bound_did }
                : { kind: 'bearer' },
          }),
        } satisfies InboundReviewCard),
        origin: 'api',
        correlationId: op.external_id,
        expiresAtSec: Math.floor(now / 1000) + INBOUND_REVIEW_DEADLINE_SECONDS,
        initialState: WorkflowTaskState.PendingApproval,
      });
      rt.a2a.store.insertChild({ child_task_id: cardId, operation_ref: op.id, generation: 0, role: 'approval', created_at: now });
      rt.a2a.store.updateTask(op.id, ['open'], { internal_id: cardId }, now);
    } else {
      mintExecutionChild(rt, op, snapshot, 0);
    }
    noteInboundCreated(rt, op.id);
    insertReceipt(rt.a2a.store, {
      principal: args.principal,
      operation: 'SendMessage',
      message_id: args.messageId,
      request_hash_pre: args.preHash,
      request_hash_post: normalized.postHash,
      mapped_external_id: op.external_id,
      status: 'accepted',
      created_at: now,
    });
    return rt.a2a.store.getTask(op.id) ?? op;
  });
}

// ---------------------------------------------------------------- operations

/**
 * `SendMessage` and `SendStreamingMessage` (§7.2): one call, two answers.
 * The streaming door answers the Task its stream opens with, and the
 * sequence number of the last event already reflected in it, so the
 * gateway sends the stream only what follows (§7.5). Both doors share one
 * idempotency key: a call retried through the other door is the same call.
 *
 * This answers as the call is committed. A `SendMessage` that did not ask
 * to return at once is answered when its task ends or is interrupted
 * (`awaitSendMessage`, which the route serves).
 */
export function ingressSendMessage(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  method: 'SendMessage' | 'SendStreamingMessage' = 'SendMessage',
): GatewayAnswer {
  return sendMessage(rt, envelope, method).answer;
}

/** How often a waiting `SendMessage` reads its task even with no change signalled. */
export const INBOUND_WAIT_RECHECK_MS = 1_000;

/**
 * `SendMessage` as A2A asks (`returnImmediately`, false by default): a call
 * that did not ask to return at once is answered when its task reaches a
 * terminal or interrupted state (INPUT_REQUIRED, AUTH_REQUIRED: the states
 * a stream ends at), with the view GetTask would give at that moment, its
 * settle and egress checks included.
 *
 * The call is committed first, as `ingressSendMessage` commits it; the wait
 * holds no transaction. It reads the task at each signalled change
 * (`recordInboundChange`), and every `INBOUND_WAIT_RECHECK_MS` whatever is
 * signalled. Two things end it early, and neither touches the task:
 * - the credential the call was authenticated with ends (§10: rotation is
 *   the answer to a stolen bearer; a bearer that runs out ends too): 401,
 *   and the client asks again under its new one;
 * - `waitMs` passes with the task unfinished: an unfinished task is not an
 *   answer A2A allows here, so the error `wait_deadline_exceeded` names the
 *   task instead.
 */
export async function awaitSendMessage(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  waitMs: number = A2A_SEND_WAIT_MS,
): Promise<GatewayAnswer> {
  const sent = sendMessage(rt, envelope, 'SendMessage');
  if (sent.waiting === undefined) return sent.answer;
  const { id, opId, principal, credentialGen } = sent.waiting;
  const clientId = clientIdOfPrincipal(principal);
  let task = sent.waiting.task;
  const signal = inboundChangeSignal(rt.a2a.store);
  const deadline = performance.now() + waitMs;
  for (;;) {
    if (STREAM_ENDING_TASK_STATES.has(task.status.state)) {
      return { status: 200, body: jsonRpcResult(id, { task } as unknown as JsonValue) };
    }
    const left = deadline - performance.now();
    if (left <= 0) {
      return { status: 200, body: jsonRpcError(id, a2aError('internalError', 'wait_deadline_exceeded', { task_id: task.id })) };
    }
    await signal.next(opId, Math.min(left, INBOUND_WAIT_RECHECK_MS));
    // A bearer that ran out while the call waited ended with it, like one rotated or revoked.
    if (clientId !== null) endExpiredBearers(rt.a2a.store, rt.a2a.nowMs(), clientId);
    if (credentialGenOf(rt.a2a.store, principal) !== credentialGen) return unauthenticated();
    const op = rt.a2a.store.getTask(opId);
    if (op === null) return rpcError(id, 'internalError');
    task = inboundTaskView(rt, op);
  }
}

/**
 * A `SendMessage` answer, and what a call that did not ask to return at
 * once waits on: its task, and the credential generation it was
 * authenticated under (read in the same turn as its admission).
 */
interface SentMessage {
  answer: GatewayAnswer;
  waiting?: { id: JsonRpcId; opId: number; task: Task; principal: string; credentialGen: number };
}

function sendMessage(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  method: 'SendMessage' | 'SendStreamingMessage',
): SentMessage {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf(method), params: {} });
  if (!admitted.ok) return { answer: admitted.answer };
  const { principal, scope, id, params } = admitted;
  const streaming = method === 'SendStreamingMessage';
  /** An answer with no task to wait on: a refusal of the request itself. */
  const noTask = (answer: GatewayAnswer): SentMessage => ({ answer });
  const message = params.message;
  if (validateMessage(message) !== null || !isPlainObject(message)) return noTask(rpcError(id, 'invalidParams', 'message_malformed'));
  if (message.role !== 'ROLE_USER') return noTask(rpcError(id, 'invalidParams', 'role_not_user'));
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length > A2A_LIMITS.maxParts) return noTask(rpcError(id, 'invalidParams', 'too_many_parts'));
  const messageId = typeof message.messageId === 'string' ? message.messageId : '';
  const contextIn = message.contextId;
  if (contextIn !== undefined && (typeof contextIn !== 'string' || contextIn === '' || contextIn.length > MAX_ID_LENGTH)) {
    return noTask(rpcError(id, 'invalidParams', 'context_id_malformed'));
  }
  // A webhook set inline is checked with the call's structure: a bad one
  // refuses the call before anything is stored.
  let pushConfig: PushConfigInput | undefined;
  let returnImmediately = false;
  const configuration = params.configuration;
  if (configuration !== undefined) {
    if (!isPlainObject(configuration)) return noTask(rpcError(id, 'invalidParams', 'configuration_malformed'));
    if (configuration.taskPushNotificationConfig !== undefined) {
      const checked = parsePushConfigInput(configuration.taskPushNotificationConfig);
      if (!checked.ok) return noTask(rpcError(id, 'invalidParams', checked.reason));
      pushConfig = checked.config;
    }
    if (configuration.returnImmediately !== undefined) {
      if (typeof configuration.returnImmediately !== 'boolean') return noTask(rpcError(id, 'invalidParams', 'return_immediately_malformed'));
      returnImmediately = configuration.returnImmediately;
    }
  }
  // A stream answers at once by its nature; a plain call waits unless it asked not to.
  const waits = !streaming && !returnImmediately;
  const credentialGen = credentialGenOf(rt.a2a.store, principal);
  const answered = (op: A2ATaskRow): SentMessage => {
    const out = sendMessageAnswer(rt, id, op, streaming);
    return waits
      ? { answer: out.answer, waiting: { id, opId: op.id, task: out.task, principal, credentialGen } }
      : { answer: out.answer };
  };
  // A message that names a task answers that task's question (§7.7).
  if (message.taskId !== undefined) {
    const out = continueInboundCall(rt, { principal, id, params, message, ...(pushConfig === undefined ? {} : { pushConfig }) });
    return out.kind === 'answer' ? noTask(out.answer) : answered(out.op);
  }
  const parsed = parseInvocationEnvelope(parts);
  if (!parsed.ok) {
    const failure = ingressFailureResponse(parsed.reason);
    return noTask(failure.kind === 'protocol_error' ? { status: 200, body: jsonRpcError(id, failure.error) } : rpcError(id, 'internalError'));
  }

  // 5. The receipt decides before anything else may.
  let preHash: string;
  try {
    preHash = sha256HexOfText(canonicalize(params as JsonValue));
  } catch {
    return noTask(rpcError(id, 'invalidParams', 'params_not_canonical'));
  }
  const now = rt.a2a.nowMs();
  const receipt = checkReceipt(rt.a2a.store, { principal, operation: 'SendMessage', messageId }, preHash);
  if (receipt.kind === 'conflict') return noTask(rpcError(id, 'invalidParams', 'message_id_reused'));
  if (receipt.kind === 'replay') {
    if (!rt.budgets.chargeReplay(principal, now)) return noTask(slowDown());
    const op = rt.a2a.store.getTaskByExternal('inbound', principal, receipt.receipt.mapped_external_id);
    return op === null ? noTask(rpcError(id, 'internalError')) : answered(op);
  }
  // 6. A new call spends the principal's budget.
  if (!rt.budgets.chargeMiss(principal, now)) return noTask(slowDown());

  const contextId = typeof contextIn === 'string' ? contextIn : newA2AId();
  const base = { principal, messageId, preHash, contextId };
  const refuse = (reason: IngressFailure): SentMessage => answered(commitRefusal(rt, { ...base, reason }));

  // 7–8. Resolution, registry, access mode, executor.
  const resolution = resolveInboundSkill({
    store: rt.a2a.store,
    grants: rt.grants,
    principal,
    scope,
    envelope: parsed.envelope,
    nowMs: now,
  });
  if (!resolution.ok) return refuse(resolution.reason);
  const resolved = resolution.resolved;
  // 9. Normalization against the pinned schema pair.
  if (resolved.schemas === null) return refuse('schema_unenforceable');
  const normalized = normalizeInvocation({
    envelope: parsed.envelope,
    canonicalCapability: resolved.canonical,
    rkey: resolved.rkey,
    schemas: resolved.schemas,
  });
  if (!normalized.ok) return refuse(normalized.reason);
  // The rules that leave a skill off the card, asked of the same capability: no call reaches what no card shows.
  if (!skillIdFits(resolved.canonical, resolved.rkey)) return refuse('skill_id_too_long');
  if (!skillShareFits(resolved.rkey, projectionCapability(rt.a2a.store, resolved.config, resolved.configuredKey))) {
    return refuse('skill_too_large');
  }

  let op: A2ATaskRow;
  try {
    op = commitAccepted(rt, {
      ...base,
      resolved,
      schemas: resolved.schemas,
      normalized: {
        params: normalized.normalized.params,
        schemaHash: normalized.normalized.schemaHash,
        postHash: normalized.normalized.postHash,
        skill: qualifySkill(resolved.canonical, resolved.rkey),
      },
      ...(pushConfig === undefined ? {} : { pushConfig }),
    });
  } catch (err) {
    if (err instanceof InboundCommitRefused) return refuse(err.reason);
    throw err;
  }
  return answered(op);
}

/**
 * The answer that opens a stream, or a plain one: `{task}` (A2A v1.0's
 * `SendMessageResponse` and a stream's first `StreamResponse` have the same
 * shape). A stream's answer also says which events the Task already
 * reflects. The view settles the task first, which may record its last
 * event, so the sequence number is read after it: nothing the view shows
 * is sent again, and nothing after it is missed.
 */
function sendMessageAnswer(
  rt: InboundRuntime,
  id: JsonRpcId,
  op: A2ATaskRow,
  streaming: boolean,
): { answer: GatewayAnswer; task: Task } {
  const task = inboundTaskView(rt, op);
  const answer: GatewayAnswer = { status: 200, body: jsonRpcResult(id, { task } as unknown as JsonValue) };
  if (streaming) answer.headers = streamOpening(rt, op);
  return { answer, task };
}

/**
 * What the gateway opens a stream with, never relayed: the last event the
 * answered Task reflects, and the client and credential generation the
 * call was authenticated under (§10), read in the same turn as its
 * admission.
 */
function streamOpening(rt: InboundRuntime, op: A2ATaskRow): Record<string, string> {
  return {
    [A2A_EVENT_SEQ_HEADER]: String(rt.a2a.store.getTask(op.id)?.event_seq ?? 0),
    [A2A_CREDENTIAL_GEN_HEADER]: String(credentialGenOf(rt.a2a.store, op.principal)),
    [A2A_STREAM_CLIENT_HEADER]: streamClientKeyOf(op.principal),
  };
}

/** `GetTask` (§4.3): the principal's own task only. */
export function ingressGetTask(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('GetTask'), params: { extId } });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.id);
  if (op === null) return rpcError(admitted.id, 'taskNotFound');
  return { status: 200, body: jsonRpcResult(admitted.id, inboundTaskView(rt, op) as unknown as JsonValue) };
}

/**
 * `SubscribeToTask` (A2A §3.1.6): the principal's own task, not yet ended.
 * Answers the Task the stream opens with and the last event it reflects,
 * as the streaming `SendMessage` does; an ended task is
 * `UnsupportedOperationError`.
 */
export function ingressSubscribeToTask(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('SubscribeToTask'), params: { extId } });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.id);
  if (op === null) return rpcError(admitted.id, 'taskNotFound');
  const task = inboundTaskView(rt, op);
  if (TERMINAL_TASK_STATES.has(task.status.state)) return rpcError(admitted.id, 'unsupportedOperation', 'task_terminal');
  return {
    status: 200,
    headers: streamOpening(rt, op),
    body: jsonRpcResult(admitted.id, { task } as unknown as JsonValue),
  };
}

/**
 * `CancelTask` (§7.4): only before any effect. A task whose child a runner
 * already took, or which settled, is not cancelable.
 */
export function ingressCancelTask(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('CancelTask'), params: { extId } });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.id);
  if (op === null) return rpcError(admitted.id, 'taskNotFound');
  const canceled = rt.a2a.store.transaction(() => {
    const fresh = rt.a2a.store.getTask(op.id);
    if (fresh === null || fresh.state !== 'open' || fresh.internal_id === null) return null;
    const child = rt.a2a.workflow.store().getById(fresh.internal_id);
    // Before any effect: queued, waiting on the owner, or waiting on the caller's answer.
    const before =
      child !== null &&
      (child.status === WorkflowTaskState.Queued ||
        child.status === WorkflowTaskState.PendingApproval ||
        child.status === WorkflowTaskState.Awaiting);
    if (!before || fresh.effect_phase === 'effect_started') return null;
    // The operation ends first: cancelling a review card fires the owner's
    // decision handler, whose settle must find the call already canceled
    // (else it would read the withdrawn card as the owner's no).
    const ended = endInboundOperation(rt, fresh, { state: 'canceled', reason_code: 'canceled' });
    if (ended === null) return null;
    rt.a2a.workflow.cancel(child.id, 'a2a_canceled');
    return ended;
  });
  if (canceled === null) return rpcError(admitted.id, 'taskNotCancelable');
  return { status: 200, body: jsonRpcResult(admitted.id, inboundTaskView(rt, canceled) as unknown as JsonValue) };
}

/**
 * `ListTasks` (§4.3): the principal's tasks, most recently updated first
 * (A2A v1.0.1 §3.1.4), in pages of at most 50, with an opaque cursor.
 * Filters by `contextId` and `statusTimestampAfter`; `totalSize` counts
 * every match. Artifacts are included only when `includeArtifacts` is true.
 * A `status` filter is refused: a completed call reads FAILED once the
 * authority behind its result lapses, so no stored column can answer it
 * exactly, and an inexact filter would page wrongly.
 */
export function ingressListTasks(rt: InboundRuntime, envelope: GatewayEnvelope): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('ListTasks'), params: {} });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const { params } = admitted;
  // TASK_STATE_UNSPECIFIED is proto3's default: a client that writes defaults sends it for "no filter".
  if (params.status !== undefined && params.status !== 'TASK_STATE_UNSPECIFIED') {
    return rpcError(admitted.id, 'invalidParams', 'status_filter_unsupported');
  }
  const size =
    typeof params.pageSize === 'number' && Number.isInteger(params.pageSize) && params.pageSize > 0
      ? Math.min(params.pageSize, MAX_LIST_PAGE)
      : MAX_LIST_PAGE;
  // The cursor names a task by its time and the id its client already holds,
  // never a row id: a node-wide counter would tell a client how much else the
  // node does (design §10, A2A-I5).
  let after: { at: number; taskId: string } | null = null;
  if (typeof params.pageToken === 'string' && params.pageToken !== '') {
    let fields: unknown;
    try {
      fields = JSON.parse(base64urlDecodeUtf8(params.pageToken) ?? '');
    } catch {
      fields = null;
    }
    if (
      !Array.isArray(fields) ||
      fields.length !== 2 ||
      !Number.isSafeInteger(fields[0]) ||
      typeof fields[1] !== 'string' ||
      fields[1] === ''
    ) {
      return rpcError(admitted.id, 'invalidParams', 'page_token_malformed');
    }
    after = { at: fields[0] as number, taskId: fields[1] };
  }
  const filters: string[] = ["direction = 'inbound'", 'principal = ?'];
  const args: (string | number)[] = [admitted.principal];
  if (params.contextId !== undefined) {
    if (typeof params.contextId !== 'string' || params.contextId === '') {
      return rpcError(admitted.id, 'invalidParams', 'context_id_malformed');
    }
    filters.push('context_id = ?');
    args.push(params.contextId);
  }
  if (params.statusTimestampAfter !== undefined) {
    const at = typeof params.statusTimestampAfter === 'string' ? Date.parse(params.statusTimestampAfter) : Number.NaN;
    if (!Number.isFinite(at)) return rpcError(admitted.id, 'invalidParams', 'status_timestamp_malformed');
    // "greater than or equal to this value" (a2a.proto v1.0.1): a client polling from the
    // last time it saw misses nothing changed at that same time.
    filters.push('status_updated_at >= ?');
    args.push(at);
  }
  if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean') {
    return rpcError(admitted.id, 'invalidParams', 'include_artifacts_malformed');
  }
  // One time for the whole list: every change a view of these tasks would make is made
  // first, as of that time, and every view is built as of it too, so no task's status time
  // moves while the list is counted, ordered and cut into pages (a grant that expires a
  // millisecond later is the next list's to see).
  const at = rt.a2a.nowMs();
  const asOf: InboundRuntime = { ...rt, a2a: { ...rt.a2a, nowMs: () => at } };
  reconcileForListing(asOf, admitted.principal);
  const where = filters.join(' AND ');
  const total = (rt.a2a.store.db.query(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${where}`, args) as { n: number }[])[0]?.n ?? 0;
  const rows = rt.a2a.store.db.query(
    `SELECT id FROM a2a_tasks WHERE ${where}
       ${after === null ? '' : 'AND (status_updated_at < ? OR (status_updated_at = ? AND external_id < ?))'}
     ORDER BY status_updated_at DESC, external_id DESC LIMIT ?`,
    after === null ? [...args, size + 1] : [...args, after.at, after.at, after.taskId, size + 1],
  ) as { id: number }[];
  const page = rows.slice(0, size).flatMap((r) => {
    const op = rt.a2a.store.getTask(r.id);
    return op === null ? [] : [op];
  });
  const last = page[page.length - 1];
  const withArtifacts = params.includeArtifacts === true;
  const result: JsonObject = {
    tasks: page.map((op) => {
      const task = inboundTaskView(asOf, op);
      if (!withArtifacts) delete task.artifacts;
      return task as unknown as JsonValue;
    }),
    totalSize: total,
    pageSize: size,
    nextPageToken:
      rows.length > size && last !== undefined ? base64urlEncodeUtf8(JSON.stringify([last.status_updated_at, last.external_id])) : '',
  };
  return { status: 200, body: jsonRpcResult(admitted.id, result) };
}

/**
 * Bring a principal's tasks to the state a view of each would give, before
 * ListTasks counts, orders and pages them (A2A §3.1.4: newest status first;
 * the cursor is a status time). A view settles a task whose round ended and
 * ends one whose authority lapsed, and either moves its status time to now.
 * Done first, no task's time moves while the list is made, and no later page
 * holds a task newer than the cursor that led to it.
 *
 * Only tasks a view can still change are read: open ones (a round may have
 * ended; an asking call's authority may have lapsed) and completed ones (the
 * authority over their result may have lapsed). Completed tasks are judged by
 * the authority they were accepted under, once per distinct one (listing,
 * capability, grant, listing pin), so a client with many old results costs one
 * grouped query and a check per authority, not a check per task. A task
 * accepted before listings were pinned is judged alone (its acceptance time
 * decides), and one whose snapshot cannot be read ends as a view would end it.
 */
function reconcileForListing(rt: InboundRuntime, principal: string): void {
  const store = rt.a2a.store;
  for (const op of store.inboundTasksOf(principal, 'open')) {
    if (settleInbound(rt, op) === null && op.input_required_json !== null) endLostEgress(rt, op);
  }
  for (const op of store.completedInboundUnreadable(principal)) endLostEgress(rt, op);
  for (const { sample: sampleId, ...authority } of store.completedInboundAuthorities(principal)) {
    if (authority.listing_created_at !== null) {
      const sample = store.getTask(sampleId);
      const snapshot = sample === null ? null : readInboundSnapshot(sample);
      if (sample === null || snapshot === null || inboundEgressLoss(rt, sample, snapshot) === null) continue;
    }
    // A lost authority (or an unpinned one, judged task by task) ends what each result still holds.
    for (const op of store.completedInboundUnder(principal, authority)) endLostEgress(rt, op);
  }
}

// ---------------------------------------------------------------- review

/** A review card Core minted for an inbound call. */
export function isInboundReviewCard(payload: string): boolean {
  return parseInboundReviewCard(payload) !== null;
}

/**
 * The owner approved an inbound review card: if the authority the call was
 * accepted under still holds, mint its execution child (and, for an
 * effectful class, the permit the child's claim will consume) in one
 * commit. Idempotent: a card already acted on, or an operation already
 * settled, changes nothing.
 */
export function approveInboundReview(core: InboundCore, cardId: string): 'minted' | 'closed' | null {
  const link = core.a2a.store.getChild(cardId);
  if (link === null || link.role !== 'approval') return null;
  return core.a2a.store.transaction(() => {
    const op = core.a2a.store.getTask(link.operation_ref);
    const card = core.a2a.workflow.store().getById(cardId);
    if (op === null || op.direction !== 'inbound' || op.state !== 'open' || op.internal_id !== cardId) return null;
    if (card === null || card.status !== WorkflowTaskState.Queued) return null;
    // The approved card ends in this commit, as Lane 1's consent card does: completed once its
    // round is minted, failed with the reason the call closed for. Left queued, it would lapse
    // a day later into a "failed, expired" record of a decision the owner made.
    const close = (reason: string): 'closed' | null => {
      if (endInboundOperation(core, op, { state: 'failed', reason_code: reason }) === null) return null;
      settleReviewCard(core, cardId, { ok: false, reason });
      return 'closed';
    };
    const snapshot = readInboundSnapshot(op);
    if (snapshot === null) return close('snapshot_unreadable');
    const loss = inboundAuthorityLoss(core, op, snapshot);
    if (loss !== null) return close(loss);
    let childId: string;
    try {
      childId = mintExecutionChild(core, op, snapshot, 0);
    } catch (err) {
      // No round can run (no executor, or no node DID to name the listing
      // under): the call ends here, once, rather than wait for a repair
      // that would refuse it on every sweep. The refusal writes nothing.
      if (!(err instanceof InboundCommitRefused)) throw err;
      return close(err.reason);
    }
    settleReviewCard(core, cardId, { ok: true, childId });
    // The new child is a visible change: the review card's WORKING becomes SUBMITTED.
    recordInboundChange(core, op.id);
    return 'minted';
  });
}

/**
 * A review card the owner can no longer act on, withdrawn (§7.3): the call's
 * authority is gone (its client or grant revoked, its listing paused,
 * removed or changed), so allowing it could only close it. The call ends
 * FAILED with the reason, and the card is cancelled, in one commit; the
 * owner's inbox and the phone mirror stop offering it. The runner's sweep
 * calls this every tick, so every cause of the loss is met the same way.
 * True when it withdrew the card.
 */
export function withdrawLapsedReview(core: InboundCore, op: A2ATaskRow): boolean {
  if (op.direction !== 'inbound' || op.state !== 'open' || op.internal_id === null) return false;
  const cardId = op.internal_id;
  if (core.a2a.store.getChild(cardId)?.role !== 'approval') return false;
  return core.a2a.store.transaction((): boolean => {
    const fresh = core.a2a.store.getTask(op.id);
    const card = core.a2a.workflow.store().getById(cardId);
    if (fresh === null || fresh.state !== 'open' || fresh.internal_id !== cardId) return false;
    if (card?.status !== WorkflowTaskState.PendingApproval) return false;
    const snapshot = readInboundSnapshot(fresh);
    const reason = snapshot === null ? 'snapshot_unreadable' : inboundAuthorityLoss(core, fresh, snapshot);
    if (reason === null) return false;
    if (endInboundOperation(core, fresh, { state: 'failed', reason_code: reason }) === null) return false;
    core.a2a.workflow.cancel(cardId, `a2a_${reason}`);
    return true;
  });
}

/** An approved (queued) review card, run to its end: the decision has been acted on. */
function settleReviewCard(core: InboundCore, cardId: string, outcome: { ok: true; childId: string } | { ok: false; reason: string }): void {
  core.a2a.workflow.store().transition(cardId, WorkflowTaskState.Queued, WorkflowTaskState.Running, core.a2a.nowMs());
  if (outcome.ok) {
    core.a2a.workflow.complete(cardId, JSON.stringify({ execution_task_id: outcome.childId }), 'approved and started');
  } else {
    core.a2a.workflow.fail(cardId, outcome.reason);
  }
}

/**
 * The inbound half of A2A's approval decision handler. Approval mints the
 * execution child; a refusal or a lapse settles the operation, which reads
 * the card's end and answers a neutral FAILED.
 */
export function makeInboundDecisionHandler(core: () => InboundCore | null) {
  return ({ task, decision }: { task: { id: string; payload: string }; decision: 'approved' | 'denied' | 'lapsed' }): void => {
    if (!isInboundReviewCard(task.payload)) return;
    const c = core();
    if (c === null) return;
    if (decision === 'approved') {
      approveInboundReview(c, task.id);
      return;
    }
    const link = c.a2a.store.getChild(task.id);
    const op = link === null ? null : c.a2a.store.getTask(link.operation_ref);
    if (op !== null) settleInbound(c, op);
  };
}

export interface InboundSweepCounts {
  minted: number;
  settled: number;
  failed: number;
}

/**
 * Repair what a crash or a missed hook left (A2A §6.2 step 6, the inbound
 * mirror): an approved review card with no execution child gets one; an
 * operation whose child ended is settled. Each operation on its own; one
 * that throws is counted and reported (its id and the error's class, never
 * a message) and retried next sweep.
 */
export function sweepA2AInbound(
  core: InboundCore,
  onError?: (entry: { operation_id: string; error: string }) => void,
): InboundSweepCounts {
  const counts: InboundSweepCounts = { minted: 0, settled: 0, failed: 0 };
  for (const op of core.a2a.store.listTasksInStates('inbound', ['open'])) {
    try {
      const child = op.internal_id === null ? null : core.a2a.store.getChild(op.internal_id);
      if (child?.role === 'approval') {
        const card = core.a2a.workflow.store().getById(child.child_task_id);
        if (card?.status === WorkflowTaskState.Queued) {
          if (approveInboundReview(core, child.child_task_id) === 'minted') counts.minted += 1;
          continue;
        }
        if (withdrawLapsedReview(core, op)) {
          counts.settled += 1;
          continue;
        }
      }
      if (settleInbound(core, op) !== null) {
        counts.settled += 1;
        continue;
      }
      // A question whose call lost its authority ends here, not a day later
      // at its deadline (§7.3, §7.7).
      if (op.input_required_json !== null && endLostEgress(core, op)?.state === 'failed') {
        counts.settled += 1;
        continue;
      }
      // A change whose record a crash or an isolated observer error lost
      // is recorded now; one already recorded writes nothing.
      core.a2a.store.transaction(() => recordInboundChange(core, op.id));
    } catch (err) {
      counts.failed += 1;
      onError?.({ operation_id: op.external_id, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  return counts;
}

// ---------------------------------------------------------------- claims

export type InboundClaimVerdict = 'not_inbound' | 'admitted' | 'refused';

/**
 * When a claimed effectful round crosses its effect boundary: at the claim
 * (`at_claim`, the rule for every external runner, §7.3), or later, when
 * the in-process runner asks (`authorizeInboundEffectWith`) right before
 * the capability's first effect or before handing its result over
 * (`deferred`). Until then the round is pre-effect, so it may still ask the
 * caller for input (§7.7), and a lost lease requeues it safely.
 */
export type InboundEffectBoundary = 'at_claim' | 'deferred';

/**
 * The round's minted permit, checked: unexpired, bound to the payload this
 * round runs (its params and every answer so far) and to the runner it is
 * pinned to. Returns why not, or null.
 */
function roundPermitProblem(
  core: InboundCore,
  op: A2ATaskRow,
  childId: string,
  snapshot: InboundSnapshot,
  pep: string | null,
  now: number,
): { reason: string } | { permitId: string } {
  const permit = core.a2a.store
    .permitsOf(op.id)
    .find((p) => p.direction === 'inbound' && p.execution_child_id === childId && p.state === 'minted');
  if (permit === undefined || permit.expires_at <= now) return { reason: 'permit_unavailable' };
  const child = core.a2a.workflow.store().getById(childId);
  const continuation = child === null ? undefined : parseServiceQueryExecutionPayload(child.payload)?.continuation;
  if (permit.payload_hash !== inboundRoundHash(snapshot, continuation) || permit.pep_did !== pep) {
    return { reason: 'permit_mismatch' };
  }
  return { permitId: permit.permit_id };
}

/** Consume a checked permit, once: the round's effect then counts as started. */
function crossEffectBoundary(core: InboundCore, op: A2ATaskRow, permitId: string, now: number): boolean {
  if (!core.a2a.store.consumePermit(permitId, now)) return false;
  core.a2a.store.updateTask(op.id, ['open'], { effect_phase: 'effect_started' }, now);
  return true;
}

/**
 * The claim boundary for an inbound child (§7.3): the claimant must be the
 * pinned runner, the authority the call was accepted under must still hold,
 * and an effectful round's permit must be the one minted for its payload.
 * At `at_claim` the permit is consumed here, once, by compare-and-swap, and
 * the effect counts as started (a lease lost after this is
 * `outcome_unknown`, never a requeue); `deferred` leaves that to
 * `authorizeInboundEffectWith`. A refused claim ends the operation with the
 * reason, in that commit, then fails the child.
 */
export function admitInboundClaimWith(
  core: InboundCore,
  task: ClaimedChild,
  claimantDid: string,
  boundary: InboundEffectBoundary = 'at_claim',
): InboundClaimVerdict {
  const link = core.a2a.store.getChild(task.id);
  if (link === null || link.role !== 'execution') return 'not_inbound';
  const op = core.a2a.store.getTask(link.operation_ref);
  if (op === null || op.direction !== 'inbound') return 'not_inbound';
  const now = core.a2a.nowMs();
  const refusal = core.a2a.store.transaction((): string | null => {
    const fresh = core.a2a.store.getTask(op.id);
    if (fresh === null || fresh.state !== 'open' || fresh.internal_id !== task.id) return 'operation_settled';
    const refuse = (reason: string): string => {
      // Ended here, with the reason, before the child fails: settling the
      // failed child then finds the operation closed.
      endInboundOperation(core, fresh, { state: 'failed', reason_code: reason });
      return reason;
    };
    if (link.pep_did !== null && link.pep_did !== undefined && link.pep_did !== claimantDid) return refuse('not_the_pinned_runner');
    const snapshot = readInboundSnapshot(fresh);
    if (snapshot === null) return refuse('snapshot_unreadable');
    const loss = inboundAuthorityLoss(core, fresh, snapshot);
    if (loss !== null) return refuse(loss);
    if (INBOUND_EFFECTFUL_CLASSES.has(snapshot.action_class)) {
      const permit = roundPermitProblem(core, fresh, task.id, snapshot, link.pep_did ?? null, now);
      if ('reason' in permit) return refuse(permit.reason);
      if (boundary === 'at_claim' && !crossEffectBoundary(core, fresh, permit.permitId, now)) return refuse('permit_unavailable');
    }
    // SUBMITTED (or a continued round's WORKING) becomes WORKING: recorded
    // when the view changed (§4.3, §7.5).
    recordInboundChange(core, fresh.id);
    return null;
  });
  if (refusal === null) return 'admitted';
  failRefusedChild(core.a2a.workflow, task, refusal, claimantDid);
  return 'refused';
}

export type InboundEffectVerdict = 'not_inbound' | 'authorized' | 'refused';

/**
 * The deferred effect boundary of an in-process round (§7.3, §7.7): its
 * runner calls this right before the capability's first effect, or before
 * handing a result over when the capability made none. The claim must
 * still be this runner's, the authority must still hold, and an effectful
 * round's permit is consumed here, once; the effect then counts as
 * started. Idempotent: a round whose permit it already consumed is
 * authorized again, before any authority is judged, since its effect began
 * and nothing here may read it as not having happened (A2A-I8); what the
 * client may still see is `settleInbound`'s to judge, which ends a call whose
 * egress was lost OUTCOME_UNKNOWN with its result kept for the owner. A
 * non-effectful round has nothing to consume. A refusal ends the operation
 * with the reason (OUTCOME_UNKNOWN should its effect have begun) and fails
 * the child, as a refused claim does; nothing may act on it.
 */
export function authorizeInboundEffectWith(core: InboundCore, task: ClaimedChild, claimantDid: string): InboundEffectVerdict {
  const link = core.a2a.store.getChild(task.id);
  if (link === null || link.role !== 'execution') return 'not_inbound';
  const op = core.a2a.store.getTask(link.operation_ref);
  if (op === null || op.direction !== 'inbound') return 'not_inbound';
  const now = core.a2a.nowMs();
  const refusal = core.a2a.store.transaction((): string | null => {
    const fresh = core.a2a.store.getTask(op.id);
    if (fresh === null || fresh.state !== 'open' || fresh.internal_id !== task.id) return 'operation_settled';
    const child = core.a2a.workflow.store().getById(task.id);
    if (child?.status !== WorkflowTaskState.Running || child.agent_did !== claimantDid) return 'claim_lost';
    const refuse = (reason: string): string => {
      endInboundOperation(core, fresh, {
        state: fresh.effect_phase === 'effect_started' ? 'outcome_unknown' : 'failed',
        reason_code: reason,
      });
      return reason;
    };
    const mine = core.a2a.store.permitsOf(fresh.id).find((p) => p.execution_child_id === task.id && p.state === 'consumed');
    if (mine !== undefined) return null;
    const snapshot = readInboundSnapshot(fresh);
    if (snapshot === null) return refuse('snapshot_unreadable');
    const loss = inboundAuthorityLoss(core, fresh, snapshot);
    if (loss !== null) return refuse(loss);
    if (!INBOUND_EFFECTFUL_CLASSES.has(snapshot.action_class)) return null;
    const permit = roundPermitProblem(core, fresh, task.id, snapshot, link.pep_did ?? null, now);
    if ('reason' in permit) return refuse(permit.reason);
    return crossEffectBoundary(core, fresh, permit.permitId, now) ? null : refuse('permit_unavailable');
  });
  if (refusal === null) return 'authorized';
  failRefusedChild(core.a2a.workflow, task, refusal, claimantDid);
  return 'refused';
}

/**
 * A child as its claimant holds it: the claim the check is for. A plugin
 * lane's child fails only under its claim token, so a refusal carries it.
 */
export interface ClaimedChild {
  id: string;
  claim_id?: string | null;
}

/**
 * Fail a child its claim was refused for, under that claim: the claim just
 * made, never a later one. One that already ended stays as it ended.
 */
function failRefusedChild(workflow: WorkflowService, task: ClaimedChild, reason: string, claimantDid: string): void {
  try {
    workflow.fail(task.id, reason, claimantDid, task.claim_id ?? undefined);
  } catch (err) {
    if (!(err instanceof WorkflowTransitionError)) throw err;
  }
}

/**
 * The same check against the installed A2A runtime, for the claim route and
 * the in-process runner. A child that is A2A's when the runtime cannot be
 * built is refused and failed: nothing runs without its authority checked.
 */
export function admitInboundClaim(
  task: ClaimedChild,
  claimantDid: string,
  boundary: InboundEffectBoundary = 'at_claim',
): InboundClaimVerdict {
  const store = getA2AStore();
  if (store === null) return 'not_inbound';
  const link = store.getChild(task.id);
  if (link === null || link.role !== 'execution') return 'not_inbound';
  const op = store.getTask(link.operation_ref);
  if (op === null || op.direction !== 'inbound') return 'not_inbound';
  let a2a: A2ARuntime | null;
  try {
    a2a = getA2ARuntime();
  } catch {
    a2a = null;
  }
  if (a2a === null) {
    const workflow = getWorkflowService();
    if (workflow !== null) failRefusedChild(workflow, task, 'a2a_unavailable', claimantDid);
    return 'refused';
  }
  return admitInboundClaimWith(inboundCore(a2a), task, claimantDid, boundary);
}

/** `authorizeInboundEffectWith` against the installed A2A runtime, for the in-process runner. */
export function authorizeInboundEffect(task: ClaimedChild, claimantDid: string): InboundEffectVerdict {
  const store = getA2AStore();
  if (store === null) return 'not_inbound';
  const link = store.getChild(task.id);
  if (link === null || link.role !== 'execution') return 'not_inbound';
  let a2a: A2ARuntime | null;
  try {
    a2a = getA2ARuntime();
  } catch {
    a2a = null;
  }
  if (a2a === null) {
    const workflow = getWorkflowService();
    if (workflow !== null) failRefusedChild(workflow, task, 'a2a_unavailable', claimantDid);
    return 'refused';
  }
  return authorizeInboundEffectWith(inboundCore(a2a), task, claimantDid);
}

/** Lane 2's view of an A2A runtime: grants read from the installed repository. */
export function inboundCore(a2a: A2ARuntime): InboundCore {
  return { a2a, grants: getServiceGrantRepository() };
}
