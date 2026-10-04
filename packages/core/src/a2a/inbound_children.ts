/**
 * An inbound operation's children and its end (design §7.2–§7.3, §7.7):
 * minting the execution child for a round of a call (its first, or one
 * that continues it after the runner asked for input), with the permit an
 * effectful round's claim consumes; and ending the operation once.
 *
 * Shared by the call's acceptance and review (`inbound.ts`) and by its
 * continuation (`inbound_turns.ts`), so neither imports the other's
 * internals.
 */

import { canonicalize, type JsonValue } from '@dina/a2a';
import {
  LOCAL_RUNNER_NAME,
  SERVICE_PROFILE_COLLECTION,
  buildServiceQueryExecutionPayload,
  type ServiceExecutionContinuation,
} from '@dina/protocol';

import { getNodeDID } from '../pairing/ceremony';
import { createProviderIngressTask } from '../plugins/provider_ingress';
import { getPluginInstallRepository } from '../plugins/registry';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';

import { INBOUND_EFFECTFUL_CLASSES } from './action_registry';
import { recordInboundChange } from './delivery';
import { sha256HexOfText } from './digest';
import { A2A_TASK_NAMESPACE, newA2AId } from './ids';

import type { InboundCore, InboundSnapshot } from './inbound_view';
import type { IngressFailure } from './ingress_outcome';
import type { A2ATaskRow, InboundOperationState } from './store';

/** How long an execution child may wait for its runner. */
export const INBOUND_EXECUTION_DEADLINE_SECONDS = 10 * 60;
/** How long a review card waits for the owner. */
export const INBOUND_REVIEW_DEADLINE_SECONDS = 24 * 60 * 60;

export const inboundExecutionTaskId = (externalId: string, generation: number): string =>
  `${A2A_TASK_NAMESPACE}in-exec-${externalId}-g${generation}`;
export const inboundReviewTaskId = (externalId: string): string => `${A2A_TASK_NAMESPACE}in-review-${externalId}`;

/** A commit that cannot go on: the call is refused with this reason instead. */
export class InboundCommitRefused extends Error {
  constructor(readonly reason: IngressFailure) {
    super(reason);
  }
}

/**
 * The hash a round's permit binds to: what that round's runner executes.
 * The first round runs the normalized params alone (the snapshot's
 * post-hash); a continued round runs them with every answer so far, so its
 * hash covers both, and a payload changed after the permit was minted fails
 * the claim's check.
 */
export function inboundRoundHash(snapshot: InboundSnapshot, continuation: ServiceExecutionContinuation | undefined): string {
  if (continuation === undefined) return snapshot.post_hash;
  return sha256HexOfText(
    canonicalize({ post_hash: snapshot.post_hash, turns: continuation.turns } as unknown as JsonValue),
  );
}

/**
 * End an open operation once: its state and reason, any permit still
 * minted voided, and the change recorded for its streams and webhooks
 * (§7.5). Inside the caller's transaction. Returns the ended row, or null
 * when it was not open.
 */
export function endInboundOperation(
  rt: InboundCore,
  op: A2ATaskRow,
  patch: { state: InboundOperationState; reason_code?: string; result_json?: string; effect_phase?: string },
): A2ATaskRow | null {
  const now = rt.a2a.nowMs();
  if (op.direction !== 'inbound') return null;
  const changed = rt.a2a.store.updateTask(
    op.id,
    ['open'],
    {
      state: patch.state,
      reason_code: patch.reason_code ?? null,
      ...(patch.result_json === undefined ? {} : { result_json: patch.result_json }),
      ...(patch.effect_phase === undefined ? {} : { effect_phase: patch.effect_phase }),
    },
    now,
  );
  if (!changed) return null;
  for (const permit of rt.a2a.store.permitsOf(op.id)) {
    if (permit.state === 'minted') rt.a2a.store.voidPermit(permit.permit_id, `operation_${patch.state}`);
  }
  recordInboundChange(rt, op.id);
  return rt.a2a.store.getTask(op.id);
}

/**
 * The execution child for one round of an accepted call, on its frozen
 * executor's lane: round 0 runs the call; a later round (§7.7) runs it
 * again with `continuation`, every answer so far. For an effectful class,
 * the permit the child's claim consumes, bound to that round's payload and
 * minted only while no permit of an earlier round is live (an interruption
 * voided its round's permit; this checks anyway). Inside the commit; the
 * caller notes the new task or records the change (§7.5), since only it
 * knows which this is.
 */
export function mintExecutionChild(
  rt: InboundCore,
  op: A2ATaskRow,
  snapshot: InboundSnapshot,
  generation: number,
  continuation?: ServiceExecutionContinuation,
): string {
  const now = rt.a2a.nowMs();
  const nowSec = Math.floor(now / 1000);
  const snapshotForRunner = { params: snapshot.schemas.params, result: snapshot.schemas.result, schema_hash: snapshot.schema_hash };
  const executor = snapshot.executor;
  const effectful = INBOUND_EFFECTFUL_CLASSES.has(snapshot.action_class);
  if (effectful && rt.a2a.store.permitsOf(op.id).some((p) => p.state === 'minted' || p.state === 'consumed')) {
    // Unreachable: the interruption voided its round's permit in the same
    // commit that parked the round. If it is ever reached, the commit
    // rolls back rather than leave two rounds holding effect authority.
    throw new Error('a2a: a permit of an earlier round is still live');
  }
  let childId: string;
  // The one device the child may run on (§7.3): the bound runner of an
  // mcpServer lane, or the plugin's own paired device; none in process.
  let pep: string | null;
  if (executor.kind === 'plugin') {
    // A plugin's runner has no way to ask for input, so it has no later round.
    if (continuation !== undefined) throw new InboundCommitRefused('no_executor');
    pep = getPluginInstallRepository()?.getById(executor.installId)?.deviceDid ?? null;
    if (pep === null) throw new InboundCommitRefused('no_executor');
    const outcome = createProviderIngressTask({
      workflow: rt.a2a.workflow,
      capabilityConfig: {
        pluginInstallId: executor.installId,
        pluginManifestCid: executor.manifestCid,
        pluginCapabilityId: executor.capabilityId,
      },
      query: {
        fromDid: snapshot.principal,
        queryId: inboundExecutionTaskId(op.external_id, generation),
        capability: snapshot.configured_key,
        serviceRkey: snapshot.rkey,
        params: snapshot.params,
        ttlSeconds: INBOUND_EXECUTION_DEADLINE_SECONDS,
        serviceName: snapshot.service_name,
        schemaSnapshot: snapshotForRunner,
      },
      nowMs: now,
    });
    if (!outcome.ok || !('taskId' in outcome)) throw new InboundCommitRefused('no_executor');
    childId = outcome.taskId;
  } else {
    // The runner reads the listing from `service_uri` and takes the default
    // one when it is absent, as a D2D query that names none means (§7.3).
    // A call resolved to its listing at acceptance, so every round names
    // that listing; with no node DID to name it under, no round runs.
    const nodeDid = getNodeDID();
    if (nodeDid === null) throw new InboundCommitRefused('no_executor');
    childId = inboundExecutionTaskId(op.external_id, generation);
    pep = executor.kind === 'mcp_server' ? executor.pepDid : null;
    const payload = buildServiceQueryExecutionPayload({
      from_did: snapshot.principal,
      query_id: op.external_id,
      capability: snapshot.configured_key,
      params: snapshot.params,
      service_uri: `at://${nodeDid}/${SERVICE_PROFILE_COLLECTION}/${snapshot.rkey}`,
      ttl_seconds: INBOUND_EXECUTION_DEADLINE_SECONDS,
      service_name: snapshot.service_name,
      schema_snapshot: snapshotForRunner,
      ...(executor.kind === 'mcp_server' ? { mcp_tool: executor.mcpTool } : {}),
      ...(snapshot.response_policy === 'review' ? { operator_approved: true } : {}),
      ...(continuation === undefined ? {} : { continuation }),
      // Only a round whose claim crosses no effect boundary can ask (§7.7);
      // an in-process capability that defers its boundary knows it can.
      ...(effectful ? {} : { may_ask: true }),
    });
    rt.a2a.workflow.create({
      id: childId,
      kind: WorkflowTaskKind.Delegation,
      description: `A2A call: ${snapshot.skill}`,
      payload: JSON.stringify(payload),
      origin: 'api',
      correlationId: op.external_id,
      requestedRunner: executor.kind === 'mcp_server' ? executor.lane : LOCAL_RUNNER_NAME,
      expiresAtSec: nowSec + INBOUND_EXECUTION_DEADLINE_SECONDS,
      initialState: WorkflowTaskState.Queued,
    });
  }
  rt.a2a.store.insertChild({ child_task_id: childId, operation_ref: op.id, generation, role: 'execution', created_at: now, pep_did: pep });
  rt.a2a.store.updateTask(op.id, ['open'], { internal_id: childId }, now);
  if (effectful) {
    rt.a2a.store.insertPermit({
      permit_id: newA2AId(),
      direction: 'inbound',
      operation_ref: op.id,
      execution_child_id: childId,
      // A later round runs under the same approval as the first (§7.7).
      approval_task_id: snapshot.response_policy === 'review' ? inboundReviewTaskId(op.external_id) : null,
      payload_hash: inboundRoundHash(snapshot, continuation),
      action_class: snapshot.action_class,
      pep_did: pep,
      authority_snapshot_json: JSON.stringify(snapshot),
      state: 'minted',
      void_reason: null,
      expires_at: now + INBOUND_EXECUTION_DEADLINE_SECONDS * 1000,
      created_at: now,
      consumed_at: null,
    });
    rt.a2a.store.updateTask(op.id, ['open'], { effect_phase: 'pre_effect' }, now);
  }
  return childId;
}
