/**
 * Inbound multi-turn (design §7.7, M4): a runner may ask the caller for
 * more input, but only before any effect has started; the caller's answer
 * runs as the call's next round, with a fresh permit.
 *
 * Asking (`requestInboundInputWith`). The runner holding the round's claim
 * reports a prompt and the JSON Schema the answer must meet. In one commit
 * Core parks the round's child (`running → awaiting`: its claim released,
 * a deadline set for the answer), voids the round's permit if it is still
 * minted, so no effect authority outlives the question, stores the
 * question on the operation and records the change: the caller sees
 * INPUT_REQUIRED, the question as the status message. Core refuses once the
 * round's effect has started (its permit consumed). An external runner of
 * an effectful call consumed it at claim, so its only ends are complete,
 * fail or unknown; an in-process round that defers its effect boundary
 * (`authorizeInboundEffectWith`) may ask until it crosses it. A plugin's
 * runner has no way to ask.
 *
 * Answering (`continueInboundCall`). A SendMessage that names the task. It
 * must come from the operation's principal, find the task asking, keep its
 * contextId, pass the receipt check on its own messageId (the same answer
 * again gets the task back), and carry exactly one data part valid against
 * the stored schema. Then one commit: the round counter moves on by
 * compare-and-set, the next round's child is minted with every answer so
 * far (`continuation` on its payload) and, for an effectful class, its own
 * fresh permit under the call's original approval, and the waiting child
 * is retired. A second answer to the same question finds the task no
 * longer asking.
 *
 * An unanswered question ends the call when the waiting child's deadline
 * passes: the expiry sweep fails the child, and settling reads it as
 * `input_not_received`.
 */

import {
  canonicalize,
  isPlainObject,
  type JsonRpcId,
  type JsonValue,
} from '@dina/a2a';
import {
  parseServiceQueryExecutionPayload,
  pinnedSchemaProblems,
  type ServiceExecutionContinuation,
} from '@dina/protocol';

import { validateAgainstSchema } from '../plugins/schema_validate';
import { getServiceGrantRepository } from '../service/service_grant_repository';
import { WorkflowTaskState } from '../workflow/domain';

import { endLostEgress, recordInboundChange } from './delivery';
import { sha256HexOfText } from './digest';
import { InboundCommitRefused, endInboundOperation, mintExecutionChild } from './inbound_children';
import {
  inboundQuestionOf,
  readInboundSnapshot,
  type InboundCore,
  type InboundQuestion,
  type InputRequest,
} from './inbound_view';
import { ownedOperation, rpcError, slowDown, type GatewayAnswer, type InboundRuntime } from './ingress_common';
import { addPushConfig, MAX_PUSH_CONFIGS_PER_TASK, type PushConfigInput } from './push_configs';
import { checkReceipt, insertReceipt } from './receipts';
import { getA2ARuntime, getA2AStore } from './runtime';

import type { A2ATaskRow } from './store';

/** How long a question waits for the caller's answer. */
export const INBOUND_INPUT_DEADLINE_SECONDS = 24 * 60 * 60;
/** The most rounds one call may run: its first, and seven answers. */
export const MAX_INBOUND_ROUNDS = 8;
export const MAX_INPUT_PROMPT_CHARS = 2_000;
export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;

export type InputRequestRefusal =
  | 'request_malformed'
  | 'operation_settled'
  | 'not_the_pinned_runner'
  | 'executor_cannot_ask'
  | 'effect_started'
  | 'too_many_rounds'
  | 'claim_lost';

export type InputRequestVerdict =
  | { kind: 'parked'; question: InboundQuestion }
  | { kind: 'not_inbound' }
  | { kind: 'refused'; reason: InputRequestRefusal };

// C0 controls other than tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** A runner's question, checked strictly: exactly these two members, each well formed. */
export function parseInputRequest(raw: unknown): InputRequest | null {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).sort().join(',') !== 'input_schema,prompt') return null;
  const { prompt, input_schema: schema } = raw;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_INPUT_PROMPT_CHARS) return null;
  if (CONTROL_RE.test(prompt)) return null;
  if (!isPlainObject(schema) || schema.type !== 'object') return null;
  // A constraint Core's validator would skip cannot be what stands between
  // the caller's answer and the runner (the rule for a call's params).
  if (pinnedSchemaProblems(schema, 'pinned_runtime').length > 0) return null;
  let text: string;
  try {
    text = canonicalize(schema as JsonValue);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > MAX_INPUT_SCHEMA_BYTES) return null;
  return { prompt, input_schema: JSON.parse(text) as Record<string, unknown> };
}

/** The answers a round's child runs with, read off its payload. */
function continuationOfChild(rt: InboundCore, childId: string): ServiceExecutionContinuation | undefined {
  const child = rt.a2a.workflow.store().getById(childId);
  return child === null ? undefined : parseServiceQueryExecutionPayload(child.payload)?.continuation;
}

// ---------------------------------------------------------------- asking

/**
 * A runner asks the caller for input (see the module comment). `claimId`
 * is the round's claim token: required from an external runner (the
 * route's guard sees to it), the in-process runner's own otherwise.
 */
export function requestInboundInputWith(
  core: InboundCore,
  args: { taskId: string; claimantDid: string; claimId: string | undefined; request: unknown },
): InputRequestVerdict {
  const link = core.a2a.store.getChild(args.taskId);
  if (link === null || link.role !== 'execution') return { kind: 'not_inbound' };
  const op = core.a2a.store.getTask(link.operation_ref);
  if (op === null || op.direction !== 'inbound') return { kind: 'not_inbound' };
  const request = parseInputRequest(args.request);
  if (request === null) return { kind: 'refused', reason: 'request_malformed' };
  return core.a2a.store.transaction((): InputRequestVerdict => {
    const refuse = (reason: InputRequestRefusal): InputRequestVerdict => ({ kind: 'refused', reason });
    const fresh = core.a2a.store.getTask(op.id);
    if (fresh === null || fresh.state !== 'open' || fresh.internal_id !== args.taskId) return refuse('operation_settled');
    if (link.pep_did !== null && link.pep_did !== undefined && link.pep_did !== args.claimantDid) {
      return refuse('not_the_pinned_runner');
    }
    const snapshot = readInboundSnapshot(fresh);
    if (snapshot === null || snapshot.executor.kind === 'plugin') return refuse('executor_cannot_ask');
    const permits = core.a2a.store.permitsOf(fresh.id).filter((p) => p.execution_child_id === args.taskId);
    if (fresh.effect_phase === 'effect_started' || permits.some((p) => p.state === 'consumed')) {
      return refuse('effect_started');
    }
    if (link.generation >= MAX_INBOUND_ROUNDS - 1) return refuse('too_many_rounds');
    const now = core.a2a.nowMs();
    const expiresAtSec = Math.floor(now / 1000) + INBOUND_INPUT_DEADLINE_SECONDS;
    if (!core.a2a.workflow.store().parkForInput(args.taskId, args.claimantDid, args.claimId, now, expiresAtSec)) {
      return refuse('claim_lost');
    }
    for (const permit of permits) {
      if (permit.state === 'minted') core.a2a.store.voidPermit(permit.permit_id, 'input_required');
    }
    const question: InboundQuestion = { ...request, round: link.generation, asked_at: now, expires_at: expiresAtSec * 1000 };
    core.a2a.store.updateTask(fresh.id, ['open'], { input_required_json: JSON.stringify(question) }, now);
    recordInboundChange(core, fresh.id);
    return { kind: 'parked', question };
  });
}

/** The same against the installed A2A runtime, for the executor route and the in-process runner. */
export function requestInboundInput(args: {
  taskId: string;
  claimantDid: string;
  claimId: string | undefined;
  request: unknown;
}): InputRequestVerdict {
  if (getA2AStore() === null) return { kind: 'not_inbound' };
  let a2a: ReturnType<typeof getA2ARuntime>;
  try {
    a2a = getA2ARuntime();
  } catch {
    a2a = null;
  }
  if (a2a === null) return { kind: 'not_inbound' };
  return requestInboundInputWith({ a2a, grants: getServiceGrantRepository() }, args);
}

// ---------------------------------------------------------------- answering

export type ContinuationOutcome = { kind: 'answer'; answer: GatewayAnswer } | { kind: 'continued'; op: A2ATaskRow };

/**
 * A SendMessage that names a task: the caller's answer to its question
 * (see the module comment). The message is already structurally valid and
 * from the user; `pushConfig` is a webhook it configured inline, already
 * checked.
 */
export function continueInboundCall(
  rt: InboundRuntime,
  args: {
    principal: string;
    id: JsonRpcId;
    params: Record<string, unknown>;
    message: Record<string, unknown>;
    pushConfig?: PushConfigInput;
  },
): ContinuationOutcome {
  const { principal, id, message } = args;
  const answer = (a: GatewayAnswer): ContinuationOutcome => ({ kind: 'answer', answer: a });
  const op = ownedOperation(rt, principal, message.taskId);
  if (op === null) return answer(rpcError(id, 'taskNotFound'));
  const messageId = typeof message.messageId === 'string' ? message.messageId : '';
  let preHash: string;
  try {
    preHash = sha256HexOfText(canonicalize(args.params as JsonValue));
  } catch {
    return answer(rpcError(id, 'invalidParams', 'params_not_canonical'));
  }
  // The receipt decides before anything else may: the same answer again
  // gets the task back, whatever it is doing now.
  const now = rt.a2a.nowMs();
  const receipt = checkReceipt(rt.a2a.store, { principal, operation: 'SendMessage', messageId }, preHash);
  if (receipt.kind === 'conflict') return answer(rpcError(id, 'invalidParams', 'message_id_reused'));
  if (receipt.kind === 'replay') {
    if (!rt.budgets.chargeReplay(principal, now)) return answer(slowDown());
    const replayed = rt.a2a.store.getTaskByExternal('inbound', principal, receipt.receipt.mapped_external_id);
    return replayed === null ? answer(rpcError(id, 'internalError')) : { kind: 'continued', op: replayed };
  }
  // An answer reads the call, so it ends one that lost its authority (notes
  // M4 step 2: the first read, claim or sweep that finds it), before any
  // budget is spent: the caller hears it is no longer asking, never WORKING.
  if (endLostEgress(rt, op) !== null) return answer(rpcError(id, 'unsupportedOperation', 'task_not_awaiting_input'));
  const question = inboundQuestionOf(op);
  if (op.state !== 'open' || question === null || !childAwaiting(rt, op)) {
    return answer(rpcError(id, 'unsupportedOperation', 'task_not_awaiting_input'));
  }
  if (message.contextId !== undefined && message.contextId !== op.context_id) {
    return answer(rpcError(id, 'invalidParams', 'context_mismatch'));
  }
  // The body's strict parse already bounds the answer's depth and refuses
  // a `__proto__` member, so the answer canonicalizes.
  const input = singleDataPart(message.parts);
  if (input === null) return answer(rpcError(id, 'invalidParams', 'input_not_one_data_part'));
  if (!validateAgainstSchema(input, question.input_schema).ok) return answer(rpcError(id, 'invalidParams', 'input_invalid'));
  if (args.pushConfig !== undefined && rt.a2a.store.pushConfigsOf(op.id).length >= MAX_PUSH_CONFIGS_PER_TASK) {
    return answer(rpcError(id, 'invalidParams', 'too_many_push_configs'));
  }
  // A new round is new work: it spends the principal's budget.
  if (!rt.budgets.chargeMiss(principal, now)) return answer(slowDown());

  const continued = rt.a2a.store.transaction((): A2ATaskRow | null => {
    const fresh = rt.a2a.store.getTask(op.id);
    const asked = fresh === null ? null : inboundQuestionOf(fresh);
    if (fresh === null || fresh.state !== 'open' || asked === null || fresh.internal_id === null) return null;
    const waiting = fresh.internal_id;
    if (!childAwaiting(rt, fresh)) return null;
    const snapshot = readInboundSnapshot(fresh);
    if (snapshot === null) return null;
    // Authority lost since the check above (a revocation in between) ends the call here, in the same commit.
    if (endLostEgress(rt, fresh) !== null) return null;
    // Compare-and-set on the round, inside the commit: the one answer that
    // moves it wins, and any other finds the task no longer asking.
    if (fresh.continuation_generation !== asked.round) return null;
    const round = asked.round + 1;
    rt.a2a.store.updateTask(fresh.id, ['open'], { continuation_generation: round, input_required_json: null }, now);
    const earlier = continuationOfChild(rt, waiting)?.turns ?? [];
    const turns = [...earlier, { prompt: asked.prompt, input_schema: asked.input_schema, input }];
    // The call's child becomes the next round in this commit, so a later
    // settle reads that round, never the waiting child retired here.
    let ended = false;
    try {
      mintExecutionChild(rt, fresh, snapshot, round, { turns });
    } catch (err) {
      // No round can run (no node DID to name the listing under): the call
      // ends here, once, and the caller is answered with it, FAILED. The
      // refusal writes nothing; the answer's receipt below still lands, so
      // a retry reads the same end.
      if (!(err instanceof InboundCommitRefused)) throw err;
      endInboundOperation(rt, fresh, { state: 'failed', reason_code: err.reason });
      ended = true;
    }
    rt.a2a.workflow.cancel(waiting, 'a2a_answered');
    insertReceipt(rt.a2a.store, {
      principal,
      operation: 'SendMessage',
      message_id: messageId,
      request_hash_pre: preHash,
      request_hash_post: sha256HexOfText(canonicalize(input as JsonValue)),
      mapped_external_id: fresh.external_id,
      status: 'continued',
      created_at: now,
    });
    // An ended call has nothing more to deliver.
    if (args.pushConfig !== undefined && !ended) addPushConfig(rt.a2a.store, fresh.id, args.pushConfig, now);
    recordInboundChange(rt, fresh.id);
    return rt.a2a.store.getTask(fresh.id);
  });
  if (continued === null) return answer(rpcError(id, 'unsupportedOperation', 'task_not_awaiting_input'));
  return { kind: 'continued', op: continued };
}

function childAwaiting(rt: InboundCore, op: A2ATaskRow): boolean {
  if (op.internal_id === null) return false;
  return rt.a2a.workflow.store().getById(op.internal_id)?.status === WorkflowTaskState.Awaiting;
}

/** The one data part an answer carries, or null: exactly one part, a JSON object, nothing else. */
function singleDataPart(parts: unknown): Record<string, unknown> | null {
  if (!Array.isArray(parts) || parts.length !== 1) return null;
  const part: unknown = parts[0];
  if (!isPlainObject(part) || !isPlainObject(part.data)) return null;
  if (part.text !== undefined || part.raw !== undefined || part.url !== undefined) return null;
  return part.data;
}
