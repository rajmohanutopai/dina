import {
  CoreReasoningBroker,
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  InMemoryVaultRepository,
  InMemoryWorkflowRepository,
  WorkflowService,
  clearVaults,
  createPersona,
  createReasoningPolicySnapshotResolver,
  createServiceReasoningCommitter,
  createServiceReasoningSubmitter,
  isReasoningBackendPresent,
  markReasoningBackendPresent,
  openPersona,
  parseReasoningEnvelope,
  resetPersonaState,
  resetReasoningBackendPresence,
  setVaultRepository,
  storeItem,
  type ReasoningPolicySnapshotInput,
  type ServiceConfig,
} from '../../src';

import type {
  ServiceGrant,
  ServiceGrantRepository,
} from '../../src/service/service_grant_repository';

const OWNER = 'did:plc:provider';
const REQUESTER = 'did:plc:customer';
const AGENT = 'did:key:connected-agent';

function harness(
  options: {
    resolvePolicySnapshotHash?: (input: ReasoningPolicySnapshotInput) => string;
    sessionActive?: (sessionId: string, principalDid: string) => boolean;
  } = {},
) {
  let now = 10_000;
  const workflows = new InMemoryWorkflowRepository();
  const workflowService = new WorkflowService({
    repository: workflows,
    nowMsFn: () => now,
  });
  const backends = new InMemoryReasoningBackendRepository();
  const contexts = new InMemoryReasoningContextRepository();
  const broker = new CoreReasoningBroker({
    workflowService,
    workflowRepository: workflows,
    backendRepository: backends,
    contextRepository: contexts,
    nowMs: () => now,
    ...(options.resolvePolicySnapshotHash === undefined
      ? {}
      : { resolvePolicySnapshotHash: options.resolvePolicySnapshotHash }),
    isAuthenticatedSessionActive: ({ sessionId, principalDid }) =>
      options.sessionActive?.(sessionId, principalDid) ??
      (sessionId === 'session-1' && principalDid === AGENT),
  });
  backends.register({
    backendId: 'connected-agent',
    kind: 'connected_host',
    principalDid: AGENT,
    allowedTaskKinds: ['service.respond'],
    maxSensitivity: 'personal',
    availability: 'foreground',
    selectedByOwnerDid: OWNER,
    expectedVersion: null,
    nowMs: now,
  });
  const submit = createServiceReasoningSubmitter({
    ownerDid: OWNER,
    getBroker: () => broker,
    getBackendRepository: () => backends,
    nowMs: () => now,
    isRuntimeAvailable: (binding, _origin, currentNowMs) =>
      isReasoningBackendPresent(binding.backendId, binding.principalDid, currentNowMs),
  });
  return {
    broker,
    workflows,
    submit,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const request = {
  requesterDid: REQUESTER,
  queryId: 'query-123',
  capabilityId: 'appointment_availability',
  params: { date: '2026-07-27' },
  instructions: 'Use the salon schedule notes to return available slots.',
  serviceName: 'Alonso Salon',
  ttlSeconds: 120,
  responseSchema: {
    type: 'object',
    required: ['slots'],
    properties: {
      slots: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  vaultPersona: 'salon',
  operatorApproved: false,
} as const;

describe('service reasoning execution', () => {
  beforeEach(() => {
    resetPersonaState();
    resetReasoningBackendPresence();
    clearVaults([]);
    createPersona('salon', 'standard');
    openPersona('salon');
    setVaultRepository('salon', new InMemoryVaultRepository());
    storeItem('salon', {
      type: 'user_memory',
      summary: 'Salon schedule has slots at 2pm and 4pm',
      body: 'Salon schedule has slots at 2pm and 4pm',
      retrieval_policy: 'normal',
    });
  });

  afterEach(() => {
    resetReasoningBackendPresence();
    resetPersonaState();
    clearVaults([]);
  });

  test('falls back when the authorized foreground backend is not present', async () => {
    const h = harness();
    await expect(h.submit(request)).resolves.toBeNull();
    expect(h.workflows.size()).toBe(0);
  });

  test('accepts the protocol maximum service TTL', async () => {
    const h = harness();
    markReasoningBackendPresent('connected-agent', AGENT, h.now());

    const submitted = await h.submit({ ...request, ttlSeconds: 300 });
    const envelope = parseReasoningEnvelope(h.workflows.getById(submitted!.taskId)?.payload ?? '');

    expect(envelope?.deadlineAtMs).toBe(h.now() + 300_000);
  });

  test('submits authenticated service authority with one scrubbed vault projection', async () => {
    const h = harness();
    markReasoningBackendPresent('connected-agent', AGENT, h.now());

    const submitted = await h.submit(request);
    expect(submitted).toMatchObject({
      backendId: 'connected-agent',
      deduplicated: false,
    });
    const claim = h.broker.claim({
      backendId: 'connected-agent',
      principalDid: AGENT,
      authenticatedSessionId: 'session-1',
    });
    expect(claim).not.toBeNull();
    expect(claim?.authorityOrigin).toEqual({
      kind: 'service_request',
      ownerDid: OWNER,
      requesterDid: REQUESTER,
      ingress: 'd2d',
      correlationId: 'query-123',
      authenticatedAtMs: h.now(),
    });
    expect(claim?.input).toMatchObject({
      capabilityId: 'appointment_availability',
      serviceName: 'Alonso Salon',
      ttlSeconds: 120,
      responseSchema: request.responseSchema,
    });
    expect(claim?.context?.items).toHaveLength(1);
    expect(claim?.context?.items[0]?.text).toContain('2pm and 4pm');
    expect(claim?.context?.scrubbed).toBe(true);
  });

  test('deduplicates the same authenticated service query', async () => {
    const h = harness();
    markReasoningBackendPresent('connected-agent', AGENT, h.now());

    const first = await h.submit(request);
    const second = await h.submit(request);

    expect(second).toMatchObject({
      taskId: first?.taskId,
      deduplicated: true,
    });
    expect(h.workflows.size()).toBe(1);
  });

  test('does not downgrade a conflicting replay to the legacy executor', async () => {
    const h = harness();
    markReasoningBackendPresent('connected-agent', AGENT, h.now());

    await expect(h.submit(request)).resolves.not.toBeNull();
    await expect(
      h.submit({
        ...request,
        params: { date: 'a different date under the same authenticated query id' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(h.workflows.size()).toBe(1);
  });

  test('rejects completion when the exact known-only grant is revoked after claim', async () => {
    let revokedAt: number | undefined;
    const config: ServiceConfig = {
      isDiscoverable: false,
      discoverability: 'known_only',
      status: 'active',
      name: 'Alonso Salon',
      vaultPersona: 'salon',
      capabilities: {
        appointment_availability: {
          instruction: request.instructions,
          responsePolicy: 'auto',
        },
      },
      capabilitySchemas: {
        appointment_availability: {
          params: { type: 'object' },
          result: request.responseSchema,
          schemaHash: 'a'.repeat(64),
        },
      },
    };
    const grant: ServiceGrant = {
      grantId: 'grant-1',
      granteeDid: REQUESTER,
      serviceRkey: 'salon',
      capability: 'appointment_availability',
      grantType: 'standing',
      createdAt: 1,
    };
    const grants: Pick<ServiceGrantRepository, 'getById' | 'isAuthorized'> = {
      getById: (grantId) =>
        grantId === grant.grantId
          ? { ...grant, ...(revokedAt === undefined ? {} : { revokedAt }) }
          : null,
      isAuthorized: (input) =>
        revokedAt === undefined &&
        input.grantId === grant.grantId &&
        input.granteeDid === grant.granteeDid &&
        input.serviceRkey === grant.serviceRkey &&
        input.capability === grant.capability,
    };
    let now = 10_000;
    const h = harness({
      resolvePolicySnapshotHash: createReasoningPolicySnapshotResolver({
        nowMs: () => now,
        readServiceConfig: (rkey) => (rkey === 'salon' ? config : null),
        getGrantRepository: () => grants,
      }),
      sessionActive: (sessionId, principalDid) =>
        sessionId === 'session-1' && principalDid === AGENT,
    });
    markReasoningBackendPresent('connected-agent', AGENT, h.now());
    const submitted = await h.submit({
      ...request,
      serviceUri: `at://${OWNER}/com.dinakernel.service.profile/salon`,
      grantId: grant.grantId,
    });
    const claim = h.broker.claim({
      backendId: 'connected-agent',
      principalDid: AGENT,
      authenticatedSessionId: 'session-1',
    })!;

    revokedAt = 11;
    now = 11_000;
    await expect(
      h.broker.complete({
        taskId: submitted!.taskId,
        claimId: claim.claimId,
        contextTicketId: claim.contextTicketId,
        backendId: 'connected-agent',
        principalDid: AGENT,
        authenticatedSessionId: 'session-1',
        executionId: claim.executionId,
        contextProjectionHash: claim.contextProjectionHash,
        policySnapshotHash: claim.policySnapshotHash,
        result: { result: { slots: ['2pm'] } },
        evidenceIds: [],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: 'stale_policy',
      committed: false,
    });
    expect(h.workflows.getById(submitted!.taskId)?.status).toBe('failed');
  });

  test('rejects completion when the selected listing is paused after claim', async () => {
    let status: ServiceConfig['status'] = 'active';
    const readConfig = (): ServiceConfig => ({
      isDiscoverable: true,
      discoverability: 'public',
      status,
      name: 'Alonso Salon',
      vaultPersona: 'salon',
      capabilities: {
        appointment_availability: {
          instruction: request.instructions,
          responsePolicy: 'auto',
        },
      },
      capabilitySchemas: {
        appointment_availability: {
          params: { type: 'object' },
          result: request.responseSchema,
          schemaHash: 'a'.repeat(64),
        },
      },
    });
    const h = harness({
      resolvePolicySnapshotHash: createReasoningPolicySnapshotResolver({
        readServiceConfig: (rkey) => (rkey === 'salon' ? readConfig() : null),
      }),
      sessionActive: (sessionId, principalDid) =>
        sessionId === 'session-1' && principalDid === AGENT,
    });
    markReasoningBackendPresent('connected-agent', AGENT, h.now());
    const submitted = await h.submit({
      ...request,
      serviceUri: `at://${OWNER}/com.dinakernel.service.profile/salon`,
    });
    const claim = h.broker.claim({
      backendId: 'connected-agent',
      principalDid: AGENT,
      authenticatedSessionId: 'session-1',
    })!;

    status = 'paused';
    await expect(
      h.broker.complete({
        taskId: submitted!.taskId,
        claimId: claim.claimId,
        contextTicketId: claim.contextTicketId,
        backendId: 'connected-agent',
        principalDid: AGENT,
        authenticatedSessionId: 'session-1',
        executionId: claim.executionId,
        contextProjectionHash: claim.contextProjectionHash,
        policySnapshotHash: claim.policySnapshotHash,
        result: { result: { slots: ['2pm'] } },
        evidenceIds: [],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: 'stale_policy',
      committed: false,
    });
    expect(h.workflows.getById(submitted!.taskId)?.status).toBe('failed');
  });

  test('commits to the authenticated requester through the shared response bridge', async () => {
    const sent: unknown[] = [];
    const workflows = new InMemoryWorkflowRepository();
    workflows.create({
      id: 'reason-1',
      kind: 'reasoning',
      status: 'completed',
      priority: 'normal',
      description: 'service reasoning',
      payload: JSON.stringify({ version: 1, taskKind: 'service.respond' }),
      result_summary: '',
      policy: '{}',
      created_at: 10_000,
      updated_at: 10_000,
    });
    const workflowService = new WorkflowService({
      repository: workflows,
      responseBridgeSender: async (ctx) => {
        sent.push(ctx);
      },
    });
    const commit = createServiceReasoningCommitter({
      workflowService,
    });

    await expect(
      commit({
        taskId: 'reason-1',
        ownerDid: OWNER,
        authorityOrigin: {
          kind: 'service_request',
          ownerDid: OWNER,
          requesterDid: REQUESTER,
          ingress: 'd2d',
          correlationId: 'query-123',
          authenticatedAtMs: 10_000,
        },
        input: {
          capabilityId: 'appointment_availability',
          params: request.params,
          serviceName: 'Alonso Salon',
          ttlSeconds: 120,
          responseSchema: request.responseSchema,
        },
        result: { result: { slots: ['2pm'] } },
        evidenceIds: [],
      }),
    ).resolves.toMatchObject({
      state: 'committed',
      receipt: { query_id: 'query-123', status: 'queued_for_delivery' },
    });
    expect(sent).toEqual([]);
    expect(workflows.getById('reason-1')?.internal_stash).toMatch(/^bridge_pending:/);
    await expect(workflowService.retryPendingBridges()).resolves.toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({
        taskId: 'reason-1',
        fromDID: REQUESTER,
        queryId: 'query-123',
        capability: 'appointment_availability',
        resultJSON: JSON.stringify({ slots: ['2pm'] }),
      }),
    ]);
    expect(workflows.getById('reason-1')?.internal_stash).toBeUndefined();
  });

  test('never accepts requester identity from model-visible input', async () => {
    const workflowService = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      responseBridgeSender: async () => undefined,
    });
    const commit = createServiceReasoningCommitter({
      workflowService,
    });
    await expect(
      commit({
        taskId: 'reason-1',
        ownerDid: OWNER,
        authorityOrigin: {
          kind: 'owner_interactive',
          ownerDid: OWNER,
          requesterDid: OWNER,
          ingress: 'internal',
          correlationId: 'query-123',
          authenticatedAtMs: 10_000,
        },
        input: {
          capabilityId: 'appointment_availability',
          params: request.params,
          serviceName: 'Alonso Salon',
          ttlSeconds: 120,
          responseSchema: request.responseSchema,
          requesterDid: REQUESTER,
        },
        result: { result: { slots: ['2pm'] } },
        evidenceIds: [],
      }),
    ).rejects.toThrow('invalid service reasoning commit');
  });

  test('does not report a committed response when durable bridge staging fails', async () => {
    const workflows = new InMemoryWorkflowRepository();
    workflows.create({
      id: 'reason-1',
      kind: 'reasoning',
      status: 'completed',
      priority: 'normal',
      description: 'service reasoning',
      payload: JSON.stringify({ version: 1, taskKind: 'service.respond' }),
      result_summary: '',
      policy: '{}',
      created_at: 10_000,
      updated_at: 10_000,
    });
    workflows.setInternalStash = () => {
      throw new Error('identity store full');
    };
    const sent = jest.fn(async () => undefined);
    const workflowService = new WorkflowService({
      repository: workflows,
      responseBridgeSender: sent,
    });
    const commit = createServiceReasoningCommitter({ workflowService });

    await expect(
      commit({
        taskId: 'reason-1',
        ownerDid: OWNER,
        authorityOrigin: {
          kind: 'service_request',
          ownerDid: OWNER,
          requesterDid: REQUESTER,
          ingress: 'd2d',
          correlationId: 'query-123',
          authenticatedAtMs: 10_000,
        },
        input: {
          capabilityId: 'appointment_availability',
          params: request.params,
          serviceName: 'Alonso Salon',
          ttlSeconds: 120,
          responseSchema: request.responseSchema,
        },
        result: { result: { slots: ['2pm'] } },
        evidenceIds: [],
      }),
    ).rejects.toThrow('identity store full');
    expect(sent).not.toHaveBeenCalled();
  });
});
