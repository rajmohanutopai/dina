/**
 * `BrowserCoreProxyClient` — the WEB build's `CoreClient`.
 *
 * On web, Dina is a **thin client** of a home-node-lite brain-server: the
 * browser does NOT boot an in-process node (no `createCoreRouter`, no
 * SQLite, no in-browser Brain). Instead every `CoreClient` call becomes an
 * **unsigned, same-origin** HTTP request to the brain-server's `/api/v1/*`
 * proxy routes, which forward to core-server through the brain's *signed*
 * `HttpCoreTransport`. (Web thin-client design §4.)
 *
 * **This is NOT `HttpCoreTransport`.** `HttpCoreTransport` is the
 * Brain→Core hop and it SIGNS every request with Brain's Ed25519 service
 * key. The browser must hold no signing key, so this client is unsigned
 * and talks only to the brain-server (same origin as the served bundle),
 * never directly to core-server. Mixing the two would leak a key into the
 * browser or let the SPA bypass the brain.
 *
 * **Migration in progress.** Only the domains whose brain-server proxy
 * routes exist are wired here; every other `CoreClient` method throws
 * `notProxied(...)` — a loud, greppable signal to add its `/api/v1` route
 * (+ wire it here) when its phase lands, rather than a silent wrong
 * answer. Wired today: identity, vault (query/get/store/list/subjects/
 * delete), personas (list/status).
 */

import { defaultFetch } from '../runtime/fetch';

import type {
  ActionPolicyEntry,
  ActionPolicyResult,
  ApplyExtractionResponse,
  CanonicalSignRequest,
  Contact,
  ContactAddResult,
  CoreClient,
  CoreHealth,
  CreateWorkflowTaskInput,
  CreateWorkflowTaskResult,
  DeviceRole,
  ExtractionResult,
  FailWorkflowEventOptions,
  ListWorkflowEventsOptions,
  ListWorkflowTasksFilter,
  MemoryToCOptions,
  MemoryToCResult,
  MemoryTouchParams,
  MemoryTouchResult,
  MsgSendRequest,
  MsgSendResult,
  NotifyRequest,
  NotifyResult,
  PairedDevice,
  PairInitiateResult,
  PersonaListEntry,
  PersonaStatusResult,
  PersonaUnlockResult,
  Person,
  PIIRehydrateResult,
  PIIScrubResult,
  Reminder,
  ReminderCreateInput,
  RiskLevel,
  ScratchpadCheckpointResult,
  ScratchpadClearResult,
  ScratchpadEntry,
  ServiceConfig,
  ServiceListing,
  ServiceOfferView,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  ServiceRespondRequestBody,
  ServiceRespondResult,
  SignedHeaders,
  SignResult,
  StagingClaimResult,
  StagingExtendLeaseResult,
  StagingFailResult,
  StagingIngestRequest,
  StagingIngestResult,
  StagingResolveRequest,
  StagingResolveResult,
  TrustLevel,
  UpdateContactParams,
  VaultDeleteResult,
  VaultItemInput,
  VaultListOptions,
  VaultListResult,
  VaultQuery,
  VaultQueryItem,
  VaultQueryResult,
  VaultStoreResult,
  WorkflowEvent,
  WorkflowTask,
} from './core-client';
import type { NodeIdentity } from '../pairing/ceremony';

export interface BrowserCoreProxyClientOptions {
  /**
   * Brain-server proxy base. Same-origin relative path by default
   * (`/api/v1`) — the SPA is served by the brain-server, so a relative
   * base needs no host/CORS. Tests pass an absolute URL + a stub fetch.
   */
  baseUrl?: string;
  /** Injected fetch (tests stub it). Defaults to the platform-bound global. */
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** When true, a 404 resolves to `null` instead of throwing (e.g. vaultGet). */
  allow404?: boolean;
}

export class BrowserCoreProxyClient implements CoreClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: BrowserCoreProxyClientOptions = {}) {
    // Strip a trailing slash so `${baseUrl}${path}` (path starts with `/`)
    // never doubles up.
    this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? defaultFetch();
  }

  // ─── HTTP plumbing ─────────────────────────────────────────────────────

  private buildUrl(path: string, query?: Record<string, string>): string {
    const base = `${this.baseUrl}${path}`;
    if (query === undefined) return base;
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return qs === '' ? base : `${base}?${qs}`;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    // `credentials: 'same-origin'` so the brain's HttpOnly SameSite=Strict
    // web-session cookie (web access gate, design D4) is attached. This is
    // also the fetch default, but we set it explicitly so the gate can't be
    // silently broken by a runtime whose default differs.
    const res = await this.fetchFn(url, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body } : {}),
    });

    if (opts.allow404 === true && res.status === 404) {
      return null as T;
    }
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as unknown;
        if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
          detail = String((parsed as { error: unknown }).error);
        }
      } catch {
        /* non-JSON error body — status alone is the signal */
      }
      throw new Error(
        `BrowserCoreProxyClient: ${method} ${path} failed ${res.status}${
          detail === '' ? '' : ` — ${detail}`
        }`,
      );
    }
    const text = await res.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /**
   * Loud signal for a `CoreClient` method whose brain-server proxy route
   * has not been built yet. Throws (never silently degrades) so a UI path
   * that needs an un-migrated method fails visibly during development with
   * a greppable message, rather than returning a wrong/empty answer.
   */
  private notProxied(method: string): never {
    throw new Error(
      `BrowserCoreProxyClient: ${method}() is not proxied to the brain-server yet ` +
        `(web thin-client migration in progress). Add a /api/v1 proxy route for it, ` +
        `then wire it in browser-core-proxy-client.ts.`,
    );
  }

  // ─── Wired: identity ───────────────────────────────────────────────────

  async identity(): Promise<NodeIdentity> {
    return this.request<NodeIdentity>('GET', '/identity');
  }

  // ─── Wired: vault ──────────────────────────────────────────────────────

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    const body: Record<string, unknown> = {};
    if (query.text !== undefined) body.text = query.text;
    if (query.mode !== undefined) body.mode = query.mode;
    if (query.limit !== undefined) body.limit = query.limit;
    if (query.embedding !== undefined) body.embedding = query.embedding;
    if (query.type !== undefined) body.type = query.type;
    return this.request<VaultQueryResult>('POST', '/vault/query', { query: { persona }, body });
  }

  async vaultGet(persona: string, itemId: string): Promise<VaultQueryItem | null> {
    return this.request<VaultQueryItem | null>(
      'GET',
      `/vault/item/${encodeURIComponent(itemId)}`,
      { query: { persona }, allow404: true },
    );
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    return this.request<VaultStoreResult>('POST', '/vault/store', { query: { persona }, body: item });
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    const query: Record<string, string> = { persona };
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.offset !== undefined) query.offset = String(opts.offset);
    if (opts?.type !== undefined) query.type = opts.type;
    return this.request<VaultListResult>('GET', '/vault/list', { query });
  }

  async vaultItemsForPerson(
    persona: string,
    personId: string,
    limit: number,
  ): Promise<VaultQueryItem[]> {
    const res = await this.request<{ items?: VaultQueryItem[] }>('GET', '/vault/subjects', {
      query: { persona, person_id: personId, limit: String(limit) },
    });
    return Array.isArray(res.items) ? res.items : [];
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    return this.request<VaultDeleteResult>('DELETE', `/vault/item/${encodeURIComponent(itemId)}`, {
      query: { persona },
    });
  }

  // ─── Wired: personas (read) ────────────────────────────────────────────

  async personasList(): Promise<PersonaListEntry[]> {
    const res = await this.request<{ personas?: PersonaListEntry[] }>('GET', '/personas');
    return Array.isArray(res.personas) ? res.personas : [];
  }

  async personaStatus(_persona: string): Promise<PersonaStatusResult> {
    // No `/api/v1/personas/:p/status` proxy: the TS core registers no
    // persona-status route and the web switcher reads tier+isOpen from
    // `personasList()`. Throw rather than hit a 404 endpoint.
    return this.notProxied('personaStatus');
  }

  // ─── Not yet proxied (throw until their phase lands) ────────────────────
  //
  // Liveness on web is `identity()` (the brain proxy), not Core's healthz —
  // the browser cannot reach core-server directly and the brain's own
  // `/healthz` is a different shape (no did/version).
  async healthz(): Promise<CoreHealth> {
    return this.notProxied('healthz');
  }

  async personaUnlock(_persona: string, _passphrase: string): Promise<PersonaUnlockResult> {
    // Passphrase-over-the-wire is gated behind the web access model (P3).
    return this.notProxied('personaUnlock');
  }

  async didSign(_payload: Uint8Array): Promise<SignResult> {
    return this.notProxied('didSign');
  }

  async didSignCanonical(_req: CanonicalSignRequest): Promise<SignedHeaders> {
    return this.notProxied('didSignCanonical');
  }

  async piiScrub(_text: string): Promise<PIIScrubResult> {
    return this.notProxied('piiScrub');
  }

  async piiRehydrate(_sessionId: string, _text: string): Promise<PIIRehydrateResult> {
    return this.notProxied('piiRehydrate');
  }

  async notify(_notification: NotifyRequest): Promise<NotifyResult> {
    return this.notProxied('notify');
  }

  // ─── Wired: service-config (P2) ─────────────────────────────────────────

  async serviceConfig(rkey?: string): Promise<ServiceConfig | null> {
    const path = rkey === undefined ? '/service/config' : `/service/config/${encodeURIComponent(rkey)}`;
    return this.request<ServiceConfig | null>('GET', path, { allow404: true });
  }

  async listServiceConfigs(): Promise<ServiceListing[]> {
    const res = await this.request<{ listings?: ServiceListing[] }>('GET', '/service/configs');
    return Array.isArray(res.listings) ? res.listings : [];
  }

  async putServiceConfig(config: ServiceConfig, rkey?: string): Promise<void> {
    const path = rkey === undefined ? '/service/config' : `/service/config/${encodeURIComponent(rkey)}`;
    await this.request<unknown>('PUT', path, { body: config });
  }

  async deleteServiceConfig(rkey: string): Promise<void> {
    await this.request<unknown>('DELETE', `/service/config/${encodeURIComponent(rkey)}`);
  }

  // ─── Not yet proxied (continued) ────────────────────────────────────────

  async sendServiceQuery(_req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    return this.notProxied('sendServiceQuery');
  }

  async memoryToC(_opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    return this.notProxied('memoryToC');
  }

  async stagingIngest(_req: StagingIngestRequest): Promise<StagingIngestResult> {
    return this.notProxied('stagingIngest');
  }

  async stagingClaim(_limit: number): Promise<StagingClaimResult> {
    return this.notProxied('stagingClaim');
  }

  async stagingResolve(_req: StagingResolveRequest): Promise<StagingResolveResult> {
    return this.notProxied('stagingResolve');
  }

  async stagingFail(_itemId: string, _reason: string): Promise<StagingFailResult> {
    return this.notProxied('stagingFail');
  }

  async stagingExtendLease(_itemId: string, _seconds: number): Promise<StagingExtendLeaseResult> {
    return this.notProxied('stagingExtendLease');
  }

  async msgSend(_req: MsgSendRequest): Promise<MsgSendResult> {
    return this.notProxied('msgSend');
  }

  async scratchpadCheckpoint(
    _taskId: string,
    _step: number,
    _context: Record<string, unknown>,
  ): Promise<ScratchpadCheckpointResult> {
    return this.notProxied('scratchpadCheckpoint');
  }

  async scratchpadResume(_taskId: string): Promise<ScratchpadEntry | null> {
    return this.notProxied('scratchpadResume');
  }

  async scratchpadClear(_taskId: string): Promise<ScratchpadClearResult> {
    return this.notProxied('scratchpadClear');
  }

  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    // Inbox deny→notify path: the brain proxies POST /service/respond to
    // Core, which sends the requester the `unavailable` service.response.
    // Mirrors the http-transport body + response parsing exactly.
    const raw = await this.request<{
      status?: string;
      task_id?: string;
      already_processed?: boolean;
    }>('POST', '/service/respond', {
      body: { task_id: taskId, response_body: responseBody },
    });
    return {
      status: typeof raw.status === 'string' ? raw.status : '',
      taskId: typeof raw.task_id === 'string' ? raw.task_id : taskId,
      alreadyProcessed: raw.already_processed === true,
    };
  }

  async listWorkflowEvents(_opts?: ListWorkflowEventsOptions): Promise<WorkflowEvent[]> {
    return this.notProxied('listWorkflowEvents');
  }

  async acknowledgeWorkflowEvent(_eventId: number): Promise<boolean> {
    return this.notProxied('acknowledgeWorkflowEvent');
  }

  async failWorkflowEventDelivery(
    _eventId: number,
    _opts?: FailWorkflowEventOptions,
  ): Promise<boolean> {
    return this.notProxied('failWorkflowEventDelivery');
  }

  // ─── Wired: workflow / approvals inbox (P2) ─────────────────────────────

  async listWorkflowTasks(filter: ListWorkflowTasksFilter): Promise<WorkflowTask[]> {
    const query: Record<string, string> = { kind: filter.kind, state: filter.state };
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    const res = await this.request<{ tasks?: WorkflowTask[] }>('GET', '/workflow/tasks', { query });
    return Array.isArray(res.tasks) ? res.tasks : [];
  }

  async getWorkflowTask(id: string): Promise<WorkflowTask | null> {
    const res = await this.request<{ task?: WorkflowTask } | null>(
      'GET',
      `/workflow/tasks/${encodeURIComponent(id)}`,
      { allow404: true },
    );
    return res?.task ?? null;
  }

  async approveWorkflowTask(
    id: string,
    opts?: { scope?: 'single' | 'session' },
  ): Promise<WorkflowTask> {
    const res = await this.request<{ task: WorkflowTask }>(
      'POST',
      `/workflow/tasks/${encodeURIComponent(id)}/approve`,
      { body: opts?.scope !== undefined ? { scope: opts.scope } : {} },
    );
    return res.task;
  }

  async cancelWorkflowTask(id: string, reason?: string): Promise<WorkflowTask> {
    const res = await this.request<{ task: WorkflowTask }>(
      'POST',
      `/workflow/tasks/${encodeURIComponent(id)}/cancel`,
      { body: reason !== undefined && reason !== '' ? { reason } : {} },
    );
    return res.task;
  }

  // ─── Not yet proxied (continued) ────────────────────────────────────────

  async createWorkflowTask(_input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult> {
    return this.notProxied('createWorkflowTask');
  }

  async completeWorkflowTask(
    _id: string,
    _result: string,
    _resultSummary: string,
    _agentDID?: string,
  ): Promise<WorkflowTask> {
    return this.notProxied('completeWorkflowTask');
  }

  async failWorkflowTask(_id: string, _errorMsg: string, _agentDID?: string): Promise<WorkflowTask> {
    return this.notProxied('failWorkflowTask');
  }

  async memoryTouch(_params: MemoryTouchParams): Promise<MemoryTouchResult> {
    return this.notProxied('memoryTouch');
  }

  // ─── Wired: contacts (P2) ───────────────────────────────────────────────

  async updateContact(did: string, updates: UpdateContactParams): Promise<void> {
    const cleanDid = typeof did === 'string' ? did.trim() : '';
    if (cleanDid === '') throw new Error('updateContact: did is required');
    const body: Record<string, unknown> = {};
    // Tri-state: only include the field when explicitly passed (`[]` = clear).
    if (updates.preferredFor !== undefined) body.preferred_for = [...updates.preferredFor];
    await this.request<unknown>('PUT', `/contacts/${encodeURIComponent(cleanDid)}`, { body });
  }

  async findContactsByPreference(category: string): Promise<Contact[]> {
    const clean = typeof category === 'string' ? category.trim() : '';
    if (clean === '') return [];
    try {
      const raw = await this.request<{ contacts?: Contact[] }>('GET', '/contacts/by-preference', {
        query: { category: clean },
      });
      return Array.isArray(raw.contacts) ? raw.contacts : [];
    } catch {
      return []; // fail-soft (matches the in-process + http transports)
    }
  }

  async contactLookup(query: string): Promise<Contact | null> {
    const clean = typeof query === 'string' ? query.trim() : '';
    if (clean === '') return null;
    try {
      const raw = await this.request<{ contact?: Contact | null }>('GET', '/contacts/lookup', {
        query: { q: clean },
      });
      return raw.contact ?? null;
    } catch {
      return null; // fail-soft
    }
  }

  async contactList(): Promise<Contact[]> {
    try {
      const raw = await this.request<{ contacts?: Contact[] }>('GET', '/contacts');
      return Array.isArray(raw.contacts) ? raw.contacts : [];
    } catch {
      return []; // fail-soft
    }
  }

  async contactAdd(
    did: string,
    displayName: string,
    trustLevel?: TrustLevel,
  ): Promise<ContactAddResult> {
    const cleanDid = typeof did === 'string' ? did.trim() : '';
    if (cleanDid === '') throw new Error('contactAdd: did is required');
    const body: Record<string, unknown> = { did: cleanDid, display_name: displayName };
    if (trustLevel !== undefined) body.trust_level = trustLevel;
    // A mutation: surface failures (do NOT fail-soft).
    return this.request<ContactAddResult>('POST', '/contacts', { body });
  }

  async contactDelete(did: string): Promise<boolean> {
    const cleanDid = typeof did === 'string' ? did.trim() : '';
    if (cleanDid === '') return false;
    try {
      const raw = await this.request<{ deleted?: boolean }>(
        'DELETE',
        `/contacts/${encodeURIComponent(cleanDid)}`,
      );
      return raw.deleted === true;
    } catch {
      return false; // fail-soft (idempotent — re-deleting is not an error)
    }
  }

  async listServiceOffers(_params?: {
    providerDid?: string;
    capability?: string;
  }): Promise<ServiceOfferView[]> {
    return this.notProxied('listServiceOffers');
  }

  // peopleApplyExtraction is a Brain-internal post-publish WRITE path, never a
  // web concern — stays loud-stubbed.
  async peopleApplyExtraction(
    _result: ExtractionResult,
    _persona?: string,
  ): Promise<ApplyExtractionResponse> {
    return this.notProxied('peopleApplyExtraction');
  }

  // ─── Wired: people graph / Relations tab (P2) ───────────────────────────

  async peopleList(): Promise<Person[]> {
    try {
      const raw = await this.request<{ people?: Person[] }>('GET', '/people');
      return Array.isArray(raw.people) ? raw.people : [];
    } catch {
      return []; // fail-soft (matches the in-process + http transports)
    }
  }

  async peopleFindByName(surface: string): Promise<Person[]> {
    const clean = typeof surface === 'string' ? surface.trim() : '';
    if (clean === '') return [];
    try {
      const raw = await this.request<{ people?: Person[] }>('GET', '/people/find', {
        query: { surface: clean },
      });
      return Array.isArray(raw.people) ? raw.people : [];
    } catch {
      return [];
    }
  }

  async peopleResolveByDid(did: string): Promise<Person | null> {
    const clean = typeof did === 'string' ? did.trim() : '';
    if (clean === '') return null;
    try {
      const raw = await this.request<{ person?: Person | null }>('GET', '/people/by-did', {
        query: { did: clean },
      });
      return raw.person ?? null;
    } catch {
      return null;
    }
  }

  async reminderCreate(_input: ReminderCreateInput): Promise<Reminder> {
    return this.notProxied('reminderCreate');
  }

  async reminderListByPersona(_persona: string): Promise<Reminder[]> {
    return this.notProxied('reminderListByPersona');
  }

  async reminderListPending(_now?: number): Promise<Reminder[]> {
    return this.notProxied('reminderListPending');
  }

  async reminderComplete(_id: string): Promise<Reminder | null> {
    return this.notProxied('reminderComplete');
  }

  async reminderSnooze(_id: string, _snoozeMs: number): Promise<Reminder | null> {
    return this.notProxied('reminderSnooze');
  }

  async reminderDelete(_id: string): Promise<boolean> {
    return this.notProxied('reminderDelete');
  }

  async reminderFireMissed(_now?: number): Promise<Reminder[]> {
    return this.notProxied('reminderFireMissed');
  }

  // ─── Wired: devices / pairing (P5) ──────────────────────────────────────
  // `listPairedDevices` + `pairInitiate` proxy to the brain (both core routes
  // admit the brain caller). Device REVOKE/register stay admin-only on core and
  // are intentionally NOT on this surface — the browser session is not an admin
  // credential.

  async pairInitiate(deviceName: string, role: DeviceRole): Promise<PairInitiateResult> {
    const name = typeof deviceName === 'string' ? deviceName.trim() : '';
    if (name === '') throw new Error('pairInitiate: deviceName is required');
    // A mutation (mints a pairing code) — surface failures, do NOT fail-soft.
    return this.request<PairInitiateResult>('POST', '/pair/initiate', {
      body: { device_name: name, role },
    });
  }

  async listPairedDevices(): Promise<PairedDevice[]> {
    try {
      const raw = await this.request<{ devices?: PairedDevice[] }>('GET', '/devices/list');
      return Array.isArray(raw.devices) ? raw.devices : [];
    } catch {
      return []; // fail-soft (matches the in-process + http transports)
    }
  }

  // ─── Wired: action-risk policy (P3) ─────────────────────────────────────

  async getActionPolicy(): Promise<ActionPolicyResult> {
    return this.request<ActionPolicyResult>('GET', '/policy/actions');
  }

  async setActionRisk(action: string, risk: RiskLevel): Promise<ActionPolicyEntry> {
    return this.request<ActionPolicyEntry>('PUT', `/policy/actions/${encodeURIComponent(action)}`, {
      body: { risk },
    });
  }

  async deleteActionOverride(action: string): Promise<void> {
    await this.request<unknown>('DELETE', `/policy/actions/${encodeURIComponent(action)}`);
  }
}
