import {
  CoreReasoningBroker,
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  InMemoryVaultRepository,
  InMemoryWorkflowRepository,
  WorkflowService,
  clearVaults,
  createPersona,
  createReasoningCommitBridge,
  createServiceReasoningCommitter,
  createServiceReasoningSubmitter,
  isReasoningBackendPresent,
  markReasoningBackendPresent,
  openPersona,
  resetPersonaState,
  resetReasoningBackendPresence,
  setVaultRepository,
  storeItem,
  type ServiceQueryBridgeContext,
} from '@dina/core';

import { createReasoningOutputGuard } from '../../src/reasoning/reasoning_output_guard';

const OWNER = 'did:plc:provider';
const REQUESTER = 'did:plc:customer';
const AGENT = 'did:key:connected-agent';

function setup(options: { failSends?: number } = {}) {
  let now = 20_000;
  const sent: ServiceQueryBridgeContext[] = [];
  let remainingSendFailures = options.failSends ?? 0;
  const workflows = new InMemoryWorkflowRepository();
  const workflowService = new WorkflowService({
    repository: workflows,
    nowMsFn: () => now,
    responseBridgeSender: async (ctx) => {
      sent.push(ctx);
      if (remainingSendFailures > 0) {
        remainingSendFailures -= 1;
        throw new Error('MsgBox temporarily unavailable');
      }
    },
  });
  const backends = new InMemoryReasoningBackendRepository();
  const contexts = new InMemoryReasoningContextRepository();
  const broker = new CoreReasoningBroker({
    workflowService,
    workflowRepository: workflows,
    backendRepository: backends,
    contextRepository: contexts,
    nowMs: () => now,
    isAuthenticatedSessionActive: ({ sessionId, principalDid, authorityOrigin }) =>
      sessionId === 'sess-service-e2e' &&
      principalDid === AGENT &&
      authorityOrigin.kind === 'service_request' &&
      authorityOrigin.ownerDid === OWNER &&
      authorityOrigin.requesterDid === REQUESTER,
    outputGuard: createReasoningOutputGuard(),
    commitValidatedProposal: createReasoningCommitBridge({
      commitServiceResponse: createServiceReasoningCommitter({
        workflowService,
      }),
    }),
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
  markReasoningBackendPresent('connected-agent', AGENT, now);
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
    sent,
    submit,
    workflowService,
    workflows,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const request = {
  requesterDid: REQUESTER,
  queryId: 'query-e2e',
  capabilityId: 'appointment_availability',
  params: { date: 'tomorrow' },
  instructions: 'Use the salon schedule notes.',
  serviceName: 'Alonso Salon',
  ttlSeconds: 120,
  responseSchema: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['ok', 'no_slots', 'unknown'] },
      slots: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  vaultPersona: 'salon',
  operatorApproved: false,
} as const;

async function complete(h: ReturnType<typeof setup>, result: unknown) {
  const submitted = await h.submit(request);
  const claim = h.broker.claim({
    backendId: 'connected-agent',
    principalDid: AGENT,
    authenticatedSessionId: 'sess-service-e2e',
  })!;
  return h.broker.complete({
    taskId: submitted!.taskId,
    claimId: claim.claimId,
    contextTicketId: claim.contextTicketId,
    backendId: 'connected-agent',
    principalDid: AGENT,
    authenticatedSessionId: 'sess-service-e2e',
    executionId: claim.executionId,
    contextProjectionHash: claim.contextProjectionHash,
    policySnapshotHash: claim.policySnapshotHash,
    result,
    evidenceIds: [],
  });
}

describe('service reasoning end to end', () => {
  beforeEach(() => {
    resetPersonaState();
    resetReasoningBackendPresence();
    clearVaults([]);
    createPersona('salon', 'standard');
    openPersona('salon');
    setVaultRepository('salon', new InMemoryVaultRepository());
    storeItem('salon', {
      type: 'user_memory',
      summary: 'Salon has a 2pm slot tomorrow',
      body: 'Salon has a 2pm slot tomorrow',
      retrieval_policy: 'normal',
    });
  });

  afterEach(() => {
    resetReasoningBackendPresence();
    resetPersonaState();
    clearVaults([]);
  });

  test('a valid proposal reaches the authenticated requester', async () => {
    const h = setup();
    await expect(
      complete(h, {
        result: { status: 'ok', slots: ['2pm'] },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      code: 'completed',
      committed: true,
    });
    expect(h.sent).toEqual([]);
    await expect(h.workflowService.retryPendingBridges()).resolves.toBe(1);
    expect(h.sent).toEqual([
      expect.objectContaining({
        fromDID: REQUESTER,
        queryId: 'query-e2e',
        capability: 'appointment_availability',
        resultJSON: JSON.stringify({ status: 'ok', slots: ['2pm'] }),
      }),
    ]);
  });

  test('a schema-invalid proposal fails before any D2D response is sent', async () => {
    const h = setup();
    await expect(
      complete(h, {
        result: { status: 'invented', slots: ['2pm'] },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: 'invalid_result',
      committed: false,
    });
    expect(h.sent).toEqual([]);
  });

  test('a transport failure leaves one durable response for the bridge sweeper', async () => {
    const h = setup({ failSends: 1 });
    await expect(
      complete(h, {
        result: { status: 'ok', slots: ['2pm'] },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      committed: true,
    });
    const [task] = h.workflows.listByKindAndState('reasoning', 'completed', 10);
    expect(task).toBeDefined();
    expect(task?.internal_stash).toMatch(/^bridge_pending:/);

    await expect(h.workflowService.retryPendingBridges()).resolves.toBe(0);
    expect(h.workflows.getById(task!.id)?.internal_stash).toMatch(/^bridge_pending:/);
    await expect(h.workflowService.retryPendingBridges()).resolves.toBe(1);
    expect(h.workflows.getById(task!.id)?.internal_stash).toBeUndefined();
    expect(h.sent).toHaveLength(2);
    expect(
      h.workflows.listEventsForTask(task!.id).filter((event) => event.event_kind === 'completed'),
    ).toHaveLength(1);
  });

  test('commit recovery re-stages the same result without rerunning reasoning', async () => {
    const h = setup();
    const originalSetStash = h.workflows.setInternalStash.bind(h.workflows);
    let failStaging = true;
    h.workflows.setInternalStash = (...args) => {
      if (failStaging) throw new Error('identity store temporarily unavailable');
      return originalSetStash(...args);
    };

    await expect(
      complete(h, {
        result: { status: 'ok', slots: ['2pm'] },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      committed: false,
      commitState: 'failed',
      commitError: 'identity store temporarily unavailable',
    });
    const [task] = h.workflows.listByKindAndState('reasoning', 'completed', 10);
    expect(task).toBeDefined();
    expect(task?.internal_stash).toBeUndefined();
    expect(
      h.workflows.listEventsForTask(task!.id).filter((event) => event.event_kind === 'completed'),
    ).toHaveLength(1);

    failStaging = false;
    h.advance(2_000);
    await expect(h.broker.reconcilePendingCommits()).resolves.toMatchObject({
      committed: 1,
      failed: 0,
    });
    expect(h.workflows.getById(task!.id)?.internal_stash).toMatch(/^bridge_pending:/);
    expect(
      h.workflows.listEventsForTask(task!.id).filter((event) => event.event_kind === 'completed'),
    ).toHaveLength(1);

    await expect(h.workflowService.retryPendingBridges()).resolves.toBe(1);
    expect(h.sent).toHaveLength(1);
  });
});
