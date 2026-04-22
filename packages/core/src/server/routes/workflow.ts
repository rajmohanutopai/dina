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

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';
import {
  WorkflowConflictError,
  WorkflowTransitionError,
  WorkflowValidationError,
  getWorkflowService,
} from '../../workflow/service';
import type { WorkflowTaskState } from '../../workflow/domain';

export function registerWorkflowRoutes(router: CoreRouter): void {
  router.post('/v1/workflow/tasks', createTask);
  router.get('/v1/workflow/tasks/:id', getTask);
  router.get('/v1/workflow/tasks', listTasks);
  router.post('/v1/workflow/tasks/claim', claimTask);
  router.post('/v1/workflow/tasks/:id/heartbeat', heartbeatTask);
  router.post('/v1/workflow/tasks/:id/progress', progressTask);
  router.post('/v1/workflow/tasks/:id/approve', (req) =>
    runAction(req, (id, _body, s) => s.approve(id)),
  );
  router.post('/v1/workflow/tasks/:id/cancel', (req) =>
    runAction(req, (id, body, s) => s.cancel(id, strField(body?.reason, ''))),
  );
  router.post('/v1/workflow/tasks/:id/complete', (req) =>
    runAction(req, (id, body, s) => {
      const result = strField(body?.result);
      const summary = strField(body?.result_summary);
      const agentDID = strField(body?.agent_did);
      if (result === '' || summary === '') {
        throw new WorkflowValidationError(
          'result and result_summary are required',
          result === '' ? 'result' : 'result_summary',
        );
      }
      return s.complete(id, result, summary, agentDID);
    }),
  );
  router.post('/v1/workflow/tasks/:id/fail', (req) =>
    runAction(req, (id, body, s) => {
      const errMsg = strField(body?.error);
      const agentDID = strField(body?.agent_did);
      if (errMsg === '') throw new WorkflowValidationError('error is required', 'error');
      return s.fail(id, errMsg, agentDID);
    }),
  );
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
  };
  try {
    const task = service.create(input);
    return j(201, { task });
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
        if (existing !== null) return j(200, { task: existing, deduped: true });
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
  return j(200, { task });
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
  return j(200, { tasks, count: tasks.length });
}

async function claimTask(req: CoreRequest): Promise<CoreResponse> {
  const service = getWorkflowService();
  if (service === null) return j(503, { error: 'workflow service not wired' });
  const agentDID = req.headers['x-did'] ?? '';
  if (agentDID === '') return j(400, { error: 'X-DID header is required' });
  const leaseMs = extractLeaseMs(req.body);
  const task = service.store().claimDelegationTask(agentDID, Date.now(), leaseMs);
  if (task === null) return j(204, undefined);
  return j(200, { task });
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

type TaskAction = (
  id: string,
  body: Record<string, unknown> | null,
  service: NonNullable<ReturnType<typeof getWorkflowService>>,
) => unknown;

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
    const task = action(id, body, service);
    return j(200, { task });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLeaseMs(rawBody: unknown): number {
  const body = (rawBody as Record<string, unknown> | undefined) ?? {};
  const lease = body.lease_ms;
  if (typeof lease === 'number' && Number.isFinite(lease)) {
    return Math.max(1_000, Math.min(300_000, Math.floor(lease)));
  }
  return 30_000;
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
