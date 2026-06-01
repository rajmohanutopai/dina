/**
 * MockCoreClient — test double for the `CoreClient` transport-agnostic
 * interface defined in `@dina/core`.
 *
 * Real Brain code gets `InProcessTransport` on mobile and
 * `HttpCoreTransport` on server; Brain tests get `MockCoreClient`
 * here: zero I/O, zero crypto, call-recording + configurable canned
 * responses per method.
 *
 * Pattern matches the rest of `@dina/test-harness/src/mocks/`:
 *   - Public mutable fields for tests to configure response payloads.
 *   - `calls: RecordedCall[]` captures every invocation for assertions.
 *   - `throwOn: Record<methodName, Error>` injects failures per-method.
 *
 * For richer behavior (per-persona vault results, per-queryId service
 * responses), tests subclass this and override the method they need.
 * The base class stays dumb on purpose — it's a stub, not a simulator.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.34.
 */

import { WorkflowConflictError } from '@dina/core';

import type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultQueryItem,
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
  ServiceListing,
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
  ExtractionResult,
  ApplyExtractionResponse,
  Person,
  Reminder,
  ReminderCreateInput,
  PersonaListEntry,
  ActionPolicyEntry,
  ActionPolicyResult,
  RiskLevel,
} from '@dina/core';

/** One captured call — method name + positional args passed. */
export interface RecordedCall {
  method: keyof CoreClient;
  args: unknown[];
}

/**
 * Identifies the methods on CoreClient that can have `throwOn` entries.
 * Using a narrow union (not `string`) makes typos fail compile.
 */
export type CoreClientMethodName = keyof CoreClient;

export class MockCoreClient implements CoreClient {
  /** Every call the mock has seen, in order. Cleared by `reset()`. */
  readonly calls: RecordedCall[] = [];

  /** When `throwOn[method]` is set, the mock throws that Error instead
   *  of returning. Use for exercising error-path code without needing
   *  a subclass. */
  throwOn: Partial<Record<CoreClientMethodName, Error>> = {};

  // ─── Canned responses ─────────────────────────────────────────────────
  // Tests mutate these before the method-under-test runs.

  healthResult: CoreHealth = {
    status: 'ok',
    did: 'did:key:mock-core',
    version: '0.0.0-test',
  };
  vaultQueryResult: VaultQueryResult = { items: [], count: 0 };
  vaultGetResult: VaultQueryItem | null = null;
  /** Override for `vaultItemsForPerson`'s return value. */
  vaultItemsForPersonResult: VaultQueryItem[] = [];
  vaultStoreResult: VaultStoreResult = {
    id: 'mock-item-id',
    storedAt: '2026-04-21T00:00:00Z',
  };
  vaultListResult: VaultListResult = { items: [], count: 0, total: 0 };
  vaultDeleteResult: VaultDeleteResult = { deleted: true };
  signResult: SignResult = { signature: 'mock-signature', did: 'did:key:mock-core' };
  canonicalSignResult: SignedHeaders = {
    did: 'did:key:mock-core',
    timestamp: '2026-04-21T12:00:00Z',
    nonce: 'mock-nonce-hex0',
    signature: 'mock-canonical-signature',
  };
  piiScrubResult: PIIScrubResult = {
    scrubbed: '',
    sessionId: 'mock-pii-session',
    entityCount: 0,
  };
  piiRehydrateResult: PIIRehydrateResult = {
    rehydrated: '',
    sessionFound: true,
  };
  notifyResult: NotifyResult = {
    accepted: true,
    notificationId: 'mock-notif-id',
    subscribers: 1,
  };
  personaStatusResult: PersonaStatusResult = {
    persona: 'personal',
    tier: 'default',
    open: true,
    dekFingerprint: 'mockfp12',
    openedAt: 1776700000,
  };
  personaUnlockResult: PersonaUnlockResult = {
    persona: 'financial',
    unlocked: true,
    dekFingerprint: 'mockfpAB',
  };
  /** The default `self` listing. Authoritative for `serviceConfig()` /
   *  `serviceConfig('self')` and the `self` row of `listServiceConfigs()`. */
  serviceConfigResult: ServiceConfig | null = null;
  /** Non-`self` listings, keyed by rkey (multi-listing per DID). Kept
   *  separate from `serviceConfigResult` so there's exactly one source of
   *  truth per rkey — `self` lives in the field, everything else here. */
  serviceListingsByRkey = new Map<string, ServiceConfig>();
  serviceQueryResult: ServiceQueryResult = {
    taskId: 'mock-task-id',
    queryId: 'mock-query-id',
  };
  memoryToCResult: MemoryToCResult = { entries: [], limit: 50 };
  stagingIngestResult: StagingIngestResult = {
    itemId: 'mock-staging-item',
    duplicate: false,
    status: 'received',
  };
  stagingClaimResult: StagingClaimResult = { items: [], count: 0 };
  stagingResolveResult: StagingResolveResult = {
    itemId: 'mock-staging-item',
    status: 'stored',
  };
  stagingFailResult: StagingFailResult = {
    itemId: 'mock-staging-item',
    retryCount: 1,
  };
  stagingExtendLeaseResult: StagingExtendLeaseResult = {
    itemId: 'mock-staging-item',
    extendedBySeconds: 300,
  };
  msgSendResult: MsgSendResult = { ok: true };
  serviceRespondResult: ServiceRespondResult = {
    status: 'sent',
    taskId: 'mock-task-id',
    alreadyProcessed: false,
  };
  /**
   * Buffer of events `listWorkflowEvents` returns. Tests seed this
   * directly; the mock also honours the `since` / `needsDeliveryOnly`
   * filters so a single seed can drive multiple test scenarios.
   */
  workflowEvents: WorkflowEvent[] = [];
  /** Return value for `acknowledgeWorkflowEvent` / `failWorkflowEventDelivery`. */
  workflowEventAckResult = true;
  workflowEventFailResult = true;
  /**
   * In-memory scratchpad store so `scratchpadCheckpoint` → `scratchpadResume`
   * round-trips work under default config. Tests that want a specific
   * entry can seed directly via `scratchpadStore.set(taskId, entry)`, or
   * override via `throwOn` / a subclass.
   */
  readonly scratchpadStore = new Map<string, ScratchpadEntry>();
  /** IDs passed to `acknowledgeWorkflowEvent` / `failWorkflowEventDelivery` —
   *  test assertions verify retire order without walking the call log. */
  readonly ackedEventIds: number[] = [];
  readonly failedEventIds: number[] = [];
  /**
   * Workflow tasks buffer — tests seed this directly; `createWorkflowTask`
   * pushes new rows; the state-transition methods mutate in-place.
   * `listWorkflowTasks` + `getWorkflowTask` read from here. The buffer
   * is `readonly` at the slot level so tests can append / mutate
   * without reassigning (shared reference safety).
   */
  readonly workflowTasks: WorkflowTask[] = [];
  /** Touch requests the enrichment pipeline emitted. Tests assert on
   *  this to verify per-topic side-effects without walking `calls[]`. */
  readonly memoryTouches: MemoryTouchParams[] = [];
  /**
   * Override for `memoryTouch`'s return value — tests that exercise
   * the locked-persona `{status: 'skipped', reason}` path mutate this
   * before the call. Default (`undefined`) → mock returns
   * `{status: 'ok', canonical: topic}` for happy-path tests.
   */
  memoryTouchResult?: MemoryTouchResult;
  /** Extraction results recorded by `peopleApplyExtraction`. */
  readonly peopleExtractions: ExtractionResult[] = [];
  /** Override for `peopleApplyExtraction`'s return value. */
  peopleApplyExtractionResult?: ApplyExtractionResponse;
  /** Canned return value for `personasList()`. Empty by default. */
  personasListResult: PersonaListEntry[] = [];
  /** Canned people list — drives both `peopleList()` and the
   *  filter inside `peopleFindByName()` (matches against
   *  `surfaces[*].normalizedSurface`). Empty by default. */
  peopleListResult: Person[] = [];
  /** Per-contact updates — tests assert `{did, preferredFor}` binds fired. */
  readonly contactUpdates: { did: string; updates: UpdateContactParams }[] = [];
  /** Per-category canned result for `findContactsByPreference` — tests
   *  seed `{'dental': [...Dr Carl...]}` before the reasoning agent
   *  triggers the role-match branch. Keys are compared after
   *  trim + lowercase (matching the route's normalisation). */
  contactsByPreferenceResult: Record<string, Contact[]> = {};
  /** Per-query canned result for `contactLookup` — keys compared after
   *  trim + lowercase. Unmatched query → null (no contact). */
  contactLookupResult: Record<string, Contact> = {};
  actionPolicyResult: ActionPolicyResult = { actions: [] };

  /**
   * In-memory reminder store backing `reminderCreate` /
   * `reminderListByPersona` / `reminderListPending`. Functional enough
   * that a create-then-read round-trip works in Brain backend-routing
   * tests (the real Core route mutates Core's authoritative store; the
   * mock mutates this array). Dedups on (source_item_id, kind, due_at,
   * persona) to mirror the service.
   */
  readonly reminders: Reminder[] = [];
  private reminderSeq = 0;

  /**
   * Per-persona override for `personaStatus`. When a tested code path
   * needs different tiers per persona (common for gatekeeper tests),
   * populate this map; unmatched personas fall back to `personaStatusResult`.
   */
  personaStatusByName: Record<string, PersonaStatusResult> = {};

  /** Drop all recorded calls + re-empty the override maps. */
  reset(): void {
    this.calls.length = 0;
    this.throwOn = {};
    this.personaStatusByName = {};
    this.serviceListingsByRkey.clear();
    this.scratchpadStore.clear();
    this.workflowEvents = [];
    this.ackedEventIds.length = 0;
    this.failedEventIds.length = 0;
    this.workflowTasks.length = 0;
    this.memoryTouches.length = 0;
    this.contactUpdates.length = 0;
    this.memoryTouchResult = undefined;
    this.peopleExtractions.length = 0;
    this.peopleApplyExtractionResult = undefined;
    this.personasListResult.length = 0;
    this.peopleListResult.length = 0;
    this.reminders.length = 0;
    this.reminderSeq = 0;
  }

  /** Count how many times a given method was called. */
  callCountOf(method: CoreClientMethodName): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  // ─── CoreClient implementation ────────────────────────────────────────

  async healthz(): Promise<CoreHealth> {
    return this.dispatch('healthz', [], () => this.healthResult);
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    return this.dispatch('vaultQuery', [persona, query], () => this.vaultQueryResult);
  }

  async vaultGet(persona: string, itemId: string): Promise<VaultQueryItem | null> {
    return this.dispatch('vaultGet', [persona, itemId], () => this.vaultGetResult);
  }

  async vaultItemsForPerson(
    persona: string,
    personId: string,
    limit: number,
  ): Promise<VaultQueryItem[]> {
    return this.dispatch(
      'vaultItemsForPerson',
      [persona, personId, limit],
      () => this.vaultItemsForPersonResult,
    );
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    return this.dispatch('vaultStore', [persona, item], () => this.vaultStoreResult);
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    return this.dispatch('vaultList', [persona, opts], () => this.vaultListResult);
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    return this.dispatch('vaultDelete', [persona, itemId], () => this.vaultDeleteResult);
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    return this.dispatch('didSign', [payload], () => this.signResult);
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    return this.dispatch('didSignCanonical', [req], () => this.canonicalSignResult);
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    return this.dispatch('piiScrub', [text], () => {
      // Pass-through default: if the test hasn't configured a custom
      // scrubbed string, echo the input so downstream prompts receive
      // intelligible text. Matches MockBrainClient's convention.
      if (this.piiScrubResult.scrubbed === '') {
        return { ...this.piiScrubResult, scrubbed: text };
      }
      return this.piiScrubResult;
    });
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    return this.dispatch('piiRehydrate', [sessionId, text], () => {
      // Pass-through default — mirrors piiScrub.
      if (this.piiRehydrateResult.rehydrated === '') {
        return { ...this.piiRehydrateResult, rehydrated: text };
      }
      return this.piiRehydrateResult;
    });
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    return this.dispatch('notify', [notification], () => this.notifyResult);
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    return this.dispatch('personaStatus', [persona], () => {
      const override = this.personaStatusByName[persona];
      if (override !== undefined) return override;
      return { ...this.personaStatusResult, persona };
    });
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    return this.dispatch('personaUnlock', [persona, passphrase], () => ({
      ...this.personaUnlockResult,
      persona,
    }));
  }

  async putServiceConfig(config: ServiceConfig, rkey?: string): Promise<void> {
    await this.dispatch('putServiceConfig', [config, rkey], () => {
      if (rkey === undefined || rkey === 'self') {
        this.serviceConfigResult = config;
      } else {
        this.serviceListingsByRkey.set(rkey, config);
      }
    });
  }

  async serviceConfig(rkey?: string): Promise<ServiceConfig | null> {
    return this.dispatch('serviceConfig', [rkey], () =>
      rkey === undefined || rkey === 'self'
        ? this.serviceConfigResult
        : (this.serviceListingsByRkey.get(rkey) ?? null),
    );
  }

  async listServiceConfigs(): Promise<ServiceListing[]> {
    return this.dispatch('listServiceConfigs', [], () => {
      const listings: ServiceListing[] = [];
      if (this.serviceConfigResult !== null) {
        listings.push({ rkey: 'self', config: this.serviceConfigResult });
      }
      for (const [rkey, config] of this.serviceListingsByRkey) {
        listings.push({ rkey, config });
      }
      return listings;
    });
  }

  async deleteServiceConfig(rkey: string): Promise<void> {
    await this.dispatch('deleteServiceConfig', [rkey], () => {
      if (rkey === 'self') {
        this.serviceConfigResult = null;
      } else {
        this.serviceListingsByRkey.delete(rkey);
      }
    });
  }

  async sendServiceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    return this.dispatch('sendServiceQuery', [req], () => ({
      ...this.serviceQueryResult,
      queryId: req.queryId,
    }));
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    return this.dispatch('memoryToC', [opts], () => this.memoryToCResult);
  }

  async stagingIngest(req: StagingIngestRequest): Promise<StagingIngestResult> {
    return this.dispatch('stagingIngest', [req], () => ({
      ...this.stagingIngestResult,
      itemId: this.stagingIngestResult.itemId || `mock-${req.sourceId}`,
    }));
  }

  async stagingClaim(limit: number): Promise<StagingClaimResult> {
    return this.dispatch('stagingClaim', [limit], () => this.stagingClaimResult);
  }

  async stagingResolve(req: StagingResolveRequest): Promise<StagingResolveResult> {
    // Echo the request's itemId onto the result so correlation
    // assertions in tests don't need per-call configuration — matches
    // the `serviceQuery → queryId` echo convention.
    return this.dispatch('stagingResolve', [req], () => ({
      ...this.stagingResolveResult,
      itemId: req.itemId,
    }));
  }

  async stagingFail(itemId: string, reason: string): Promise<StagingFailResult> {
    return this.dispatch('stagingFail', [itemId, reason], () => ({
      ...this.stagingFailResult,
      itemId,
    }));
  }

  async stagingExtendLease(
    itemId: string,
    seconds: number,
  ): Promise<StagingExtendLeaseResult> {
    return this.dispatch('stagingExtendLease', [itemId, seconds], () => ({
      ...this.stagingExtendLeaseResult,
      itemId,
      extendedBySeconds: seconds,
    }));
  }

  async msgSend(req: MsgSendRequest): Promise<MsgSendResult> {
    return this.dispatch('msgSend', [req], () => this.msgSendResult);
  }

  async scratchpadCheckpoint(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<ScratchpadCheckpointResult> {
    return this.dispatch('scratchpadCheckpoint', [taskId, step, context], () => {
      // step=0 is the Python delete sentinel — mirror the real service's
      // behavior so tests can exercise both the upsert + delete paths
      // without a subclass.
      if (step === 0) {
        this.scratchpadStore.delete(taskId);
      } else {
        const existing = this.scratchpadStore.get(taskId);
        const now = Date.now();
        this.scratchpadStore.set(taskId, {
          taskId,
          step,
          context,
          // createdAt preserved across upserts — matches the production repo.
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }
      return { taskId, step };
    });
  }

  async scratchpadResume(taskId: string): Promise<ScratchpadEntry | null> {
    return this.dispatch(
      'scratchpadResume',
      [taskId],
      () => this.scratchpadStore.get(taskId) ?? null,
    );
  }

  async scratchpadClear(taskId: string): Promise<ScratchpadClearResult> {
    return this.dispatch('scratchpadClear', [taskId], () => {
      this.scratchpadStore.delete(taskId);
      return { taskId };
    });
  }

  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    return this.dispatch('sendServiceRespond', [taskId, responseBody], () => ({
      // Echo the caller's taskId so correlation works without per-test
      // config — matches the `serviceQuery → queryId` convention.
      ...this.serviceRespondResult,
      taskId,
    }));
  }

  async listWorkflowEvents(opts: ListWorkflowEventsOptions = {}): Promise<WorkflowEvent[]> {
    return this.dispatch('listWorkflowEvents', [opts], () => {
      // Apply both filters in-mock so tests can seed ONE buffer + drive
      // consumer scenarios (page via `since`, distinguish hot-path via
      // `needsDeliveryOnly`). Real Core applies both server-side; the
      // mock mirrors the contract so Brain consumer tests observe
      // identical behaviour without a live Core.
      let events = this.workflowEvents;
      if (opts.since !== undefined) {
        const since = opts.since;
        events = events.filter((e) => e.event_id > since);
      }
      if (opts.needsDeliveryOnly === true) {
        // Real server filters acked + not-yet-due events. The mock
        // treats `needs_delivery && acknowledged_at === undefined` as
        // the consumer-relevant slice — matches `listUndeliveredEvents`.
        events = events.filter((e) => e.needs_delivery && e.acknowledged_at === undefined);
      }
      if (opts.limit !== undefined) {
        events = events.slice(0, opts.limit);
      }
      return events;
    });
  }

  async acknowledgeWorkflowEvent(eventId: number): Promise<boolean> {
    return this.dispatch('acknowledgeWorkflowEvent', [eventId], () => {
      this.ackedEventIds.push(eventId);
      return this.workflowEventAckResult;
    });
  }

  async failWorkflowEventDelivery(
    eventId: number,
    opts: FailWorkflowEventOptions = {},
  ): Promise<boolean> {
    return this.dispatch('failWorkflowEventDelivery', [eventId, opts], () => {
      this.failedEventIds.push(eventId);
      return this.workflowEventFailResult;
    });
  }

  async listWorkflowTasks(filter: ListWorkflowTasksFilter): Promise<WorkflowTask[]> {
    return this.dispatch('listWorkflowTasks', [filter], () => {
      // Apply kind + state + limit filters in-mock so tests seed ONE
      // buffer and drive scenarios that vary by filter. The real route
      // requires both kind + state; the mock mirrors that so missing
      // filters still emit the same empty result at the method boundary.
      let tasks = this.workflowTasks.filter(
        (t) => t.kind === filter.kind && t.status === filter.state,
      );
      if (filter.limit !== undefined) tasks = tasks.slice(0, filter.limit);
      return tasks;
    });
  }

  async getWorkflowTask(id: string): Promise<WorkflowTask | null> {
    return this.dispatch('getWorkflowTask', [id], () => {
      return this.workflowTasks.find((t) => t.id === id) ?? null;
    });
  }

  async createWorkflowTask(input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult> {
    return this.dispatch('createWorkflowTask', [input], () => {
      // Idempotency short-circuit — if the caller gave an idempotency
      // key that matches a live task in the buffer, return it with
      // deduped=true, matching the real route's 200+deduped path.
      if (
        input.idempotencyKey !== undefined &&
        input.idempotencyKey !== ''
      ) {
        const existing = this.workflowTasks.find(
          (t) => t.idempotency_key === input.idempotencyKey,
        );
        if (existing !== undefined) {
          return { task: existing, deduped: true };
        }
      }
      // Id conflict — match the route's 409 → throw path.
      const idClash = this.workflowTasks.find((t) => t.id === input.id);
      if (idClash !== undefined) {
        throw new WorkflowConflictError(
          `duplicate task id: ${input.id}`,
          'duplicate_id',
        );
      }
      // Fresh create — stamp a minimal-but-valid WorkflowTask, push
      // into the buffer, and echo it back. Tests that care about full
      // state fields seed the buffer directly and cover those paths
      // via explicit canned responses.
      const now = Date.now();
      const task: WorkflowTask = {
        id: input.id,
        kind: input.kind,
        status: input.initialState ?? 'created',
        description: input.description,
        payload: input.payload,
        priority: input.priority ?? 'normal',
        origin: input.origin ?? '',
        result_summary: '',
        policy: input.policy ?? '{}',
        created_at: now,
        updated_at: now,
        ...(input.expiresAtSec !== undefined && { expires_at: input.expiresAtSec * 1000 }),
        ...(input.correlationId !== undefined && { correlation_id: input.correlationId }),
        ...(input.parentId !== undefined && { parent_id: input.parentId }),
        ...(input.proposalId !== undefined && { proposal_id: input.proposalId }),
        ...(input.sessionName !== undefined && { session_name: input.sessionName }),
        ...(input.idempotencyKey !== undefined && { idempotency_key: input.idempotencyKey }),
      };
      this.workflowTasks.push(task);
      return { task, deduped: false };
    });
  }

  async approveWorkflowTask(
    id: string,
    _opts?: { scope?: 'single' | 'session' },
  ): Promise<WorkflowTask> {
    return this.workflowAction('approveWorkflowTask', id, (task) => {
      task.status = 'queued';
    });
  }

  async getActionPolicy(): Promise<ActionPolicyResult> {
    return this.dispatch('getActionPolicy', [], () => this.actionPolicyResult);
  }

  async setActionRisk(action: string, risk: RiskLevel): Promise<ActionPolicyEntry> {
    return this.dispatch('setActionRisk', [action, risk], () => ({
      action,
      risk,
      isDefault: false,
      locked: false,
      inDefaultPolicy: false,
    }));
  }

  async deleteActionOverride(action: string): Promise<void> {
    return this.dispatch('deleteActionOverride', [action], () => undefined);
  }

  async cancelWorkflowTask(id: string, reason = ''): Promise<WorkflowTask> {
    return this.workflowAction(
      'cancelWorkflowTask',
      id,
      (task) => {
        task.status = 'cancelled';
      },
      reason !== '' ? [id, reason] : undefined,
    );
  }

  async completeWorkflowTask(
    id: string,
    result: string,
    resultSummary: string,
    agentDID = '',
  ): Promise<WorkflowTask> {
    return this.workflowAction(
      'completeWorkflowTask',
      id,
      (task) => {
        task.status = 'completed';
        task.result = result;
        task.result_summary = resultSummary;
      },
      [id, result, resultSummary, agentDID],
    );
  }

  async failWorkflowTask(
    id: string,
    errorMsg: string,
    agentDID = '',
  ): Promise<WorkflowTask> {
    return this.workflowAction(
      'failWorkflowTask',
      id,
      (task) => {
        task.status = 'failed';
        task.error = errorMsg;
      },
      [id, errorMsg, agentDID],
    );
  }

  async memoryTouch(params: MemoryTouchParams): Promise<MemoryTouchResult> {
    return this.dispatch('memoryTouch', [params], () => {
      // Record the touch into a per-persona buffer so tests can assert
      // "the drain called memoryTouch 3 times for Dr Carl's topic" by
      // reading `memoryTouches` rather than walking `calls[]`.
      this.memoryTouches.push({ ...params });
      // Default result: 'ok' + echo the topic back as canonical name.
      // Tests that need to exercise the locked-persona path override
      // `memoryTouchResult` before the call.
      if (this.memoryTouchResult !== undefined) return this.memoryTouchResult;
      return { status: 'ok' as const, canonical: params.topic };
    });
  }

  async findContactsByPreference(category: string): Promise<Contact[]> {
    return this.dispatch('findContactsByPreference', [category], () => {
      return this.contactsByPreferenceResult[category.trim().toLowerCase()] ?? [];
    });
  }

  async contactLookup(query: string): Promise<Contact | null> {
    return this.dispatch('contactLookup', [query], () => {
      return this.contactLookupResult[query.trim().toLowerCase()] ?? null;
    });
  }

  async peopleApplyExtraction(
    result: ExtractionResult,
    persona?: string,
  ): Promise<ApplyExtractionResponse> {
    return this.dispatch('peopleApplyExtraction', [result, persona], () => {
      this.peopleExtractions.push(result);
      // Default: report every link as a freshly created person + surface.
      // Tests that need a different shape override
      // `peopleApplyExtractionResult` before the call.
      if (this.peopleApplyExtractionResult !== undefined) {
        return this.peopleApplyExtractionResult;
      }
      return {
        created: result.results.length,
        updated: 0,
        conflicts: [],
        skipped: false,
      };
    });
  }

  async personasList(): Promise<PersonaListEntry[]> {
    return this.dispatch('personasList', [], () => this.personasListResult);
  }

  async peopleList(): Promise<Person[]> {
    return this.dispatch('peopleList', [], () => [...this.peopleListResult]);
  }

  async peopleFindByName(surface: string): Promise<Person[]> {
    if (typeof surface !== 'string' || surface.trim() === '') {
      throw new Error('peopleFindByName: surface is required');
    }
    return this.dispatch('peopleFindByName', [surface], () => {
      const needle = surface.trim().toLowerCase();
      return this.peopleListResult.filter((p) =>
        (p.surfaces ?? []).some(
          (s) => s.status !== 'rejected' && s.normalizedSurface === needle,
        ),
      );
    });
  }

  async peopleResolveByDid(did: string): Promise<Person | null> {
    if (typeof did !== 'string' || did.trim() === '') {
      throw new Error('peopleResolveByDid: did is required');
    }
    return this.dispatch('peopleResolveByDid', [did], () => {
      const wanted = did.trim();
      // Match against the canned people list by their contactDid.
      return (
        this.peopleListResult.find(
          (p) => p.status !== 'rejected' && p.contactDid === wanted,
        ) ?? null
      );
    });
  }

  async reminderCreate(input: ReminderCreateInput): Promise<Reminder> {
    return this.dispatch('reminderCreate', [input], () => {
      const kind = input.kind ?? 'manual';
      const sourceItemId = input.source_item_id ?? '';
      // Dedup must mirror the real service EXACTLY (see reminders/service
      // dedupKey): (source_item_id, kind, due_at, persona, MESSAGE). Without
      // `message` the mock would collapse two distinct manual reminders at
      // the same time — behaviour real Core no longer has.
      const existing = this.reminders.find(
        (r) =>
          r.source_item_id === sourceItemId &&
          r.kind === kind &&
          r.due_at === input.due_at &&
          r.persona === input.persona &&
          r.message === input.message,
      );
      if (existing) return existing;
      const seq = ++this.reminderSeq;
      const reminder: Reminder = {
        id: `mock-rem-${seq}`,
        short_id: `m${seq}`,
        message: input.message,
        due_at: input.due_at,
        recurring: input.recurring ?? '',
        completed: 0,
        created_at: Date.now(),
        source_item_id: sourceItemId,
        source: input.source ?? '',
        persona: input.persona,
        timezone: input.timezone ?? 'UTC',
        kind,
        status: 'pending',
      };
      this.reminders.push(reminder);
      return reminder;
    });
  }

  async reminderListByPersona(persona: string): Promise<Reminder[]> {
    if (typeof persona !== 'string' || persona.trim() === '') {
      throw new Error('reminderListByPersona: persona is required');
    }
    return this.dispatch('reminderListByPersona', [persona], () =>
      this.reminders.filter((r) => r.persona === persona),
    );
  }

  async reminderListPending(now?: number): Promise<Reminder[]> {
    return this.dispatch('reminderListPending', [now], () => {
      const cutoff = now ?? Date.now();
      // Mirror the real service's `listPending`: not completed, due by the
      // cutoff, status pending OR snoozed (a snooze re-fires when its new
      // due_at arrives), sorted soonest-first.
      return this.reminders
        .filter(
          (r) =>
            r.completed === 0 &&
            (r.status === 'pending' || r.status === 'snoozed') &&
            r.due_at <= cutoff,
        )
        .sort((a, b) => a.due_at - b.due_at);
    });
  }

  async reminderComplete(id: string): Promise<Reminder | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('reminderComplete: id is required');
    }
    return this.dispatch('reminderComplete', [id], () => {
      const r = this.reminders.find((x) => x.id === id);
      if (r) {
        r.completed = 1;
        r.status = 'completed';
      }
      // Recurring next-occurrence is the real service's job; the mock
      // doesn't synthesize one (no test relies on it).
      return null;
    });
  }

  async reminderSnooze(id: string, snoozeMs: number): Promise<Reminder | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('reminderSnooze: id is required');
    }
    return this.dispatch('reminderSnooze', [id, snoozeMs], () => {
      const r = this.reminders.find((x) => x.id === id);
      if (!r) return null;
      // Mirror the service: snooze from max(due_at, now), so a past-due
      // reminder re-fires `snoozeMs` from NOW, not from its stale due_at.
      r.due_at = Math.max(r.due_at, Date.now()) + snoozeMs;
      r.status = 'snoozed';
      return r;
    });
  }

  async reminderDelete(id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('reminderDelete: id is required');
    }
    return this.dispatch('reminderDelete', [id], () => {
      const i = this.reminders.findIndex((x) => x.id === id);
      if (i < 0) return false;
      this.reminders.splice(i, 1);
      return true;
    });
  }

  async reminderFireMissed(now?: number): Promise<Reminder[]> {
    return this.dispatch('reminderFireMissed', [now], () => {
      const cutoff = now ?? Date.now();
      // Mirror the service: fire pending AND snoozed (a snooze re-fires
      // when its new due_at arrives), not pending-only.
      const fired = this.reminders.filter(
        (r) =>
          r.completed === 0 &&
          (r.status === 'pending' || r.status === 'snoozed') &&
          r.due_at <= cutoff,
      );
      for (const r of fired) r.status = 'fired';
      return fired;
    });
  }

  async updateContact(did: string, updates: UpdateContactParams): Promise<void> {
    await this.dispatch('updateContact', [did, updates], () => {
      // Deep-copy the preferredFor array so test mutation of the input
      // after the call doesn't rewrite the recorded history. Shallow
      // `{...updates}` would share the array reference.
      const recorded: UpdateContactParams = {};
      if (updates.preferredFor !== undefined) {
        recorded.preferredFor = [...updates.preferredFor];
      }
      this.contactUpdates.push({ did, updates: recorded });
      // No return value — mock just records. Tests wanting the 404-path
      // use `throwOn.updateContact` to inject an Error.
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /**
   * Record the call + throw-or-return. Centralised so every method
   * has identical behavior (call logging comes FIRST even on the
   * throw path — tests asserting "throw still logged the attempt"
   * can see it).
   */
  private async dispatch<T>(
    method: CoreClientMethodName,
    args: unknown[],
    produce: () => T,
  ): Promise<T> {
    this.calls.push({ method, args });
    const injected = this.throwOn[method];
    if (injected !== undefined) throw injected;
    return produce();
  }

  /**
   * Shared helper for the 4 workflow state transitions
   * (approve/cancel/complete/fail). Finds the task in the buffer,
   * applies the caller-supplied mutator, and returns it — throws a
   * typed Error if the task is absent, matching the real route's
   * 404-then-error path. Tests that need to assert the full args
   * list (not just `[id]`) pass `recordArgs` explicitly.
   */
  private async workflowAction(
    method:
      | 'approveWorkflowTask'
      | 'cancelWorkflowTask'
      | 'completeWorkflowTask'
      | 'failWorkflowTask',
    id: string,
    mutate: (task: WorkflowTask) => void,
    recordArgs?: unknown[],
  ): Promise<WorkflowTask> {
    return this.dispatch(method, recordArgs ?? [id], () => {
      const task = this.workflowTasks.find((t) => t.id === id);
      if (task === undefined) {
        throw new Error(`MockCoreClient.${method}: task not found: ${id}`);
      }
      mutate(task);
      task.updated_at = Date.now();
      return task;
    });
  }
}
