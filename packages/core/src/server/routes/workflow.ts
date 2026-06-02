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

import {
  grantAgentPersonaAccessFromApproval,
  isAgentPersonaAccessApproval,
} from '../../agent/access';
import {
  STAGING_PERSONA_ACCESS_APPROVAL_TYPE,
  denyApproval,
  drainForApproval,
} from '../../staging/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../../workflow/domain';
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
    return (
      guard ??
      runAction(req, (id, body, s, ctx) => {
        const result = strField(body?.result);
        const agentDID = completingAgentDID(body, ctx);
        if (result === '') {
          throw new WorkflowValidationError('result is required', 'result');
        }
        // Go-Core parity: `result_summary` is the human-readable display
        // line on the admin/diagnostics surface; `result` is the
        // structured payload (JSON for service-query bridging). The
        // Python `dina-agent` MCP `dina_task_complete(task_id, result)`
        // only sends `result` — Go-Core derives the summary from the
        // first ~200 chars when omitted. Match that behaviour so paired
        // OpenClaw runs don't 400 on every completion. Callers that
        // pass an explicit `result_summary` are honoured verbatim.
        const explicitSummary = strField(body?.result_summary);
        const summary = explicitSummary !== '' ? explicitSummary : result.slice(0, 200);
        return s.complete(id, result, summary, agentDID);
      })
    );
  });
  router.post('/v1/workflow/tasks/:id/fail', async (req) => {
    const guard = agentCompletionGuard(req);
    return guard ?? runAction(req, failTask);
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
  const ok = service.store().heartbeatTask(id, agentDID, Date.now(), leaseMs);
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
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === '') return j(400, { error: 'message is required' });
  const ok = service.store().updateTaskProgress(id, agentDID, message, Date.now());
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
  if (ctx.callerType === 'agent') return ctx.callerDID ?? '';
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
  if (req.callerType !== 'agent') return null;
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
      reason: 'agent may only complete/fail a running delegation task it currently holds',
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
  // The session id rides in the task payload — `intent.ts` writes
  // `payload.session` from the validate body's `session` field, and
  // `persona_guard.ts` writes it via the per-ask context. A new
  // `dina session start` mints a fresh sessionId so previously granted
  // grants don't carry over — matches the dina_details §13.4 expectation
  // that "that session" means the CLI session.
  if (body?.scope === 'session' && before !== null) {
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
    } else if (
      payload?.type === 'vault_read_request' &&
      typeof payload.persona === 'string'
    ) {
      grantVaultReadSessionApproval(agentDid, sessionId, payload.persona);
    }
  }

  // issues.txt §2 — approving an agent persona-access request writes the
  // durable grant so the out-of-process agent's retry (even after an app
  // restart) passes the deterministic gate. No local runner to claim it;
  // the grant row IS the outcome.
  if (
    isAgentPersonaAccessApproval(before) &&
    before?.status === WorkflowTaskState.PendingApproval
  ) {
    const approved = service.approve(id);
    // Awaited so the durable grant is written AND the persona is unlocked
    // before the approve response returns (issues.txt §2 — no resume race).
    await grantAgentPersonaAccessFromApproval(approved, Date.now());
    return approved;
  }

  if (
    !isStagingPersonaAccessApproval(before) ||
    before?.status !== WorkflowTaskState.PendingApproval
  ) {
    return service.approve(id);
  }

  const resume = drainForApproval(id);
  const approved = service.approve(id);
  const claimed = service.store().claimApprovalForExecution(id, 1, Math.floor(Date.now() / 1000));
  if (!claimed) return approved;
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
  if (
    isStagingPersonaAccessApproval(before) &&
    before?.status === WorkflowTaskState.PendingApproval
  ) {
    denyApproval(id, reason);
  }
  return service.cancel(id, reason);
}

function failTask(
  id: string,
  body: Record<string, unknown> | null,
  service: NonNullable<ReturnType<typeof getWorkflowService>>,
  ctx: ActionCtx,
): WorkflowTask {
  const errMsg = strField(body?.error);
  const agentDID = completingAgentDID(body, ctx);
  if (errMsg === '') throw new WorkflowValidationError('error is required', 'error');
  const before = service.store().getById(id);
  if (
    isStagingPersonaAccessApproval(before) &&
    before?.status === WorkflowTaskState.PendingApproval
  ) {
    denyApproval(id, errMsg);
  }
  return service.fail(id, errMsg, agentDID);
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
  if (req.callerType === 'agent') {
    return j(403, {
      error: 'access_denied',
      reason: 'agent callers cannot approve or deny tasks',
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
