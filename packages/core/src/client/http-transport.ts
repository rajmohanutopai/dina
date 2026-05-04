/**
 * HTTP-backed `CoreClient` transport — dispatches typed method calls
 * over signed HTTPS to a remote `dina-core` process.
 *
 * Used by the server build target (`apps/home-node-lite/brain-server/`)
 * where Core + Brain run as two separate Node processes — preserving
 * the "Brain is an untrusted tenant" security boundary. Mobile uses
 * `InProcessTransport` instead (direct CoreRouter dispatch, no wire).
 *
 * **Platform-agnostic by construction.** This module imports no
 * transport-layer concretion: no `fetch`, no `undici`, no `ws`, no
 * `node:http`. Platform specifics are injected via two DI points:
 *
 *   - `HttpClient` — an abstracted request function. `brain-server`
 *     wires a `fetch` or `undici.fetch` adapter; any alternate runtime
 *     (Bun, Deno, edge) can wire its own.
 *   - `CanonicalRequestSigner` — produces the 4 auth headers (`X-DID`,
 *     `X-Timestamp`, `X-Nonce`, `X-Signature`) by signing the canonical
 *     request string with Brain's Ed25519 service key. The caller owns
 *     key material; the transport never touches it.
 *
 * Keeping the HTTP concretion out of this file is what lets the lint
 * gate in task 1.33 forbid `fetch`/`undici`/`ws` imports anywhere in
 * `packages/brain/src/**` without this module tripping the rule.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.31.
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

// ---------------------------------------------------------------------------
// DI abstractions — injected by the platform
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP-client contract the transport drives. Deliberately a
 * strict subset of the Fetch API: just enough to round-trip request
 * bytes. Brain-server adapts `globalThis.fetch` / `undici.fetch` to
 * this shape; tests inject a mock that records calls.
 */
export interface HttpClient {
  request(url: string, init: HttpRequestInit): Promise<HttpResponse>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  /** Encoded body bytes. Omit for GET / DELETE. */
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names per the canonical convention. */
  headers: Record<string, string>;
  /** Raw response body bytes; the transport decodes JSON internally. */
  body: Uint8Array;
}

/**
 * Produces the 4 auth headers Core verifies on inbound requests. The
 * signer owns the canonical-string construction (method + path + query
 * + timestamp + nonce + SHA-256(body)) + the Ed25519 sign step. The
 * transport just calls it with raw request inputs and attaches the
 * returned headers.
 *
 * The canonical-string recipe lives in `@dina/protocol`
 * (`buildCanonicalPayload`) — brain-server's signer implementation
 * composes protocol's helper with its private-key sign function.
 */
export type CanonicalRequestSigner = (args: {
  method: string;
  path: string;
  /** Already URL-encoded, no leading `?`. Empty string when no query. */
  query: string;
  /** Raw body bytes; pass an empty Uint8Array for bodyless requests. */
  body: Uint8Array;
}) => Promise<SignedHeaders>;

export interface HttpCoreTransportOptions {
  /** e.g. `http://localhost:8100`. Trailing slash is stripped. */
  baseUrl: string;
  httpClient: HttpClient;
  signer: CanonicalRequestSigner;
}

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

/**
 * Signed-HTTP implementation of `CoreClient`. Mirrors
 * `InProcessTransport` on the wire side (same routes, same bodies) —
 * only the dispatch mechanism changes.
 */
export class HttpCoreTransport implements CoreClient {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  private readonly signer: CanonicalRequestSigner;

  constructor(options: HttpCoreTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.httpClient = options.httpClient;
    this.signer = options.signer;
  }

  async healthz(): Promise<CoreHealth> {
    return this.call<CoreHealth>('GET', '/healthz', undefined, undefined, 'healthz');
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    return this.call<VaultQueryResult>(
      'POST',
      '/v1/vault/query',
      undefined,
      { persona, ...query },
      `vaultQuery(persona=${persona})`,
    );
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    return this.call<VaultStoreResult>(
      'POST',
      '/v1/vault/store',
      undefined,
      { persona, ...item },
      `vaultStore(persona=${persona})`,
    );
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    const query: Record<string, string> = { persona };
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.offset !== undefined) query.offset = String(opts.offset);
    if (opts?.type !== undefined) query.type = opts.type;
    return this.call<VaultListResult>(
      'GET',
      '/v1/vault/list',
      query,
      undefined,
      `vaultList(persona=${persona})`,
    );
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    return this.call<VaultDeleteResult>(
      'DELETE',
      `/v1/vault/items/${encodeURIComponent(itemId)}`,
      { persona },
      undefined,
      `vaultDelete(persona=${persona}, id=${itemId})`,
    );
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    // Bytes → base64 so the server sees the same shape whether the
    // transport is InProcess or HTTP (both route bodies are JSON).
    const base64Payload = bytesToBase64(payload);
    return this.call<SignResult>(
      'POST',
      '/v1/did/sign',
      undefined,
      { payload: base64Payload },
      'didSign',
    );
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    return this.call<SignedHeaders>(
      'POST',
      '/v1/did/sign-canonical',
      undefined,
      {
        method: req.method,
        path: req.path,
        query: req.query,
        body: bytesToBase64(req.body),
      },
      'didSignCanonical',
    );
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    return this.call<PIIScrubResult>('POST', '/v1/pii/scrub', undefined, { text }, 'piiScrub');
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    return this.call<PIIRehydrateResult>(
      'POST',
      '/v1/pii/rehydrate',
      undefined,
      { sessionId, text },
      `piiRehydrate(session=${sessionId})`,
    );
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    return this.call<NotifyResult>(
      'POST',
      '/v1/notify',
      undefined,
      notification,
      `notify(priority=${notification.priority})`,
    );
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    return this.call<PersonaStatusResult>(
      'GET',
      '/v1/persona/status',
      { persona },
      undefined,
      `personaStatus(persona=${persona})`,
    );
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    // Passphrase on body, never query — passphrases must never end up
    // in reverse-proxy access logs or browser history.
    return this.call<PersonaUnlockResult>(
      'POST',
      '/v1/persona/unlock',
      undefined,
      { persona, passphrase },
      `personaUnlock(persona=${persona})`,
    );
  }

  async putServiceConfig(config: ServiceConfig): Promise<void> {
    await this.call<unknown>(
      'PUT',
      '/v1/service/config',
      undefined,
      config,
      'putServiceConfig',
    );
  }

  async serviceConfig(): Promise<ServiceConfig | null> {
    const res = await this.callRaw('GET', '/v1/service/config', undefined, undefined);
    if (res.status === 404) return null;
    return this.parseOk<ServiceConfig>(res, 'serviceConfig');
  }

  async sendServiceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    // Route expects snake_case; camelCase→snake_case at the boundary
    // (same mapping as InProcessTransport — both transports speak the
    // identical wire format). Optional fields omitted when undefined.
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

    const raw = await this.call<{ task_id: string; query_id: string; deduped?: boolean }>(
      'POST',
      '/v1/service/query',
      undefined,
      body,
      `sendServiceQuery(capability=${req.capability})`,
    );
    const out: ServiceQueryResult = { taskId: raw.task_id, queryId: raw.query_id };
    if (raw.deduped !== undefined) out.deduped = raw.deduped;
    return out;
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    const query: Record<string, string> = {};
    if (opts?.personas !== undefined && opts.personas.length > 0) {
      query.persona = opts.personas.join(',');
    }
    if (opts?.limit !== undefined) {
      query.limit = String(opts.limit);
    }
    return this.call<MemoryToCResult>(
      'GET',
      '/v1/memory/toc',
      Object.keys(query).length > 0 ? query : undefined,
      undefined,
      'memoryToC',
    );
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

    const raw = await this.call<{ id: string; duplicate: boolean; status: string }>(
      'POST',
      '/v1/staging/ingest',
      undefined,
      body,
      `stagingIngest(source=${req.source}, sourceId=${req.sourceId})`,
    );
    return { itemId: raw.id, duplicate: raw.duplicate, status: raw.status };
  }

  async stagingClaim(limit: number): Promise<StagingClaimResult> {
    return this.call<StagingClaimResult>(
      'POST',
      '/v1/staging/claim',
      { limit: String(limit) },
      undefined,
      `stagingClaim(limit=${limit})`,
    );
  }

  async stagingResolve(req: StagingResolveRequest): Promise<StagingResolveResult> {
    const body: Record<string, unknown> = { id: req.itemId, data: req.data };
    if (Array.isArray(req.persona)) {
      body.personas = req.persona;
      if (req.personaAccess !== undefined) body.persona_access = req.personaAccess;
    } else {
      body.persona = req.persona;
      if (req.personaOpen !== undefined) body.persona_open = req.personaOpen;
    }

    const raw = await this.call<{ id: string; status: string; personas?: string[] }>(
      'POST',
      '/v1/staging/resolve',
      undefined,
      body,
      `stagingResolve(itemId=${req.itemId})`,
    );
    const out: StagingResolveResult = { itemId: raw.id, status: raw.status };
    if (raw.personas !== undefined) out.personas = raw.personas;
    return out;
  }

  async stagingFail(itemId: string, reason: string): Promise<StagingFailResult> {
    const raw = await this.call<{ id: string; retry_count: number }>(
      'POST',
      '/v1/staging/fail',
      undefined,
      { id: itemId, reason },
      `stagingFail(itemId=${itemId})`,
    );
    return { itemId: raw.id, retryCount: raw.retry_count };
  }

  async stagingExtendLease(itemId: string, seconds: number): Promise<StagingExtendLeaseResult> {
    const raw = await this.call<{ id: string; extended_by: number }>(
      'POST',
      '/v1/staging/extend-lease',
      undefined,
      { id: itemId, seconds },
      `stagingExtendLease(itemId=${itemId})`,
    );
    return { itemId: raw.id, extendedBySeconds: raw.extended_by };
  }

  // ─── D2D messaging ────────────────────────────────────────────────────

  async msgSend(req: MsgSendRequest): Promise<MsgSendResult> {
    await this.call<{ ok?: boolean }>(
      'POST',
      '/v1/msg/send',
      undefined,
      {
        recipient_did: req.recipientDID,
        type: req.messageType,
        body: req.body,
      },
      `msgSend(to=${req.recipientDID})`,
    );
    return { ok: true };
  }

  // ─── Scratchpad ──────────────────────────────────────────────────────

  async scratchpadCheckpoint(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<ScratchpadCheckpointResult> {
    await this.call<{ status: string; taskId: string }>(
      'POST',
      '/v1/scratchpad',
      undefined,
      { taskId, step, context },
      `scratchpadCheckpoint(task=${taskId})`,
    );
    return { taskId, step };
  }

  async scratchpadResume(taskId: string): Promise<ScratchpadEntry | null> {
    // Route returns 200 with JSON `null` for missing/stale rows — parseOk
    // passes that null through as the parsed value. The `| null` union in
    // the generic lets callers branch without a cast. Non-2xx still throw.
    return this.call<ScratchpadEntry | null>(
      'GET',
      `/v1/scratchpad/${encodeURIComponent(taskId)}`,
      undefined,
      undefined,
      `scratchpadResume(task=${taskId})`,
    );
  }

  async scratchpadClear(taskId: string): Promise<ScratchpadClearResult> {
    await this.call<{ status: string }>(
      'DELETE',
      `/v1/scratchpad/${encodeURIComponent(taskId)}`,
      undefined,
      undefined,
      `scratchpadClear(task=${taskId})`,
    );
    return { taskId };
  }

  // ─── Service respond ─────────────────────────────────────────────────

  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    const raw = await this.call<{
      status?: string;
      task_id?: string;
      already_processed?: boolean;
    }>(
      'POST',
      '/v1/service/respond',
      undefined,
      { task_id: taskId, response_body: responseBody },
      `sendServiceRespond(task=${taskId})`,
    );
    return {
      status: typeof raw.status === 'string' ? raw.status : '',
      taskId: typeof raw.task_id === 'string' ? raw.task_id : taskId,
      alreadyProcessed: raw.already_processed === true,
    };
  }

  // ─── Workflow events ─────────────────────────────────────────────────

  async listWorkflowEvents(opts: ListWorkflowEventsOptions = {}): Promise<WorkflowEvent[]> {
    const query: Record<string, string> = {};
    if (opts.since !== undefined) query.since = String(opts.since);
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.needsDeliveryOnly === true) query.needs_delivery = 'true';

    const raw = await this.call<{ events?: WorkflowEvent[] }>(
      'GET',
      '/v1/workflow/events',
      Object.keys(query).length > 0 ? query : undefined,
      undefined,
      'listWorkflowEvents',
    );
    return Array.isArray(raw.events) ? raw.events : [];
  }

  async acknowledgeWorkflowEvent(eventId: number): Promise<boolean> {
    const res = await this.callRaw(
      'POST',
      `/v1/workflow/events/${encodeURIComponent(String(eventId))}/ack`,
      undefined,
      {},
    );
    if (res.status === 404) return false;
    this.parseOk<{ ok: boolean }>(res, `acknowledgeWorkflowEvent(id=${eventId})`);
    return true;
  }

  async failWorkflowEventDelivery(
    eventId: number,
    opts: FailWorkflowEventOptions = {},
  ): Promise<boolean> {
    const body: Record<string, unknown> = {};
    if (opts.nextDeliveryAt !== undefined) body.next_delivery_at = opts.nextDeliveryAt;
    if (opts.error !== undefined) body.error = opts.error;

    const res = await this.callRaw(
      'POST',
      `/v1/workflow/events/${encodeURIComponent(String(eventId))}/fail`,
      undefined,
      body,
    );
    if (res.status === 404) return false;
    this.parseOk<{ ok: boolean }>(res, `failWorkflowEventDelivery(id=${eventId})`);
    return true;
  }

  // ─── Workflow tasks — reads + create ─────────────────────────────────

  async listWorkflowTasks(filter: ListWorkflowTasksFilter): Promise<WorkflowTask[]> {
    const query: Record<string, string> = {
      kind: filter.kind,
      state: filter.state,
    };
    if (filter.limit !== undefined) query.limit = String(filter.limit);

    const raw = await this.call<{ tasks?: WorkflowTask[] }>(
      'GET',
      '/v1/workflow/tasks',
      query,
      undefined,
      `listWorkflowTasks(kind=${filter.kind}, state=${filter.state})`,
    );
    return Array.isArray(raw.tasks) ? raw.tasks : [];
  }

  async getWorkflowTask(id: string): Promise<WorkflowTask | null> {
    const res = await this.callRaw(
      'GET',
      `/v1/workflow/tasks/${encodeURIComponent(id)}`,
      undefined,
      undefined,
    );
    if (res.status === 404) return null;
    const raw = this.parseOk<{ task?: WorkflowTask }>(res, `getWorkflowTask(id=${id})`);
    return raw.task ?? null;
  }

  async createWorkflowTask(input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult> {
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

    const res = await this.callRaw('POST', '/v1/workflow/tasks', undefined, body);
    if (res.status === 409) {
      // Body parses via parseOk's helper but parseOk throws on non-2xx
      // — decode inline instead.
      const text =
        res.body.byteLength > 0 ? new TextDecoder().decode(res.body) : '';
      let parsed: { error?: string; code?: string } = {};
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
      }
      throw new WorkflowConflictError(
        parsed.error ?? 'workflow conflict',
        narrowConflictCode(parsed.code),
      );
    }
    if (res.status !== 200 && res.status !== 201) {
      // Lean on parseOk to produce the standard error message shape,
      // then rethrow so `accept: [200,201]` semantics hold. parseOk
      // throws unconditionally on non-2xx so this line NEVER returns.
      this.parseOk<unknown>(res, `createWorkflowTask(id=${input.id})`);
    }
    const text =
      res.body.byteLength > 0 ? new TextDecoder().decode(res.body) : '';
    const raw = (text === '' ? {} : JSON.parse(text)) as {
      task?: WorkflowTask;
      deduped?: boolean;
    };
    if (raw.task === undefined) {
      throw new Error(
        `HttpCoreTransport: createWorkflowTask response missing task (status ${res.status})`,
      );
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
    const body: Record<string, unknown> = { result, result_summary: resultSummary };
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

  /** Shared signed-POST driver for approve / cancel / complete / fail. */
  private async workflowAction(
    id: string,
    action: 'approve' | 'cancel' | 'complete' | 'fail',
    body?: Record<string, unknown>,
  ): Promise<WorkflowTask> {
    const raw = await this.call<{ task?: WorkflowTask }>(
      'POST',
      `/v1/workflow/tasks/${encodeURIComponent(id)}/${action}`,
      undefined,
      body ?? {},
      `${action}WorkflowTask(id=${id})`,
    );
    if (raw.task === undefined) {
      throw new Error(
        `HttpCoreTransport: ${action}WorkflowTask response missing task`,
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
    if (params.sampleItemId !== undefined && params.sampleItemId !== '') {
      body.sample_item_id = params.sampleItemId;
    }
    const raw = await this.call<{
      status?: 'ok' | 'skipped';
      canonical?: string;
      reason?: string;
    }>(
      'POST',
      '/v1/memory/topic/touch',
      undefined,
      body,
      `memoryTouch(persona=${params.persona}, topic=${params.topic})`,
    );
    const out: MemoryTouchResult = { status: raw.status ?? 'ok' };
    if (typeof raw.canonical === 'string') out.canonical = raw.canonical;
    if (typeof raw.reason === 'string') out.reason = raw.reason;
    return out;
  }

  async findContactsByPreference(category: string): Promise<Contact[]> {
    const clean = typeof category === 'string' ? category.trim() : '';
    if (clean === '') return [];
    let raw: { contacts?: unknown };
    try {
      raw = await this.call<{ contacts?: unknown }>(
        'GET',
        '/v1/contacts/by-preference',
        { category: clean },
        undefined,
        `findContactsByPreference(category=${clean})`,
      );
    } catch {
      // Fail-soft: the reasoning agent's tool is documented to fall
      // back to `search_provider_services` on an empty result, so
      // silent no-op here keeps the LLM out of a defensive error branch.
      return [];
    }
    return Array.isArray(raw.contacts) ? (raw.contacts as Contact[]) : [];
  }

  async updateContact(did: string, updates: UpdateContactParams): Promise<void> {
    if (typeof did !== 'string' || did.trim() === '') {
      throw new Error('updateContact: did is required');
    }
    const body: Record<string, unknown> = {};
    if (updates.preferredFor !== undefined) {
      body.preferred_for = [...updates.preferredFor];
    }
    await this.call<unknown>(
      'PUT',
      `/v1/contacts/${encodeURIComponent(did.trim())}`,
      undefined,
      body,
      `updateContact(did=${did})`,
    );
  }

  // -------------------------------------------------------------------------
  // Private dispatch helpers
  // -------------------------------------------------------------------------

  /** Signed request + JSON-parse + 2xx assertion. */
  private async call<T>(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown | undefined,
    ctx: string,
  ): Promise<T> {
    const res = await this.callRaw(method, path, query, body);
    return this.parseOk<T>(res, ctx);
  }

  /** Signed request, returns raw HttpResponse without 2xx enforcement.
   *  Used by callers that need to branch on specific non-2xx (e.g.
   *  `serviceConfig` treats 404 as "no config set" → null). */
  private async callRaw(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown | undefined,
  ): Promise<HttpResponse> {
    const queryString = query !== undefined ? buildQueryString(query) : '';
    const bodyBytes =
      body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));

    const signed = await this.signer({ method, path, query: queryString, body: bodyBytes });

    const url = this.baseUrl + path + (queryString !== '' ? '?' + queryString : '');
    const headers: Record<string, string> = {
      'x-did': signed.did,
      'x-timestamp': signed.timestamp,
      'x-nonce': signed.nonce,
      'x-signature': signed.signature,
    };
    const init: HttpRequestInit = { method, headers };
    if (bodyBytes.byteLength > 0) {
      init.body = bodyBytes;
      headers['content-type'] = 'application/json';
    }
    return this.httpClient.request(url, init);
  }

  /** Decode JSON body + throw on non-2xx. Surfaces Core errors to Brain. */
  private parseOk<T>(res: HttpResponse, ctx: string): T {
    const text = res.body.byteLength > 0 ? new TextDecoder().decode(res.body) : '';
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `HttpCoreTransport: ${ctx} returned non-JSON body (status ${res.status})`,
        );
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (parsed as { error?: string } | undefined)?.error ?? 'no error field';
      throw new Error(`HttpCoreTransport: ${ctx} failed ${res.status} — ${err}`);
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * URL-encode a flat string map into a query string. Stable key order
 * (sorted) so the canonical-signing path stays deterministic — the
 * signer sees the same query string this function builds. No leading
 * `?`; caller prepends.
 */
/**
 * Narrow the wire's `code` string to the `WorkflowConflictError.code`
 * union — unknown values collapse to `duplicate_id` (default).
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

function buildQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');
}

/**
 * Uint8Array → base64 without a Buffer dep. Uses the built-in
 * `btoa(String.fromCharCode(...bytes))` path. Safe for the payload
 * sizes we round-trip through /v1/did/sign (a few KB at most).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Small chunks to avoid arg-limit crashes on large inputs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  const btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (btoa !== undefined) return btoa(binary);

  // Node before 16 lacks globalThis.btoa; fall back via Buffer when
  // present. @dina/core doesn't depend on Node, but this path keeps
  // tests working when running under jest+node.
  const buffer = (
    globalThis as {
      Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
    }
  ).Buffer;
  if (buffer !== undefined) return buffer.from(binary, 'binary').toString('base64');
  throw new Error('No base64 encoder available in this runtime');
}
