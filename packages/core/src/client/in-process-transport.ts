/**
 * In-process `CoreClient` transport — dispatches directly through the
 * `CoreRouter` without any HTTP hop.
 *
 * Used by the mobile build target (`apps/mobile/`) where Core + Brain
 * share one RN JS VM. The server build target uses `HttpCoreTransport`
 * instead (lives in `apps/home-node-lite/brain-server/`).
 *
 * Both transports implement the same `CoreClient` interface so Brain
 * code is identical across targets; only the DI wiring differs.
 *
 * **Auth note.** Direct router dispatch bypasses the Ed25519 signing
 * step. That's correct for the mobile case where Brain is in the same
 * process as Core — signing yourself with keys you already own adds
 * no security. The router's `authenticateRequest` pipeline is skipped
 * via handler registration under `auth: 'public'` or (for sensitive
 * routes) by passing pre-authorised headers that mark the request as
 * trusted-local. Sensitive-persona protection still runs via the
 * gatekeeper check inside the handler, regardless of transport.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.30.
 */

import { WorkflowConflictError } from './core-client';

import type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultItemInput,
  VaultStoreResult,
  VaultListOptions,
  VaultListResult,
  VaultDeleteResult,
  SignResult,
  CanonicalSignRequest,
  SignedHeaders,
  PIIScrubResult,
  PIIRehydrateResult,
  NotifyRequest,
  NotifyResult,
  PersonaStatusResult,
  PersonaUnlockResult,
  ServiceConfig,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
  StagingIngestRequest,
  StagingIngestResult,
  StagingClaimResult,
  StagingResolveRequest,
  StagingResolveResult,
  StagingFailResult,
  StagingExtendLeaseResult,
  MsgSendRequest,
  MsgSendResult,
  ScratchpadEntry,
  ScratchpadCheckpointResult,
  ScratchpadClearResult,
  ServiceRespondRequestBody,
  ServiceRespondResult,
  ListWorkflowEventsOptions,
  FailWorkflowEventOptions,
  WorkflowEvent,
  ListWorkflowTasksFilter,
  CreateWorkflowTaskInput,
  CreateWorkflowTaskResult,
  WorkflowTask,
  MemoryTouchParams,
  MemoryTouchResult,
  UpdateContactParams,
  Contact,
} from './core-client';
import type { CoreRouter, CoreRequest, CoreResponse } from '../server/router';

/**
 * Default CoreRequest skeleton — most InProcessTransport calls reuse
 * the same empty headers/params and an empty rawBody. Every request
 * carries `trustedInProcess: true` so the router's auth pipeline is
 * skipped (see `CoreRequest.trustedInProcess` for the threat model).
 * The Fastify HTTP adapter strips this flag on inbound HTTP requests
 * so external callers cannot forge in-process trust.
 */
function blankRequest(overrides: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...overrides,
  };
}

/**
 * Narrow the wire's `code` string to the `WorkflowConflictError.code`
 * union — unknown values collapse to `duplicate_id` which is the
 * pre-classification default for 409-on-create.
 */
function narrowConflictCode(
  raw: unknown,
): 'duplicate_id' | 'duplicate_idempotency' | 'duplicate_correlation' {
  if (
    raw === 'duplicate_id' ||
    raw === 'duplicate_idempotency' ||
    raw === 'duplicate_correlation'
  ) {
    return raw;
  }
  return 'duplicate_id';
}

/**
 * Narrowing helper — throws with a useful message on non-2xx.
 * Narrows `body` to `T` by assertion; callers should still validate
 * critical fields at the callsite.
 */
function expectOk<T>(res: CoreResponse, context: string): T {
  if (res.status < 200 || res.status >= 300) {
    const err = (res.body as { error?: string } | undefined)?.error ?? 'no error field';
    throw new Error(`InProcessTransport: ${context} failed ${res.status} — ${err}`);
  }
  return res.body as T;
}

/**
 * Implements `CoreClient` by dispatching CoreRequest objects through
 * the provided CoreRouter. No network hop; the router's handler runs
 * in the same event loop.
 */
export class InProcessTransport implements CoreClient {
  constructor(private readonly router: CoreRouter) {}

  async healthz(): Promise<CoreHealth> {
    const res = await this.router.handle(blankRequest({ method: 'GET', path: '/healthz' }));
    return expectOk<CoreHealth>(res, 'healthz');
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/vault/query`,
        body: { persona, ...query },
      }),
    );
    return expectOk<VaultQueryResult>(res, `vaultQuery(persona=${persona})`);
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/vault/store`,
        body: { persona, ...item },
      }),
    );
    return expectOk<VaultStoreResult>(res, `vaultStore(persona=${persona})`);
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/vault/list`,
        query: {
          persona,
          ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
          ...(opts?.offset !== undefined ? { offset: String(opts.offset) } : {}),
          ...(opts?.type !== undefined ? { type: opts.type } : {}),
        },
      }),
    );
    return expectOk<VaultListResult>(res, `vaultList(persona=${persona})`);
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'DELETE',
        path: `/v1/vault/items/${encodeURIComponent(itemId)}`,
        query: { persona },
      }),
    );
    return expectOk<VaultDeleteResult>(res, `vaultDelete(persona=${persona}, id=${itemId})`);
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    // Bytes → base64 for transport since CoreRequest.body is JSON-friendly.
    // Core's handler base64-decodes before signing; the round-trip is
    // lossless because Uint8Array → base64 is bijective.
    const base64Payload = Buffer.from(payload).toString('base64');
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/did/sign',
        body: { payload: base64Payload },
      }),
    );
    return expectOk<SignResult>(res, 'didSign');
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/did/sign-canonical',
        body: {
          method: req.method,
          path: req.path,
          query: req.query,
          body: Buffer.from(req.body).toString('base64'),
        },
      }),
    );
    return expectOk<SignedHeaders>(res, 'didSignCanonical');
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/pii/scrub',
        body: { text },
      }),
    );
    return expectOk<PIIScrubResult>(res, 'piiScrub');
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/pii/rehydrate',
        body: { sessionId, text },
      }),
    );
    return expectOk<PIIRehydrateResult>(res, `piiRehydrate(session=${sessionId})`);
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/notify',
        body: notification,
      }),
    );
    return expectOk<NotifyResult>(res, `notify(priority=${notification.priority})`);
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/persona/status`,
        query: { persona },
      }),
    );
    return expectOk<PersonaStatusResult>(res, `personaStatus(persona=${persona})`);
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    // Passphrase lives on the body, never the query — never end up in
    // access logs or the browser's history. Core hashes it into the
    // Argon2id KDF and never writes it to disk.
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/persona/unlock`,
        body: { persona, passphrase },
      }),
    );
    return expectOk<PersonaUnlockResult>(res, `personaUnlock(persona=${persona})`);
  }

  async putServiceConfig(config: ServiceConfig): Promise<void> {
    const res = await this.router.handle(
      blankRequest({ method: 'PUT', path: '/v1/service/config', body: config }),
    );
    expectOk<unknown>(res, 'putServiceConfig');
  }

  async serviceConfig(): Promise<ServiceConfig | null> {
    // Core returns 404 when no config is published — map to `null`
    // so Brain can branch without try/catch on a non-exceptional
    // state. Other non-2xx (500, 503) still throw via expectOk.
    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/service/config' }),
    );
    if (res.status === 404) return null;
    return expectOk<ServiceConfig>(res, 'serviceConfig');
  }

  async sendServiceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    // Route's validator speaks snake_case; translate at the boundary
    // so Brain code stays in camelCase. Optional fields are omitted
    // when undefined so the server's `typeof b.x === 'string'` checks
    // behave as intended (not seeing a literal `undefined`).
    const body: Record<string, unknown> = {
      to_did: req.toDID,
      capability: req.capability,
      query_id: req.queryId,
      params: req.params,
      ttl_seconds: req.ttlSeconds,
    };
    if (req.serviceName !== undefined) body.service_name = req.serviceName;
    if (req.originChannel !== undefined) body.origin_channel = req.originChannel;
    if (req.schemaHash !== undefined) body.schema_hash = req.schemaHash;

    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/service/query', body }),
    );
    const raw = expectOk<{ task_id: string; query_id: string; deduped?: boolean }>(
      res,
      `sendServiceQuery(capability=${req.capability})`,
    );
    const out: ServiceQueryResult = { taskId: raw.task_id, queryId: raw.query_id };
    if (raw.deduped !== undefined) out.deduped = raw.deduped;
    return out;
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    // Personas flatten to a comma-separated list per the route's
    // contract (`parsePersonaFilter`). Limit encodes as string — the
    // router reads query params as strings regardless of JS type.
    const query: Record<string, string> = {};
    if (opts?.personas !== undefined && opts.personas.length > 0) {
      query.persona = opts.personas.join(',');
    }
    if (opts?.limit !== undefined) {
      query.limit = String(opts.limit);
    }
    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/memory/toc', query }),
    );
    return expectOk<MemoryToCResult>(res, 'memoryToC');
  }

  // ─── Staging inbox ────────────────────────────────────────────────────

  async stagingIngest(req: StagingIngestRequest): Promise<StagingIngestResult> {
    const body: Record<string, unknown> = {
      source: req.source,
      source_id: req.sourceId,
    };
    if (req.producerId !== undefined) body.producer_id = req.producerId;
    if (req.data !== undefined) body.data = req.data;
    if (req.expiresAt !== undefined) body.expires_at = req.expiresAt;

    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/staging/ingest', body }),
    );
    const raw = expectOk<{ id: string; duplicate: boolean; status: string }>(
      res,
      `stagingIngest(source=${req.source}, sourceId=${req.sourceId})`,
    );
    return { itemId: raw.id, duplicate: raw.duplicate, status: raw.status };
  }

  async stagingClaim(limit: number): Promise<StagingClaimResult> {
    // Limit rides on the query string so the route's clampInt helper
    // sees a canonical string — matches the HTTP transport's shape.
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/staging/claim',
        query: { limit: String(limit) },
      }),
    );
    return expectOk<StagingClaimResult>(res, `stagingClaim(limit=${limit})`);
  }

  async stagingResolve(req: StagingResolveRequest): Promise<StagingResolveResult> {
    // Wire shape:  { id, persona | personas[], data, persona_open? | persona_access? }.
    // Single-persona string → `persona`; array → `personas` (GAP-MULTI-01).
    const body: Record<string, unknown> = { id: req.itemId, data: req.data };
    if (Array.isArray(req.persona)) {
      body.personas = req.persona;
      if (req.personaAccess !== undefined) body.persona_access = req.personaAccess;
    } else {
      body.persona = req.persona;
      if (req.personaOpen !== undefined) body.persona_open = req.personaOpen;
    }

    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/staging/resolve', body }),
    );
    const raw = expectOk<{ id: string; status: string; personas?: string[] }>(
      res,
      `stagingResolve(itemId=${req.itemId})`,
    );
    const out: StagingResolveResult = { itemId: raw.id, status: raw.status };
    if (raw.personas !== undefined) out.personas = raw.personas;
    return out;
  }

  async stagingFail(itemId: string, reason: string): Promise<StagingFailResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/staging/fail',
        body: { id: itemId, reason },
      }),
    );
    const raw = expectOk<{ id: string; retry_count: number }>(
      res,
      `stagingFail(itemId=${itemId})`,
    );
    return { itemId: raw.id, retryCount: raw.retry_count };
  }

  async stagingExtendLease(itemId: string, seconds: number): Promise<StagingExtendLeaseResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/staging/extend-lease',
        body: { id: itemId, seconds },
      }),
    );
    const raw = expectOk<{ id: string; extended_by: number }>(
      res,
      `stagingExtendLease(itemId=${itemId})`,
    );
    return { itemId: raw.id, extendedBySeconds: raw.extended_by };
  }

  // ─── D2D messaging ────────────────────────────────────────────────────

  async msgSend(req: MsgSendRequest): Promise<MsgSendResult> {
    // Wire contract is snake_case (`recipient_did`, `type`, `body`);
    // ergonomic method takes camelCase + translates at the boundary.
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/msg/send',
        body: {
          recipient_did: req.recipientDID,
          type: req.messageType,
          body: req.body,
        },
      }),
    );
    expectOk<{ ok: boolean }>(res, `msgSend(to=${req.recipientDID})`);
    return { ok: true };
  }

  // ─── Scratchpad ──────────────────────────────────────────────────────

  async scratchpadCheckpoint(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<ScratchpadCheckpointResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/scratchpad',
        body: { taskId, step, context },
      }),
    );
    expectOk<{ status: string; taskId: string }>(res, `scratchpadCheckpoint(task=${taskId})`);
    return { taskId, step };
  }

  async scratchpadResume(taskId: string): Promise<ScratchpadEntry | null> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/scratchpad/${encodeURIComponent(taskId)}`,
      }),
    );
    // Route returns `body: null` for missing/stale — pass through as
    // `null` without the resume() caller having to branch on HTTP
    // status. Other non-2xx (500, 413) still throw via expectOk.
    if (res.status === 200 && res.body === null) return null;
    return expectOk<ScratchpadEntry>(res, `scratchpadResume(task=${taskId})`);
  }

  async scratchpadClear(taskId: string): Promise<ScratchpadClearResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'DELETE',
        path: `/v1/scratchpad/${encodeURIComponent(taskId)}`,
      }),
    );
    expectOk<{ status: string }>(res, `scratchpadClear(task=${taskId})`);
    return { taskId };
  }

  // ─── Service respond ─────────────────────────────────────────────────

  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/service/respond',
        body: { task_id: taskId, response_body: responseBody },
      }),
    );
    // Route returns either `{status: 'sent', task_id}` (fresh send) or
    // `{already_processed: true, status: current.status}` (retry against
    // a terminated task). `expectOk` throws on non-2xx; we narrow here.
    const raw = expectOk<{
      status?: string;
      task_id?: string;
      already_processed?: boolean;
    }>(res, `sendServiceRespond(task=${taskId})`);
    return {
      status: typeof raw.status === 'string' ? raw.status : '',
      taskId: typeof raw.task_id === 'string' ? raw.task_id : taskId,
      alreadyProcessed: raw.already_processed === true,
    };
  }

  // ─── Workflow events ─────────────────────────────────────────────────

  async listWorkflowEvents(opts: ListWorkflowEventsOptions = {}): Promise<WorkflowEvent[]> {
    // Encode `needs_delivery=true` only when explicitly requested — the
    // route treats the ABSENCE of the flag as "full audit stream" and
    // the presence-of-any-non-'true'-value as false, so we never emit
    // `needs_delivery=false` on the wire.
    const query: Record<string, string> = {};
    if (opts.since !== undefined) query.since = String(opts.since);
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.needsDeliveryOnly === true) query.needs_delivery = 'true';

    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/workflow/events', query }),
    );
    const raw = expectOk<{ events?: WorkflowEvent[] }>(res, 'listWorkflowEvents');
    return Array.isArray(raw.events) ? raw.events : [];
  }

  async acknowledgeWorkflowEvent(eventId: number): Promise<boolean> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/workflow/events/${encodeURIComponent(String(eventId))}/ack`,
        body: {},
      }),
    );
    // 404 = unknown / already-acked event. Return `false` (not throw) so
    // callers can retry idempotently — matches the CoreClient shape.
    if (res.status === 404) return false;
    expectOk<{ ok: boolean }>(res, `acknowledgeWorkflowEvent(id=${eventId})`);
    return true;
  }

  async failWorkflowEventDelivery(
    eventId: number,
    opts: FailWorkflowEventOptions = {},
  ): Promise<boolean> {
    const body: Record<string, unknown> = {};
    if (opts.nextDeliveryAt !== undefined) body.next_delivery_at = opts.nextDeliveryAt;
    if (opts.error !== undefined) body.error = opts.error;

    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/workflow/events/${encodeURIComponent(String(eventId))}/fail`,
        body,
      }),
    );
    if (res.status === 404) return false;
    expectOk<{ ok: boolean }>(res, `failWorkflowEventDelivery(id=${eventId})`);
    return true;
  }

  // ─── Workflow tasks — reads + create ─────────────────────────────────

  async listWorkflowTasks(filter: ListWorkflowTasksFilter): Promise<WorkflowTask[]> {
    // kind + state are required by the route — emit both; limit rides
    // on the wire as a string since CoreRequest.query is Record<string,string>.
    const query: Record<string, string> = {
      kind: filter.kind,
      state: filter.state,
    };
    if (filter.limit !== undefined) query.limit = String(filter.limit);

    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/workflow/tasks', query }),
    );
    const raw = expectOk<{ tasks?: WorkflowTask[] }>(
      res,
      `listWorkflowTasks(kind=${filter.kind}, state=${filter.state})`,
    );
    return Array.isArray(raw.tasks) ? raw.tasks : [];
  }

  async getWorkflowTask(id: string): Promise<WorkflowTask | null> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/workflow/tasks/${encodeURIComponent(id)}`,
      }),
    );
    if (res.status === 404) return null;
    const raw = expectOk<{ task?: WorkflowTask }>(res, `getWorkflowTask(id=${id})`);
    return raw.task ?? null;
  }

  async createWorkflowTask(input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult> {
    // camelCase → snake_case at the transport boundary.
    const body: Record<string, unknown> = {
      id: input.id,
      kind: input.kind,
      description: input.description,
      payload: input.payload,
    };
    if (input.expiresAtSec !== undefined) body.expires_at = input.expiresAtSec;
    if (input.correlationId !== undefined) body.correlation_id = input.correlationId;
    if (input.parentId !== undefined) body.parent_id = input.parentId;
    if (input.proposalId !== undefined) body.proposal_id = input.proposalId;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.origin !== undefined) body.origin = input.origin;
    if (input.sessionName !== undefined) body.session_name = input.sessionName;
    if (input.idempotencyKey !== undefined) body.idempotency_key = input.idempotencyKey;
    if (input.policy !== undefined) body.policy = input.policy;
    if (input.initialState !== undefined) body.initial_state = input.initialState;

    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/workflow/tasks', body }),
    );
    // 409 → typed conflict error so callers match on `.code`. Route
    // emits `{error, code}` on this branch; fall back to `duplicate_id`
    // which is the shape's default when the server rows pre-dated code
    // classification.
    if (res.status === 409) {
      const errBody = (res.body as { error?: string; code?: string } | undefined) ?? {};
      throw new WorkflowConflictError(
        errBody.error ?? 'workflow conflict',
        narrowConflictCode(errBody.code),
      );
    }
    // Route returns 201 on fresh create + 200 on idempotent dedupe.
    if (res.status !== 200 && res.status !== 201) {
      const err = (res.body as { error?: string } | undefined)?.error ?? 'no error field';
      throw new Error(
        `InProcessTransport: createWorkflowTask failed ${res.status} — ${err}`,
      );
    }
    const raw = (res.body ?? {}) as { task?: WorkflowTask; deduped?: boolean };
    if (raw.task === undefined) {
      throw new Error('InProcessTransport: createWorkflowTask response missing task');
    }
    return { task: raw.task, deduped: raw.deduped === true };
  }

  // ─── Workflow task state transitions ─────────────────────────────────

  async approveWorkflowTask(id: string): Promise<WorkflowTask> {
    return this.workflowAction(id, 'approve');
  }

  async cancelWorkflowTask(id: string, reason = ''): Promise<WorkflowTask> {
    return this.workflowAction(
      id,
      'cancel',
      reason !== '' ? { reason } : undefined,
    );
  }

  async completeWorkflowTask(
    id: string,
    result: string,
    resultSummary: string,
    agentDID = '',
  ): Promise<WorkflowTask> {
    const body: Record<string, unknown> = {
      result,
      result_summary: resultSummary,
    };
    if (agentDID !== '') body.agent_did = agentDID;
    return this.workflowAction(id, 'complete', body);
  }

  async failWorkflowTask(
    id: string,
    errorMsg: string,
    agentDID = '',
  ): Promise<WorkflowTask> {
    const body: Record<string, unknown> = { error: errorMsg };
    if (agentDID !== '') body.agent_did = agentDID;
    return this.workflowAction(id, 'fail', body);
  }

  /**
   * Shared POST driver for approve / cancel / complete / fail. Each
   * endpoint's success response shape is uniform (`{task}`); this
   * helper centralises the parse + 2xx check so the 4 methods above
   * stay trivial.
   */
  private async workflowAction(
    id: string,
    action: 'approve' | 'cancel' | 'complete' | 'fail',
    body?: Record<string, unknown>,
  ): Promise<WorkflowTask> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/workflow/tasks/${encodeURIComponent(id)}/${action}`,
        body: body ?? {},
      }),
    );
    const raw = expectOk<{ task?: WorkflowTask }>(
      res,
      `${action}WorkflowTask(id=${id})`,
    );
    if (raw.task === undefined) {
      throw new Error(
        `InProcessTransport: ${action}WorkflowTask response missing task`,
      );
    }
    return raw.task;
  }

  // ─── Working-memory + contacts ───────────────────────────────────────

  async memoryTouch(params: MemoryTouchParams): Promise<MemoryTouchResult> {
    const body: Record<string, unknown> = {
      persona: params.persona,
      topic: params.topic,
      kind: params.kind,
    };
    // Route ignores empty `sample_item_id`; omit it so the request body
    // stays canonical.
    if (params.sampleItemId !== undefined && params.sampleItemId !== '') {
      body.sample_item_id = params.sampleItemId;
    }
    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/memory/topic/touch', body }),
    );
    const raw = expectOk<{
      status?: 'ok' | 'skipped';
      canonical?: string;
      reason?: string;
    }>(res, `memoryTouch(persona=${params.persona}, topic=${params.topic})`);
    // Defensive coerce — if the route ever returns {} on 204-like
    // success, default to 'ok' rather than `undefined` so callers can
    // branch on a string literal.
    const out: MemoryTouchResult = { status: raw.status ?? 'ok' };
    if (typeof raw.canonical === 'string') out.canonical = raw.canonical;
    if (typeof raw.reason === 'string') out.reason = raw.reason;
    return out;
  }

  async findContactsByPreference(category: string): Promise<Contact[]> {
    // Client-side short-circuit matches the CoreClient contract —
    // empty/whitespace category never reaches the server.
    const clean = typeof category === 'string' ? category.trim() : '';
    if (clean === '') return [];
    let res;
    try {
      res = await this.router.handle(
        blankRequest({
          method: 'GET',
          path: '/v1/contacts/by-preference',
          query: { category: clean },
        }),
      );
    } catch {
      return [];
    }
    if (res.status !== 200) return [];
    const raw = (res.body ?? {}) as { contacts?: unknown };
    return Array.isArray(raw.contacts) ? (raw.contacts as Contact[]) : [];
  }

  async updateContact(did: string, updates: UpdateContactParams): Promise<void> {
    if (typeof did !== 'string' || did.trim() === '') {
      throw new Error('updateContact: did is required');
    }
    const body: Record<string, unknown> = {};
    // Tri-state: only include the field when the caller explicitly
    // passed it. `[]` means "clear" (sent as []), non-empty replaces,
    // `undefined` is don't-touch (field omitted from body).
    if (updates.preferredFor !== undefined) {
      body.preferred_for = [...updates.preferredFor];
    }
    const res = await this.router.handle(
      blankRequest({
        method: 'PUT',
        path: `/v1/contacts/${encodeURIComponent(did.trim())}`,
        body,
      }),
    );
    // No return value — throw on non-2xx, including 404 (unknown DID).
    expectOk<unknown>(res, `updateContact(did=${did})`);
  }
}
