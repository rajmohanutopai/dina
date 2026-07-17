/**
 * Workflow task + event routes.
 *
 *   POST /v1/workflow/tasks               — create (idempotent)
 *   GET  /v1/workflow/tasks/:id           — read a single task
 *   GET  /v1/workflow/tasks                — list by kind/state
 *   POST /v1/workflow/tasks/:id/approve   — pending_approval → queued
 *   POST /v1/workflow/tasks/claim         — agent-pull claim
 *   POST /v1/workflow/tasks/:id/heartbeat — extend agent lease
 *   POST /v1/workflow/tasks/:id/progress  — update progress_note
 *   POST /v1/workflow/tasks/:id/cancel    — cancel
 *   POST /v1/workflow/tasks/:id/complete  — complete
 *   POST /v1/workflow/tasks/:id/fail      — fail
 *   GET  /v1/workflow/events              — undelivered events list
 *   POST /v1/workflow/events/:id/ack      — ack + retire from queue
 */

import { LOCAL_RUNNER_NAME, isPluginLane } from '@dina/protocol';

import {
  activateAgentPersonaGrant,
  isAgentPersonaAccessApproval,
  reserveAgentPersonaGrant,
} from '../../agent/access';
import { getAgentGrantRepository } from '../../agent/grant_repository';
import { claimPluginTask } from '../../plugins/claim_guard';
import { validatePluginResult } from '../../plugins/dispatch';
import { getPluginInstallRepository } from '../../plugins/registry';
import {
  STAGING_PERSONA_ACCESS_APPROVAL_TYPE,
  denyApproval,
  drainForApproval,
} from '../../staging/service';
import {
  WorkflowTaskKind,
  WorkflowTaskState,
  isTerminal,
  type WorkflowTask,
} from '../../workflow/domain';
import {
  PLUGIN_INVOCATION_PAYLOAD_TYPE,
  isDeclaredEffectful,
  parsePluginEnvelope,
} from '../../workflow/plugin_envelope';
import {
  WorkflowConflictError,
  WorkflowTransitionError,
  WorkflowValidationError,
  getWorkflowService,
} from '../../workflow/service';

import { grantSessionApproval, grantVaultReadSessionApproval } from './intent';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

/**
 * Lift `payload.type` to a top-level `payload_type` wire field. Go-Core
 * persists this as an indexed column; the Python daemon's
 * `build_task_prompt` reads `task.payload_type` to decide whether to
 * inject structured capability/params into the LLM prompt. Without this
 * field the daemon falls back to the abstract description and the
 * LLM never sees the params or the bound MCP tool.
 *
 * Derived at read time so we don't need a schema migration.
 */
function withPayloadType(task: WorkflowTask): Record<string, unknown> {
  const out = task as unknown as Record<string, unknown>;
  if (typeof out.payload_type === 'string' && out.payload_type !== '') return out;
  let payloadType = '';
  if (typeof task.payload === 'string' && task.payload !== '') {
    try {
      const parsed = JSON.parse(task.payload) as { type?: unknown };
      if (typeof parsed.type === 'string') payloadType = parsed.type;
    } catch {
      // Non-JSON payloads (rare, kind-specific) — leave empty.
    }
  }
  return { ...out, payload_type: payloadType };
}

/**
 * Round-11 #8: does this task's payload DECLARE the plugin-invocation type? Used
 * to key result validation on the TASK, not the completing caller — a plugin
 * task always carries this type (even a subsequently-corrupt envelope), while a
 * plain delegation does not. Cheap JSON type-field probe.
 */
function payloadDeclaresPluginType(payload: unknown): boolean {
  if (typeof payload !== 'string' || payload === '') return false;
  try {
    return (JSON.parse(payload) as { type?: unknown }).type === PLUGIN_INVOCATION_PAYLOAD_TYPE;
  } catch {
    return false;
  }
}

export function registerWorkflowRoutes(router: CoreRouter): void {
  router.post('/v1/workflow/tasks', createTask);
  router.get('/v1/workflow/tasks/:id', getTask);
  router.get('/v1/workflow/tasks', listTasks);
  router.post('/v1/workflow/tasks/claim', claimTask);
  router.post('/v1/workflow/tasks/:id/heartbeat', heartbeatTask);
  router.post('/v1/workflow/tasks/:id/progress', progressTask);
  // dina-agent calls /running after claim to confirm task ownership;
  // TS Core's claim already transitions to running, so this is an
  // idempotent no-op that just echoes the current task.
  router.post('/v1/workflow/tasks/:id/running', async (req: CoreRequest): Promise<CoreResponse> => {
    const service = getWorkflowService();
    if (service === null) return j(503, { error: 'workflow service not wired' });
    const id = req.params.id ?? '';
    if (id === '') return j(400, { error: 'id required' });
    const task = service.store().getById(id);
    if (task === null) return j(404, { error: 'task not found' });
    const denied = agentReadGuard(req, task); // round-10 #2: own-task-only for agents
    if (denied !== null) return denied;
    return j(200, withPayloadType(task));
  });
  router.post('/v1/workflow/tasks/:id/approve', async (req) => {
    const guard = ownerDecisionGuard(req);
    return guard ?? runAction(req, approveTask);
  });
  router.post('/v1/workflow/tasks/:id/cancel', async (req) => {
    const guard = ownerDecisionGuard(req);
    return guard ?? runAction(req, cancelTask);
  });
  router.post('/v1/workflow/tasks/:id/complete', async (req) => {
    const guard = agentCompletionGuard(req);
    const claimId = extractClaimId(req);
    if (claimId instanceof Object) return claimId;
    return (
      guard ??
      runAction(req, (id, body, s, ctx) => {
        const result = strField(body?.result);
        const agentDID = completingAgentDID(body, ctx);
        if (result === '') {
          throw new WorkflowValidationError('result is required', 'result');
        }
        // §9.1: a PLUGIN completion is validated against the PINNED result
        // schema (the envelope snapshot, not the current manifest). Nonconforming
        // = task FAILURE — never applied as a result; a runner cannot widen its
        // own output past what the owner consented to. The pinned-schema check
        // fires when EITHER (round-10 #21) the CALLER is a plugin — so a plugin
        // runner completing a task with a corrupt/absent envelope fails closed —
        // OR (round-11 #8) the TASK's payload declares the plugin-invocation type
        // — so a brain/admin/device completer of a plugin task can't bypass the
        // pinned schema. The union covers both the malformed-payload and the
        // wrong-completer holes.
        const completeTask = s.store().getById(id);
        const mustValidatePinned =
          ctx.callerType === 'plugin' ||
          (completeTask !== null && payloadDeclaresPluginType(completeTask.payload)) ||
          // Round-14 #2: a task on a plugin LANE (`plugin:<install_id>`) is a
          // plugin invocation even if the completing caller isn't typed 'plugin'
          // and the payload's type field was stripped/corrupted. The lane is
          // routing authority — fail closed to the pinned-envelope path so the
          // result can't slip through unvalidated on a technicality.
          (completeTask !== null && isPluginLane(completeTask.requested_runner ?? ''));
        if (mustValidatePinned) {
          const envelope = completeTask === null ? null : parsePluginEnvelope(completeTask.payload);
          // A plugin task/caller with NO parseable pinned envelope is an
          // integrity error — fail closed (terminalize) rather than allow an
          // unvalidated result through, whatever the caller.
          if (envelope === null) {
            return s.fail(id, 'plugin envelope missing or unparseable', agentDID, claimId);
          }
          const check = validatePluginResult(result, envelope.schema_snapshot);
          if (!check.ok) {
            const msg = `result rejected: ${check.error ?? 'schema mismatch'}`;
            // Round-12 #5: an EFFECTFUL runner (booking/payment/write/agentic)
            // may have performed the side effect and THEN returned a malformed /
            // nonconforming result. Recording plain `failed` would imply nothing
            // happened; park it as `outcome_unknown` (the effect MAY have moved
            // money/made a booking) and retain the rejected result as
            // reconciliation evidence. Non-effectful → plain `failed`.
            if (isDeclaredEffectful(envelope)) {
              return s.failEffectfulUnknown(id, msg, result, agentDID, claimId);
            }
            return s.fail(id, msg, agentDID, claimId);
          }
        }
        // Go-Core parity: `result_summary` is the human-readable display
        // line on the admin/diagnostics surface; `result` is the
        // structured payload (JSON for service-query bridging). The
        // Python `dina-agent` MCP `dina_task_complete(task_id, result)`
        // only sends `result` — Go-Core derives the summary from the
        // first ~200 chars when omitted. Match that behaviour so paired
        // OpenClaw runs don't 400 on every completion. Callers that
        // pass an explicit `result_summary` are honoured verbatim.
        // Round-9 #22: cap + single-line the runner-supplied summary (owner-
        // facing, decoupled from the validated result). The derived fallback is
        // sanitized too — a bounded, clean display line either way.
        const explicitSummary = sanitizeStatusText(body?.result_summary);
        const summary = explicitSummary !== '' ? explicitSummary : sanitizeStatusText(result, 200);
        return s.complete(id, result, summary, agentDID, claimId);
      })
    );
  });
  router.post('/v1/workflow/tasks/:id/fail', async (req) => {
    const guard = agentCompletionGuard(req);
    const claimId = extractClaimId(req);
    if (claimId instanceof Object) return claimId;
    return (
      guard ??
      runAction(req, (id, body, s, ctx) => {
        const errMsg = sanitizeStatusText(body?.error); // round-9 #22: owner-facing, bounded
        const agentDID = completingAgentDID(body, ctx);
        if (errMsg === '') throw new WorkflowValidationError('error is required', 'error');
        const before = s.store().getById(id);
        if (
          isStagingPersonaAccessApproval(before) &&
          before?.status === WorkflowTaskState.PendingApproval
        ) {
          denyApproval(id, errMsg);
        }
        // Round-13 #6: a runner that /fails an EFFECTFUL plugin task
        // (booking/payment/write/agentic) may have performed the side effect and
        // THEN errored — recording plain `failed` asserts nothing happened when
        // money may have moved. Park as `outcome_unknown` (§9.5: execution
        // started, outcome uncertain), retaining the error as evidence. Mirrors
        // the effect-aware `/complete` branch. Non-effectful (or non-plugin) →
        // plain `failed`.
        // Round-14 #2: treat a task on a plugin LANE as a plugin task here too,
        // so a stripped/corrupt `type` field can't downgrade an effectful
        // failure to plain `failed` on a technicality (the lane is authority).
        if (
          before !== null &&
          (payloadDeclaresPluginType(before.payload) || isPluginLane(before.requested_runner ?? ''))
        ) {
          const envelope = parsePluginEnvelope(before.payload);
          if (envelope !== null && isDeclaredEffectful(envelope)) {
            return s.failEffectfulUnknown(
              id,
              `runner reported failure: ${errMsg}`,
              errMsg,
              agentDID,
              claimId,
            );
          }
        }
        return s.fail(id, errMsg, agentDID, claimId);
      })
    );
  });
  router.get('/v1/workflow/events', listEvents);
  router.post('/v1/workflow/events/:id/ack', ackEvent);
  router.post('/v1/workflow/events/:id/fail', failEvent);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  if (req.body === undefined) return j(400, { error: 'empty body' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return j(400, { error: 'body must be a JSON object' });
  }
  const body = req.body as Record<string, unknown>;
  const input = {
    id: strField(body.id),
    kind: strField(body.kind),
    description: strField(body.description),
    payload: strField(body.payload, ''),
    expiresAtSec: numField(body.expires_at),
    correlationId: optStrField(body.correlation_id),
    parentId: optStrField(body.parent_id),
    proposalId: optStrField(body.proposal_id),
    priority: optStrField(body.priority),
    origin: optStrField(body.origin),
    sessionName: optStrField(body.session_name),
    idempotencyKey: optStrField(body.idempotency_key),
    policy: optStrField(body.policy),
    initialState: optStrField(body.initial_state) as WorkflowTaskState | undefined,
    requestedRunner: optStrField(body.requested_runner),
  };
  try {
    const task = service.create(input);
    return j(201, { task: withPayloadType(task) });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      return j(400, { error: err.message, field: err.field });
    }
    if (err instanceof WorkflowConflictError) {
      if (
        err.code === 'duplicate_idempotency' &&
        input.idempotencyKey !== undefined &&
        input.idempotencyKey !== ''
      ) {
        const existing = service.store().getActiveByIdempotencyKey(input.idempotencyKey);
        if (existing !== null) return j(200, { task: withPayloadType(existing), deduped: true });
      }
      return j(409, { error: err.message, code: err.code });
    }
    return j(500, { error: (err as Error).message });
  }
}

async function getTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = req.params.id ?? '';
  if (id === '') return j(400, { error: 'id required' });
  const task = service.store().getById(id);
  if (task === null) return j(404, { error: 'task not found' });
  const denied = agentReadGuard(req, task);
  if (denied !== null) return denied;
  return j(200, { task: withPayloadType(task) });
}

async function listTasks(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const kind = req.query.kind ?? '';
  const stateRaw = req.query.state ?? '';
  if (kind === '' || stateRaw === '') {
    return j(400, { error: 'kind and state query parameters are required' });
  }
  const requested = Number(req.query.limit ?? 100);
  const limit = clampLimit(requested);
  const tasks = service.store().listByKindAndState(kind, stateRaw as WorkflowTaskState, limit);
  return j(200, { tasks: tasks.map(withPayloadType), count: tasks.length });
}

async function claimTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const agentDID = req.headers['x-did'] ?? '';
  if (agentDID === '') return j(400, { error: 'X-DID header is required' });
  const leaseMs = extractLeaseMs(req.body);
  // `runner_filter` (the daemon's registered runner) routes tasks on a
  // multi-runner provider: a filtered claim only takes tasks whose
  // `requested_runner` matches (or is unset). Empty filter ⇒ claim anything.
  const runnerFilter = extractRunnerFilter(req.body);
  // The reserved 'dina.local' lane is IN-PROCESS ONLY (Tier 1 prompt-
  // provider executions — the node's own LocalDelegationRunner claims it
  // directly through the repository, never over HTTP). An external agent
  // naming the lane would hijack tasks meant to run on the provider's
  // own Dina and forge their results. Hard-reject, don't coerce.
  if (runnerFilter === LOCAL_RUNNER_NAME) {
    return j(403, {
      error: `runner_filter "${LOCAL_RUNNER_NAME}" is reserved for in-process execution`,
    });
  }
  // PLUGIN-LANE HIJACK GUARD (PLUGIN_ARCHITECTURE.md §9.1). A plugin lane
  // is served ONLY by its own paired instance, via the plugin branch
  // below, which forces the lane from the install and runs the six
  // claim-time checks + result-schema validation + claim-token
  // discipline. A NON-plugin caller (e.g. a generic paired agent) that
  // names `plugin:<install_id>` as runner_filter must NEVER reach the
  // generic claim path — there, an exact-match plugin filter would let
  // it claim the task, read the pinned envelope (params + scrubbed
  // context), and forge a completion with NONE of those gates. Reject
  // it outright. (Plugin callers branch out before this matters; their
  // filter is ignored anyway.)
  if (req.callerType !== 'plugin' && isPluginLane(runnerFilter)) {
    return j(403, {
      error: 'access_denied',
      reason: 'plugin lanes are served only by their paired plugin instance',
    });
  }
  // Plugin callers (PLUGIN_ARCHITECTURE.md §9.1): the server ignores the
  // client-sent runner_filter ENTIRELY and forces exact-match on the lane
  // registered to this instance's install; the six claim-time checks run
  // server-side and stale-authority tasks terminalize instead of
  // starving the lane. A malicious runner is assumed to speak raw RPC.
  if (req.callerType === 'plugin') {
    const installs = getPluginInstallRepository();
    if (installs === null) return j(503, { error: 'plugin registry not wired' });
    const install = installs.getByDeviceDid(agentDID);
    if (install === null) {
      return j(403, { error: 'access_denied', reason: 'no plugin install bound to this device' });
    }
    const result = claimPluginTask({
      repo: service.store(),
      install,
      deviceDid: agentDID,
      nowMs: Date.now(),
      leaseMs,
    });
    if (result.task === null) return j(204, undefined);
    return j(200, withPayloadType(result.task));
  }
  const task = service.store().claimDelegationTask(agentDID, Date.now(), leaseMs, runnerFilter);
  if (task === null) return j(204, undefined);
  // dina-agent (Python) reads `body.id` / `body.payload` directly off
  // the response body — no `task` envelope. Match Go-Core's wire shape
  // so the daemon's URL formation (e.g. POST /v1/workflow/tasks/{id}/...)
  // doesn't end up with an empty id and produce `tasks//running`.
  // `withPayloadType` lifts `payload.type` to top-level `payload_type`
  // (Go-Core parity) so the daemon's `build_task_prompt` augments the
  // LLM prompt with structured capability/params instead of falling
  // back to the abstract description.
  return j(200, withPayloadType(task));
}

async function heartbeatTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = req.params.id ?? '';
  if (id === '') return j(400, { error: 'id required' });
  const agentDID = req.headers['x-did'] ?? '';
  if (agentDID === '') return j(400, { error: 'X-DID header is required' });
  const leaseMs = extractLeaseMs(req.body);
  const claimId = extractClaimId(req);
  if (claimId instanceof Object) return claimId; // 400 — plugin without claim_id
  const ok = service.store().heartbeatTask(id, agentDID, Date.now(), leaseMs, claimId);
  if (!ok) {
    const task = service.store().getById(id);
    if (task === null) return j(404, { error: 'task not found' });
    return j(409, {
      error: 'heartbeat denied: task is not running or held by a different agent',
    });
  }
  return j(200, { ok: true });
}

async function progressTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = req.params.id ?? '';
  if (id === '') return j(400, { error: 'id required' });
  const agentDID = req.headers['x-did'] ?? '';
  if (agentDID === '') return j(400, { error: 'X-DID header is required' });
  const body = (req.body as Record<string, unknown> | undefined) ?? {};
  const message = sanitizeStatusText(body.message); // round-9 #22: owner-facing, bounded + single-line
  if (message === '') return j(400, { error: 'message is required' });
  const claimId = extractClaimId(req);
  if (claimId instanceof Object) return claimId;
  const ok = service.store().updateTaskProgress(id, agentDID, message, Date.now(), claimId);
  if (!ok) {
    const task = service.store().getById(id);
    if (task === null) return j(404, { error: 'task not found' });
    return j(409, {
      error: 'progress denied: task is not running or held by a different agent',
    });
  }
  return j(200, { ok: true });
}

async function listEvents(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const repo = service.store();
  const since = parseUnsignedNumber(req.query.since, 0);
  const limit = clampLimit(parseUnsignedNumber(req.query.limit, 100));
  // Query-string filter: `needs_delivery=true` → delivery scheduler
  // hot path (undelivered + due only); any other value → full
  // audit/diagnostics stream.
  //
  // Review #5: previously this passed `Number.MAX_SAFE_INTEGER` as
  // nowMs which disabled the `next_delivery_at` backoff filter
  // entirely — every not-yet-due event was surfaced immediately and
  // the consumer's retry backoff was never honoured.
  //
  // Review #7: the `since` filter was applied AFTER the repository
  // limit, so when the batch exceeded `limit`, recent events could
  // be hidden behind older undelivered ones. Pushed into the repo so
  // `since` is applied BEFORE the limit.
  const needsDeliveryOnly = req.query.needs_delivery === 'true';
  const nowMs = Date.now();
  const events = needsDeliveryOnly
    ? repo.listUndeliveredEvents(nowMs, since, limit)
    : repo.listAllEventsSince(since, limit);
  return j(200, { events, count: events.length });
}

/**
 * POST /v1/workflow/events/:id/fail — consumer negative-ack. The
 * delivery scheduler pushes `next_delivery_at` out so subsequent
 * `needs_delivery=true` queries honour backoff instead of spinning
 * on the same failing event.
 *
 * Body: `{ error?: string, next_delivery_at?: number }`. If
 * `next_delivery_at` is omitted we default to `now + 30s` — a
 * reasonable floor that still lets Core's own retry cadence win when
 * it's shorter (review #6).
 */
async function failEvent(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = Number.parseInt(req.params.id ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    return j(400, { error: 'event id must be a positive integer' });
  }
  const body = (req.body as Record<string, unknown> | undefined) ?? {};
  const nowMs = Date.now();
  const nextAtRaw = body.next_delivery_at;
  const nextAt =
    typeof nextAtRaw === 'number' && Number.isFinite(nextAtRaw) && nextAtRaw > nowMs
      ? nextAtRaw
      : nowMs + 30_000;
  const repo = service.store();
  const ok = repo.markEventDeliveryFailed(id, nextAt, nowMs);
  if (!ok) return j(404, { error: 'event not found' });
  return j(200, { ok: true, next_delivery_at: nextAt });
}

async function ackEvent(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = Number.parseInt(req.params.id ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    return j(400, { error: 'event id must be a positive integer' });
  }
  const nowMs = Date.now();
  const repo = service.store();
  const ok = repo.markEventAcknowledged(id, nowMs);
  if (!ok) return j(404, { error: 'event not found' });
  repo.markEventDelivered(id, nowMs);
  return j(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Shared driver for simple task-action endpoints (approve/cancel/complete/fail)
// ---------------------------------------------------------------------------

/** Caller identity resolved by the auth pipeline (router.ts), never the body. */
interface ActionCtx {
  callerType?: string;
  callerDID?: string;
}

type TaskAction = (
  id: string,
  body: Record<string, unknown> | null,
  service: NonNullable<ReturnType<typeof getWorkflowService>>,
  ctx: ActionCtx,
) => unknown;

/**
 * The DID recorded as the actor on a complete/fail. For an `agent` caller it
 * is ALWAYS the authenticated `callerDID` — never `body.agent_did`, which a
 * compromised/malicious agent could forge to misattribute the outcome. Owner/
 * system callers (admin/brain/device) may still pass `agent_did` on behalf of
 * a runner (e.g. the chat orchestrator recording a completion).
 */
function completingAgentDID(body: Record<string, unknown> | null, ctx: ActionCtx): string {
  if (ctx.callerType === 'agent' || ctx.callerType === 'plugin') return ctx.callerDID ?? '';
  return strField(body?.agent_did);
}

/**
 * Ownership gate for agent-driven complete/fail (P1.1). An out-of-process
 * `agent` may only complete/fail a `delegation` task it is CURRENTLY holding —
 * i.e. one it claimed (status `running`, `agent_did` === its authenticated
 * DID). Without this an agent could complete/fail (or force-terminate) ANY
 * non-terminal task by id, with a forged `agent_did`, since the repo only
 * guards on state, not ownership. Owner/system callers (admin/brain/device,
 * and the internal service-query bridge which bypasses this route) are not
 * gated here. `callerType`/`callerDID` come from the verified auth result
 * (router.ts), not the body. Returns a 403/404 response to short-circuit, or
 * `null` to proceed.
 */
function agentCompletionGuard(req: CoreRequest): CoreResponse | null {
  if (req.callerType !== 'agent' && req.callerType !== 'plugin') return null;
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = req.params.id ?? '';
  if (id === '') return j(400, { error: 'id required' });
  const task = service.store().getById(id);
  if (task === null) return j(404, { error: 'task not found' });
  const callerDID = req.callerDID ?? '';
  if (
    callerDID === '' ||
    task.kind !== WorkflowTaskKind.Delegation ||
    task.status !== WorkflowTaskState.Running ||
    (task.agent_did ?? '') !== callerDID
  ) {
    return j(403, {
      error: 'access_denied',
      reason: `${req.callerType} may only complete/fail a running delegation task it currently holds`,
    });
  }
  return null;
}

/**
 * Round-10 #2: reads (`GET /tasks/:id`, `POST /:id/running`) carry no ownership
 * check, so a paired agent could fetch a task it doesn't own by id (payloads
 * carry params + projected context). Owner surfaces (admin / brain / device)
 * see everything; an `agent`/`plugin` caller may only read a delegation task it
 * currently owns (`agent_did === callerDID`). Returns a 403 response to deny, or
 * null to allow. (List is already brain/admin-only via the authz allowlist.)
 */
function agentReadGuard(req: CoreRequest, task: WorkflowTask): CoreResponse | null {
  if (req.callerType !== 'agent' && req.callerType !== 'plugin') return null;
  const callerDID = req.callerDID ?? '';
  if (
    callerDID === '' ||
    task.kind !== WorkflowTaskKind.Delegation ||
    (task.agent_did ?? '') !== callerDID ||
    // Round-14 #10: an agent reads its task while it's in flight (queued →
    // running → pending_approval). Once the task is TERMINAL the runner has no
    // live business re-fetching its projected params/context — the completion
    // guard already requires `running`, so keep the read guard consistent and
    // deny terminal reads. (A Running-only gate would over-tighten and break
    // the legitimate pending_approval read; terminal-only is the safe bound.)
    isTerminal(task.status as WorkflowTaskState)
  ) {
    return j(403, {
      error: 'access_denied',
      reason: `${req.callerType} may only read a non-terminal delegation task it owns`,
    });
  }
  return null;
}

async function approveTask(
  id: string,
  body: Record<string, unknown> | null,
  service: NonNullable<ReturnType<typeof getWorkflowService>>,
): Promise<WorkflowTask> {
  const before = service.store().getById(id);

  // Session-scoped approval: if the caller passes scope='session' the
  // approve grants a session-keyed approval so the same agent's SAME
  // `dina session` auto-passes subsequent calls for that action/persona.
  //   - intent_validation: keyed on `(agent_did, session, action)`
  //   - vault_read_request: keyed on `(agent_did, session, persona)`
  // Round-15 #1: this grant is written ONLY AFTER `service.approve(id)` succeeds
  // — approve throws (→ 409) on a stale/cancelled/expired/already-handled task,
  // so a leaked session grant can no longer silently reverse a denial. The
  // session id rides in the task payload (see `intent.ts` / `persona_guard.ts`).
  const writeSessionGrant = (): void => {
    if (body?.scope !== 'session' || before === null) return;
    const payload = safeParseBody(before.payload);
    const sessionId = typeof payload?.session === 'string' ? payload.session : '';
    const agentDid =
      typeof payload?.agent_did === 'string'
        ? payload.agent_did
        : typeof payload?.requester_did === 'string'
          ? payload.requester_did
          : '';
    if (payload?.type === 'intent_validation' && typeof payload.action === 'string') {
      grantSessionApproval(agentDid, sessionId, payload.action);
    } else if (payload?.type === 'vault_read_request' && typeof payload.persona === 'string') {
      grantVaultReadSessionApproval(agentDid, sessionId, payload.persona);
    }
  };

  // issues.txt §2 — approving an agent persona-access request writes the
  // durable grant so the out-of-process agent's retry (even after an app
  // restart) passes the deterministic gate. No local runner to claim it;
  // the grant row IS the outcome.
  if (
    isAgentPersonaAccessApproval(before) &&
    before !== null &&
    before.status === WorkflowTaskState.PendingApproval
  ) {
    // Round-16 #1 + PLG-28 #1: RESERVE the durable grant before the transition,
    // ACTIVATE it after. Reserving first (a) proves the grant repo works — a
    // missing/failing repo returns null here while the task is still
    // pending_approval, so the approve fails CLOSED (never a queued task with no
    // authority the owner can't re-approve), and (b) leaves the grant INVISIBLE
    // to `findActiveGrant` (reserved), so an agent retry can't use it before the
    // approval CAS commits. Reserve is SYNCHRONOUS (no awaited unlock between it
    // and the CAS), so the reserve→approve span carries no event-loop yield to
    // race. Only after approve succeeds do we activate + unlock (phase 2).
    const grant = reserveAgentPersonaGrant(before, Date.now());
    if (grant === null) {
      throw new WorkflowValidationError(
        'agent persona-access grant could not be created (grant repository unavailable)',
        'grant',
      );
    }
    // PLG-27 #1: the reserved grant must be compensated if `service.approve`
    // FAILS to transition (a concurrent /cancel won the CAS, or the write threw)
    // — a reserved grant left behind is harmless (never gate-visible) but we
    // revoke it anyway to keep the audit clean and never leave dangling authority.
    let approved: WorkflowTask;
    try {
      approved = service.approve(id);
    } catch (err) {
      getAgentGrantRepository()?.revoke(grant.id, Date.now());
      throw err;
    }
    // Phase 2: the task is now durably approved — await the persona unlock, then
    // flip the reserved grant ACTIVE so `findActiveGrant` (and the agent's retry)
    // can finally see it. Ordered AFTER the CAS so authority never precedes it.
    // PLG-29 #5: CHECK activate()'s result. If the reserved grant could NOT be
    // activated (revoked concurrently — e.g. the agent's device was revoked
    // mid-approval), don't leave an approved task pointing at a dead grant with no
    // recovery: revoke the (already-gone) grant, CANCEL the task so its
    // idempotency key frees, and surface an error so the owner re-prompts on the
    // agent's next request. (The pure process-crash-between-approve-and-unlock
    // window remains a boot-reconciler follow-up — see implementation-notes.)
    // PLG-32 #4: activate() can THROW (SQLITE_BUSY, I/O error, closed DB), not
    // just return false. The `!activated` branch below compensates a false, but an
    // uncaught throw here escapes AFTER the committed approval with NO
    // compensation — leaving the task in `queued` (non-terminal) with an inactive
    // reservation that future agent requests dedupe onto FOREVER (the owner can't
    // re-approve a non-pending task). Apply the same revoke+cancel compensation
    // to the throw path so the idempotency key frees for a fresh card.
    let activated: boolean;
    try {
      activated = await activateAgentPersonaGrant(grant, Date.now());
    } catch (err) {
      getAgentGrantRepository()?.revoke(grant.id, Date.now());
      service.cancel(id, 'grant activation error after approval');
      throw err;
    }
    if (!activated) {
      getAgentGrantRepository()?.revoke(grant.id, Date.now());
      service.cancel(id, 'grant activation failed after approval');
      throw new WorkflowValidationError(
        'agent persona-access grant could not be activated after approval — re-request access',
        'grant',
      );
    }
    writeSessionGrant();
    return approved;
  }

  if (
    !isStagingPersonaAccessApproval(before) ||
    before?.status !== WorkflowTaskState.PendingApproval
  ) {
    const approved = service.approve(id); // throws → no grant written (fix #1)
    writeSessionGrant();
    return approved;
  }

  // Round-15 #2: win the transition AND the single-executor CAS BEFORE draining
  // staged data into the protected persona vault. Draining first wrote vault
  // rows that a lost transition/CAS could never undo (a persona-wall breach on a
  // stale/denied approval). Order is now approve → claim → drain → complete.
  const approved = service.approve(id);
  const claimed = service.store().claimApprovalForExecution(id, 1, Math.floor(Date.now() / 1000));
  if (!claimed) return approved; // lost the CAS — nothing was written
  // PLG-32 #5: a vault/repository failure inside drainForApproval used to escape
  // with the task stranded in 'running' (non-terminal, NOT re-approvable) and the
  // staged rows silently orphaned (drainForPersona skips approval_id rows). Catch
  // it: dead-letter the staged rows and FAIL the task so the outcome is surfaced
  // rather than leaving a permanent 'running' zombie the owner can't recover.
  let resume;
  try {
    resume = drainForApproval(id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    denyApproval(id, `drain failed after approval: ${reason}`);
    service.fail(id, `staging drain failed after approval: ${reason}`);
    throw err;
  }
  // PLG-32 #9: matched===0 means NOTHING was behind this approval — the staged
  // rows were TTL-swept, quarantined as corrupt, or orphaned (an unpersisted #8
  // secondary copy). Reporting `status:'stored'` would tell the owner a
  // nonexistent write succeeded. Fail the task so the surface reflects that the
  // approved store did not complete, instead of a false success.
  if (resume.matched === 0) {
    return service.fail(id, 'no staged memory found to store (already removed or expired)');
  }
  return service.complete(
    id,
    JSON.stringify({
      status: 'stored',
      drained: resume.drained,
      already_stored: resume.alreadyStored,
    }),
    resume.drained > 0 ? 'staging memory stored' : 'staging memory already stored',
    'system',
  );
}

function safeParseBody(raw: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(raw);
    return p !== null && typeof p === 'object' && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cancelTask(
  id: string,
  body: Record<string, unknown> | null,
  service: NonNullable<ReturnType<typeof getWorkflowService>>,
): WorkflowTask {
  const reason = strField(body?.reason, 'approval_denied');
  const before = service.store().getById(id);
  const isStagingApproval =
    isStagingPersonaAccessApproval(before) && before?.status === WorkflowTaskState.PendingApproval;
  // PLG-30 #7: WIN the state transition BEFORE dead-lettering the staged data.
  // `denyApproval` forces the pending_unlock staging rows to `failed` with
  // retry_count past the sweep ceiling — irreversible. If it ran first and
  // `service.cancel` then threw (a concurrent transition / storage failure), the
  // staged data would be permanently unstorable while the task stayed active.
  // Cancel first; deny only once the cancellation has committed. Mirrors the
  // approve path's transition-first ordering (Round-15 #2).
  const cancelled = service.cancel(id, reason);
  if (isStagingApproval) {
    denyApproval(id, reason);
  }
  return cancelled;
}

/**
 * Claim-token extraction (§9.1). PLUGIN callers MUST present the
 * claim_id minted at claim — the CAS discipline is what makes a stale
 * execution's report evidence instead of a result. Other callers may
 * present one (then it is honored) but are not required to — legacy
 * agents predate tokens.
 *
 * Returns the claimId (string | undefined) or a 400 CoreResponse when a
 * plugin caller omitted it.
 */
function extractClaimId(req: CoreRequest): string | undefined | CoreResponse {
  const body = (req.body as Record<string, unknown> | undefined) ?? {};
  const raw = body.claim_id;
  const claimId = typeof raw === 'string' && raw !== '' ? raw : undefined;
  if (req.callerType === 'plugin' && claimId === undefined) {
    return j(400, {
      error: 'claim_id is required',
      reason: 'plugin callers must present the claim token minted at claim (§9.1)',
    });
  }
  return claimId;
}

/**
 * Approving or denying a workflow task is an OWNER decision. Approval can
 * write a durable agent persona-access grant AND unlock the persona
 * (`agent_persona_access`), and it clears a flagged Agent-Gateway intent
 * proposal (`intent_validation`) — so an out-of-process `agent` caller must
 * never reach it, or it could self-approve its own access request and bypass
 * both the persona gate and the Agent Gateway (it receives its own task_id
 * in the 403 it gets from `agentGate`). Agents legitimately use only
 * claim/heartbeat/progress/running/complete/fail on the same
 * `/v1/workflow/tasks/` sub-tree; the coarse authz prefix (authz.ts) can't
 * express the `/approve` + `/cancel` suffixes, so the decision is enforced
 * here. `callerType` is set from the verified auth result (router.ts), never
 * the request body, so it can't be spoofed. `brain` (the user-driven
 * `/service_approve` chat command) and `device`/`admin` (the app approval UI)
 * remain authorised. Fail closed.
 */
function ownerDecisionGuard(req: CoreRequest): CoreResponse | null {
  if (req.callerType === 'agent' || req.callerType === 'plugin') {
    return j(403, {
      error: 'access_denied',
      reason: `${req.callerType} callers cannot approve or deny tasks`,
    });
  }
  return null;
}

async function runAction(req: CoreRequest, action: TaskAction): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const id = req.params.id ?? '';
  if (id === '') return j(400, { error: 'id required' });
  let body: Record<string, unknown> | null = null;
  if (req.body !== undefined) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return j(400, { error: 'body must be a JSON object' });
    }
    body = req.body as Record<string, unknown>;
  }
  try {
    // `await` so async actions (e.g. approveTask, which awaits the agent
    // persona-access grant + unlock) settle before we serialise the task.
    // Awaiting a sync return is a no-op for the other actions.
    const task = (await action(id, body, service, {
      callerType: req.callerType,
      callerDID: req.callerDID,
    })) as WorkflowTask;
    return j(200, { task: withPayloadType(task) });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      const status = err.field === 'id' ? 404 : 400;
      return j(status, { error: err.message, field: err.field });
    }
    if (err instanceof WorkflowTransitionError) {
      return j(409, { error: err.message, from: err.from, to: err.to });
    }
    return j(500, { error: (err as Error).message });
  }
}

function isStagingPersonaAccessApproval(task: WorkflowTask | null): boolean {
  if (task === null || task.kind !== 'approval') return false;
  try {
    const payload = JSON.parse(task.payload) as Record<string, unknown>;
    return payload.type === STAGING_PERSONA_ACCESS_APPROVAL_TYPE;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLeaseMs(rawBody: unknown): number {
  const body = (rawBody as Record<string, unknown> | undefined) ?? {};
  const clamp = (ms: number): number => Math.max(1_000, Math.min(300_000, Math.floor(ms)));
  // The dina-agent CLI sends `lease_seconds` (claim_task / task_heartbeat in
  // client.py); accept it (×1000) so a long-running runner's requested lease is
  // honored instead of silently falling back to the 30s default — otherwise the
  // lease-expiry sweeper requeues a still-running task and duplicates execution.
  const leaseSec = body.lease_seconds;
  if (typeof leaseSec === 'number' && Number.isFinite(leaseSec)) {
    return clamp(leaseSec * 1_000);
  }
  // `lease_ms` kept for in-process / TS callers that pass milliseconds directly.
  const leaseMs = body.lease_ms;
  if (typeof leaseMs === 'number' && Number.isFinite(leaseMs)) {
    return clamp(leaseMs);
  }
  return 30_000;
}

function extractRunnerFilter(rawBody: unknown): string {
  const body = (rawBody as Record<string, unknown> | undefined) ?? {};
  const f = body.runner_filter;
  return typeof f === 'string' ? f : '';
}

function parseUnsignedNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 100;
  return Math.min(500, Math.floor(requested));
}

function strField(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Round-9 #22: owner-facing status text (result_summary / error / progress
 * message) is runner-controlled and rendered on the admin/Activity surface,
 * decoupled from the validated `result`. Cap + single-line it so a runner can't
 * inject oversized or multi-line/control-char content to mislead the owner.
 * Collapses any CR/LF/tab/other C0 control + DEL to a single space, trims, and
 * bounds the length. Not a validity gate — just presentation hygiene.
 */
const MAX_STATUS_TEXT = 500;
export function sanitizeStatusText(v: unknown, maxLen = MAX_STATUS_TEXT): string {
  const s = typeof v === 'string' ? v : '';
  let out = '';
  for (let i = 0; i < s.length && out.length < maxLen; i++) {
    const c = s.charCodeAt(i);
    out += c <= 0x1f || c === 0x7f ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

function optStrField(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function numField(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v;
}

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}
