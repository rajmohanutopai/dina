import {
  CoreReasoningBroker,
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  ReasoningBrokerError,
  SessionRegistry,
  parseReasoningEnvelope,
  reasoningHash,
  type AuthorityOrigin,
  type ReasoningCommitReceipt,
  type ReasoningOutputGuardInput,
  type ReasoningOutputGuardResult,
  type ReasoningValidatedProposal,
} from '../../src';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const OWNER = 'did:plc:owner';
const OTHER_OWNER = 'did:plc:other';
const AGENT = 'did:key:agent';
const OTHER_AGENT = 'did:key:other-agent';

function ownerOrigin(ownerDid = OWNER): AuthorityOrigin {
  return {
    kind: 'owner_interactive',
    ownerDid,
    ingress: 'coding_host',
    correlationId: 'host-turn-1',
    authenticatedAtMs: 1_000,
  };
}

function deterministicBytes(): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => {
    counter += 1;
    return new Uint8Array(length).fill(counter);
  };
}

function harness(options?: {
  commit?: (
    proposal: ReasoningValidatedProposal,
  ) => Promise<ReasoningCommitReceipt> | ReasoningCommitReceipt;
  guard?: (
    input: ReasoningOutputGuardInput,
  ) => Promise<ReasoningOutputGuardResult> | ReasoningOutputGuardResult;
  sessionActive?: (sessionId: string, principalDid: string) => boolean;
  sessionActivate?: (
    sessionId: string,
    principalDid: string,
    authorityOrigin: AuthorityOrigin,
  ) => boolean;
  sessionRelease?: (
    sessionId: string,
    principalDid: string,
    authorityOrigin: AuthorityOrigin,
  ) => boolean;
}) {
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
    idBytes: deterministicBytes(),
    ...(options?.commit ? { commitValidatedProposal: options.commit } : {}),
    ...(options?.guard ? { outputGuard: options.guard } : {}),
    ...(options?.sessionActive
      ? {
          isAuthenticatedSessionActive: ({
            sessionId,
            principalDid,
          }: {
            sessionId: string;
            principalDid: string;
          }) => options.sessionActive!(sessionId, principalDid),
        }
      : {}),
    ...(options?.sessionActivate
      ? {
          activateAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
            options.sessionActivate!(sessionId, principalDid, authorityOrigin),
        }
      : {}),
    ...(options?.sessionRelease
      ? {
          releaseAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
            options.sessionRelease!(sessionId, principalDid, authorityOrigin),
        }
      : {}),
  });
  const register = (
    backendId = 'claude',
    principalDid = AGENT,
    selectedByOwnerDid = OWNER,
    kind: 'connected_host' | 'internal_brain' = 'internal_brain',
  ) =>
    backends.register({
      backendId,
      kind,
      principalDid,
      allowedTaskKinds: ['answer.compose', 'review.summarize'],
      maxSensitivity: 'sensitive',
      availability: 'foreground',
      selectedByOwnerDid,
      expectedVersion: null,
      nowMs: now,
    });
  const submit = (overrides: Partial<Parameters<typeof broker.submit>[0]> = {}) =>
    broker.submit({
      taskKind: 'answer.compose',
      ownerDid: OWNER,
      authorityOrigin: ownerOrigin(),
      input: { query: 'Which chair fits me?' },
      context: {
        items: [
          {
            sourceId: 'memory-back-pain',
            sourceType: 'memory',
            text: 'Lower back pain',
          },
        ],
        scrubbed: true,
        sensitivity: 'sensitive',
      },
      sensitivity: 'sensitive',
      evidencePolicy: 'required',
      purpose: 'answer the owner using bounded context',
      deadlineAtMs: now + 60_000,
      ...overrides,
    });
  return {
    broker,
    backends,
    contexts,
    workflows,
    workflowService,
    register,
    submit,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('CoreReasoningBroker', () => {
  test('binds a connected host to exact non-owner work and releases it at completion', async () => {
    const sessions = new SessionRegistry(() => 10_000);
    const session = sessions.start({
      agentDid: AGENT,
      hostSessionId: 'host-service',
    });
    const authorityOrigin: AuthorityOrigin = {
      kind: 'service_request',
      ownerDid: OWNER,
      requesterDid: 'did:plc:requester',
      ingress: 'd2d',
      correlationId: 'query-1',
      authenticatedAtMs: 10_000,
    };
    const h = harness({
      sessionActive: (sessionId, principalDid) =>
        sessions.authorizesAuthorityOrigin(sessionId, principalDid, authorityOrigin),
      sessionActivate: (sessionId, principalDid, origin) =>
        sessions.activateAuthorityOrigin(sessionId, principalDid, origin),
      sessionRelease: (sessionId, principalDid, origin) =>
        sessions.clearAuthorityOrigin(sessionId, principalDid, origin).ok,
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    h.submit({
      backendBindingId: 'claude',
      authorityOrigin,
    });

    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
      authenticatedSessionId: session.sessionId,
    });
    expect(claim).not.toBeNull();
    expect(sessions.get(session.sessionId)?.authorityOrigin).toEqual(authorityOrigin);
    expect(sessions.start({ agentDid: AGENT, hostSessionId: 'host-service' }).sessionId).toBe(
      session.sessionId,
    );

    await expect(
      h.broker.complete({
        taskId: claim!.taskId,
        claimId: claim!.claimId,
        contextTicketId: claim!.contextTicketId,
        backendId: 'claude',
        principalDid: AGENT,
        authenticatedSessionId: session.sessionId,
        executionId: claim!.executionId,
        contextProjectionHash: claim!.contextProjectionHash,
        policySnapshotHash: claim!.policySnapshotHash,
        result: {
          answer: 'A bounded answer.',
          evidenceIds: ['memory-back-pain'],
        },
        evidenceIds: ['memory-back-pain'],
      }),
    ).resolves.toMatchObject({ accepted: true, committed: true });
    expect(sessions.get(session.sessionId)?.authorityOrigin).toBeNull();
  });

  test('persists the context ticket before reserving a connected-host session', () => {
    const order: string[] = [];
    const h = harness({
      sessionActive: () => true,
      sessionActivate: () => {
        order.push('session');
        return true;
      },
    });
    const createTicket = h.contexts.createTicket.bind(h.contexts);
    jest.spyOn(h.contexts, 'createTicket').mockImplementation((ticket) => {
      createTicket(ticket);
      order.push('ticket');
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    h.submit({
      backendBindingId: 'claude',
      authorityOrigin: {
        kind: 'service_request',
        ownerDid: OWNER,
        requesterDid: 'did:plc:requester',
        ingress: 'd2d',
        correlationId: 'query-ticket-order',
        authenticatedAtMs: 10_000,
      },
    });

    expect(
      h.broker.claim({
        backendId: 'claude',
        principalDid: AGENT,
        authenticatedSessionId: 'sess-connected',
      }),
    ).not.toBeNull();
    expect(order).toEqual(['ticket', 'session']);
  });

  test('restart reconciliation releases a terminal task reservation', () => {
    const sessions = new SessionRegistry(() => 10_000);
    const session = sessions.start({
      agentDid: AGENT,
      hostSessionId: 'host-reconcile',
    });
    const authorityOrigin: AuthorityOrigin = {
      kind: 'delegated_task',
      ownerDid: OWNER,
      requesterDid: 'did:plc:delegator',
      ingress: 'd2d',
      correlationId: 'delegation-reconcile',
      authenticatedAtMs: 10_000,
    };
    const h = harness({
      sessionActive: (sessionId, principalDid) =>
        sessions.authorizesAuthorityOrigin(sessionId, principalDid, authorityOrigin),
      sessionActivate: (sessionId, principalDid, origin) =>
        sessions.activateAuthorityOrigin(sessionId, principalDid, origin),
      sessionRelease: (sessionId, principalDid, origin) =>
        sessions.clearAuthorityOrigin(sessionId, principalDid, origin).ok,
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    const submitted = h.submit({
      backendBindingId: 'claude',
      authorityOrigin,
    });
    expect(
      h.broker.claim({
        backendId: 'claude',
        principalDid: AGENT,
        authenticatedSessionId: session.sessionId,
      }),
    ).not.toBeNull();
    expect(sessions.get(session.sessionId)?.authorityOrigin).toEqual(authorityOrigin);

    // Simulate a restart after the workflow became terminal but before the
    // normal broker cleanup callback ran.
    h.workflowService.cancel(submitted.taskId, 'expired while Core was down');
    h.broker.reconcileSessionAuthorities();

    expect(sessions.get(session.sessionId)?.authorityOrigin).toBeNull();
  });

  test('does not let a session reserved for one non-owner origin claim another', () => {
    const sessions = new SessionRegistry(() => 10_000);
    const session = sessions.start({
      agentDid: AGENT,
      hostSessionId: 'host-service',
    });
    const first: AuthorityOrigin = {
      kind: 'service_request',
      ownerDid: OWNER,
      requesterDid: 'did:plc:first',
      ingress: 'd2d',
      correlationId: 'query-1',
      authenticatedAtMs: 10_000,
    };
    const second: AuthorityOrigin = {
      ...first,
      requesterDid: 'did:plc:second',
      correlationId: 'query-2',
    };
    expect(sessions.activateAuthorityOrigin(session.sessionId, AGENT, first)).toBe(true);
    const h = harness({
      sessionActive: (sessionId, principalDid) =>
        sessions.authorizesAuthorityOrigin(sessionId, principalDid, second),
      sessionActivate: (sessionId, principalDid, origin) =>
        sessions.activateAuthorityOrigin(sessionId, principalDid, origin),
      sessionRelease: (sessionId, principalDid, origin) =>
        sessions.clearAuthorityOrigin(sessionId, principalDid, origin).ok,
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    const submitted = h.submit({
      backendBindingId: 'claude',
      authorityOrigin: second,
    });

    expect(
      h.broker.claim({
        backendId: 'claude',
        principalDid: AGENT,
        authenticatedSessionId: session.sessionId,
      }),
    ).toBeNull();
    expect(h.workflows.getById(submitted.taskId)?.status).toBe('failed');
    expect(sessions.get(session.sessionId)?.authorityOrigin).toEqual(first);
  });

  test('claims and completes a schema-valid, evidence-backed proposal', async () => {
    const h = harness();
    h.register();
    const submitted = h.submit({ backendBindingId: 'claude' });
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
      leaseMs: 10_000,
    });
    expect(claim?.taskId).toBe(submitted.taskId);
    expect(claim?.allowedEvidenceIds).toEqual(['memory-back-pain']);

    const completion = await h.broker.complete({
      taskId: claim!.taskId,
      claimId: claim!.claimId,
      contextTicketId: claim!.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim!.executionId,
      contextProjectionHash: claim!.contextProjectionHash,
      policySnapshotHash: claim!.policySnapshotHash,
      result: {
        answer: 'Choose the chair with adjustable lumbar support.',
        evidenceIds: ['memory-back-pain'],
      },
      evidenceIds: ['memory-back-pain'],
    });

    expect(completion).toMatchObject({
      accepted: true,
      state: 'completed',
      code: 'completed',
      committed: true,
    });
    expect(h.workflows.getById(submitted.taskId)?.status).toBe('completed');
  });

  test('awaits the output guard and persists only its schema-valid result', async () => {
    const observed: ReasoningOutputGuardInput[] = [];
    const h = harness({
      guard: async (input) => {
        observed.push(input);
        await Promise.resolve();
        return {
          ok: true,
          result: {
            ...(input.result as Record<string, unknown>),
            answer: 'Sanitized answer.',
          },
        };
      },
    });
    h.register();
    const submitted = h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;

    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: {
        answer: 'Backend answer.',
        evidenceIds: ['memory-back-pain'],
      },
      evidenceIds: ['memory-back-pain'],
    });

    expect(completion).toMatchObject({ accepted: true, code: 'completed' });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      taskKind: 'answer.compose',
      input: { query: 'Which chair fits me?' },
      evidenceIds: ['memory-back-pain'],
      context: {
        items: [
          {
            sourceId: 'memory-back-pain',
            sourceType: 'memory',
            text: 'Lower back pain',
          },
        ],
      },
    });
    expect(JSON.parse(h.workflows.getById(submitted.taskId)!.result!)).toMatchObject({
      result: {
        answer: 'Sanitized answer.',
        evidenceIds: ['memory-back-pain'],
      },
    });
  });

  test('revocation while the output guard awaits cannot complete or commit the task', async () => {
    let releaseGuard!: () => void;
    let guardStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      guardStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let commits = 0;
    const h = harness({
      guard: async (input) => {
        guardStarted();
        await blocked;
        return { ok: true, result: input.result };
      },
      commit: () => {
        commits += 1;
        return { state: 'committed' };
      },
      sessionActive: () => true,
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    h.submit({ backendBindingId: 'claude' });
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
      authenticatedSessionId: 'sess-live',
    })!;
    const completionPromise = h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      authenticatedSessionId: 'sess-live',
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A proposal that must lose the revocation race.' },
      evidenceIds: ['memory-back-pain'],
    });

    await started;
    h.contexts.revokeTicket(claim.contextTicketId, h.now());
    releaseGuard();

    await expect(completionPromise).resolves.toMatchObject({
      accepted: false,
      code: 'ticket_invalid',
    });
    expect(h.workflows.getById(claim.taskId)?.status).toBe('running');
    expect(commits).toBe(0);
  });

  test('an output-policy exception fails closed without leaking the exception', async () => {
    const h = harness({
      guard: () => {
        throw new Error('provider echoed private prompt content');
      },
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A schema-valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({ accepted: false, code: 'invalid_result' });
    expect(h.workflows.getById(claim.taskId)).toMatchObject({
      status: 'failed',
      error: 'reasoning output policy unavailable',
    });
  });

  test('rejects a transformed result that no longer satisfies the task contract', async () => {
    const h = harness({
      guard: () => ({ ok: true, result: { evidenceIds: ['memory-back-pain'] } }),
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;

    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: {
        answer: 'Backend answer.',
        evidenceIds: ['memory-back-pain'],
      },
      evidenceIds: ['memory-back-pain'],
    });

    expect(completion).toMatchObject({
      accepted: false,
      code: 'invalid_result',
    });
    expect(h.workflows.getById(claim.taskId)?.status).toBe('failed');
  });

  test('an authorized backend cannot claim another owner’s task', () => {
    const h = harness();
    h.register('other-claude', OTHER_AGENT, OTHER_OWNER);
    h.submit();

    expect(
      h.broker.claim({
        backendId: 'other-claude',
        principalDid: OTHER_AGENT,
      }),
    ).toBeNull();
    expect(h.workflows.listByKindAndState('reasoning', 'queued', 10)).toHaveLength(1);
  });

  test('a stale ticket is unusable immediately after its lease expires', async () => {
    const h = harness();
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
      leaseMs: 1_000,
    })!;
    h.advance(1_001);

    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'late' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: false,
      code: 'ticket_invalid',
    });
    expect(h.workflows.getById(claim.taskId)?.status).toBe('running');
  });

  test('backend policy changes invalidate a live completion', async () => {
    const h = harness();
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    h.backends.register({
      backendId: 'claude',
      kind: 'connected_host',
      principalDid: AGENT,
      allowedTaskKinds: ['answer.compose'],
      maxSensitivity: 'sensitive',
      availability: 'foreground',
      selectedByOwnerDid: OWNER,
      expectedVersion: 1,
      nowMs: h.now() + 1,
    });

    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'should not land' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: false,
      code: 'backend_unavailable',
    });
  });

  test('forged evidence is rejected without completing the task', async () => {
    const h = harness();
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'unsupported' },
      evidenceIds: ['made-up-review'],
    });
    expect(completion).toMatchObject({
      accepted: false,
      code: 'invalid_evidence',
    });
    expect(h.workflows.getById(claim.taskId)?.status).toBe('running');
  });

  test('required evidence cannot be satisfied by an empty result set', () => {
    const h = harness();
    h.register();
    expect(() =>
      h.submit({
        context: {
          items: [],
          scrubbed: true,
          sensitivity: 'personal',
        },
        sensitivity: 'personal',
        evidencePolicy: 'required',
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReasoningBrokerError>>({
        code: 'invalid_request',
      }),
    );
  });

  test('schema-invalid output consumes the claim and safely requeues', async () => {
    const h = harness();
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { wrong: true },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: false,
      code: 'invalid_result',
    });
    expect(h.workflows.getById(claim.taskId)?.status).toBe('queued');
  });

  test('same idempotency key deduplicates only the same logical input', () => {
    const h = harness();
    h.register();
    const first = h.submit({ idempotencyKey: 'host-turn-answer' });
    const duplicate = h.submit({ idempotencyKey: 'host-turn-answer' });
    expect(duplicate).toMatchObject({
      taskId: first.taskId,
      executionId: first.executionId,
      deduplicated: true,
    });
    expect(() =>
      h.submit({
        idempotencyKey: 'host-turn-answer',
        input: { query: 'Different request' },
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReasoningBrokerError>>({
        code: 'conflict',
      }),
    );
  });

  test('terminal idempotency survives projection cleanup and does not repeat work', async () => {
    const h = harness();
    h.register();
    const first = h.submit({
      idempotencyKey: 'durable-host-turn-answer',
      backendBindingId: 'claude',
    });
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    expect(
      await h.broker.complete({
        taskId: claim.taskId,
        claimId: claim.claimId,
        contextTicketId: claim.contextTicketId,
        backendId: 'claude',
        principalDid: AGENT,
        executionId: claim.executionId,
        contextProjectionHash: claim.contextProjectionHash,
        policySnapshotHash: claim.policySnapshotHash,
        result: { answer: 'Completed once.', evidenceIds: ['memory-back-pain'] },
        evidenceIds: ['memory-back-pain'],
      }),
    ).toMatchObject({ accepted: true, code: 'completed' });
    expect(h.contexts.sweep(h.now())).toBeGreaterThan(0);

    const replay = h.submit({
      idempotencyKey: 'durable-host-turn-answer',
      backendBindingId: 'claude',
    });
    expect(replay).toMatchObject({
      taskId: first.taskId,
      executionId: first.executionId,
      state: 'completed',
      deduplicated: true,
    });
    expect(h.workflows.size()).toBe(1);

    expect(() =>
      h.submit({
        idempotencyKey: 'durable-host-turn-answer',
        backendBindingId: 'claude',
        input: { query: 'A changed request must not reuse the completed result.' },
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReasoningBrokerError>>({
        code: 'conflict',
      }),
    );
  });

  test('a commit-bridge failure is reported separately from accepted reasoning', async () => {
    const h = harness({
      commit: () => {
        throw new Error('vault temporarily unavailable');
      },
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: true,
      committed: false,
      commitError: 'vault temporarily unavailable',
    });
    expect(
      h.workflows
        .listEventsForTask(claim.taskId)
        .some((event) => event.event_kind === 'reasoning_commit_failed'),
    ).toBe(true);
  });

  test('reconciles an accepted commit failure without rerunning model work', async () => {
    let commitAttempts = 0;
    const h = harness({
      commit: () => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw new Error('vault temporarily unavailable');
        return { state: 'committed', receipt: { stored: true } };
      },
    });
    h.register();
    const submitted = h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({ accepted: true, commitState: 'failed' });

    // Core recovery may use the accepted hash-bound proposal after its model
    // delivery deadline; the expired projection is never re-exposed to a host.
    h.advance(61_000);
    const reconciled = await h.broker.reconcilePendingCommits();
    expect(reconciled).toMatchObject({ committed: 1, failed: 0 });
    expect(commitAttempts).toBe(2);

    const task = h.workflows.getById(submitted.taskId)!;
    const envelope = parseReasoningEnvelope(task.payload)!;
    expect(h.contexts.getProjection(envelope.inputProjectionId)?.revokedAtMs).toBe(h.now());
    const events = h.workflows.listEventsForTask(submitted.taskId);
    expect(events.at(-1)).toMatchObject({
      event_kind: 'reasoning_commit_succeeded',
      needs_delivery: false,
    });
  });

  test('commit recovery does not race an immediate commit still in flight', async () => {
    let releaseCommit!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let commits = 0;
    const h = harness({
      commit: async () => {
        commits += 1;
        markStarted();
        await waitForRelease;
        return { state: 'committed', receipt: { stored: true } };
      },
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    await started;

    await expect(h.broker.reconcilePendingCommits()).resolves.toMatchObject({
      committed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(commits).toBe(1);

    releaseCommit();
    await expect(completion).resolves.toMatchObject({
      accepted: true,
      committed: true,
      commitState: 'committed',
    });
    expect(commits).toBe(1);
  });

  test('commit recovery cannot reuse an ended connected-host session', async () => {
    let sessionActive = true;
    let commitAttempts = 0;
    const h = harness({
      sessionActive: (sessionId, principalDid) =>
        sessionActive && sessionId === 'sess-connected' && principalDid === AGENT,
      commit: () => {
        commitAttempts += 1;
        throw new Error('commit store unavailable');
      },
    });
    h.register('claude', AGENT, OWNER, 'connected_host');
    h.submit({ backendBindingId: 'claude' });
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
      authenticatedSessionId: 'sess-connected',
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      authenticatedSessionId: 'sess-connected',
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({ accepted: true, commitState: 'failed' });
    expect(commitAttempts).toBe(1);

    sessionActive = false;
    h.advance(2_000);
    await expect(h.broker.reconcilePendingCommits()).resolves.toMatchObject({
      committed: 0,
      failed: 1,
    });
    expect(commitAttempts).toBe(1);
    expect(h.workflows.listEventsForTask(claim.taskId).at(-1)).toMatchObject({
      event_kind: 'reasoning_commit_stale_authority',
    });

    await expect(h.broker.reconcilePendingCommits()).resolves.toMatchObject({
      committed: 0,
      failed: 0,
      skipped: 1,
    });
  });

  test('does not replay a durable pending-approval commit receipt', async () => {
    let commits = 0;
    const h = harness({
      commit: () => {
        commits += 1;
        return {
          state: 'pending_approval',
          receipt: { proposal_id: 'stg-pending' },
        };
      },
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: true,
      commitState: 'pending_approval',
    });

    const reconciled = await h.broker.reconcilePendingCommits();
    expect(reconciled).toMatchObject({ committed: 0, pendingApproval: 0 });
    expect(commits).toBe(1);
  });

  test('rejects oversized commit receipts and retains the proposal for recovery', async () => {
    const h = harness({
      commit: () => ({
        state: 'committed',
        receipt: { value: 'x'.repeat(9 * 1024) },
      }),
    });
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: claim.contextProjectionHash,
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'A valid proposal.' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: true,
      committed: false,
      commitState: 'failed',
      commitError: 'reasoning commit receipt exceeds limits',
    });
  });

  test('caller-supplied context hashes cannot replace Core projections', async () => {
    const h = harness();
    h.register();
    h.submit();
    const claim = h.broker.claim({
      backendId: 'claude',
      principalDid: AGENT,
    })!;
    const completion = await h.broker.complete({
      taskId: claim.taskId,
      claimId: claim.claimId,
      contextTicketId: claim.contextTicketId,
      backendId: 'claude',
      principalDid: AGENT,
      executionId: claim.executionId,
      contextProjectionHash: reasoningHash({ substituted: true }),
      policySnapshotHash: claim.policySnapshotHash,
      result: { answer: 'substituted' },
      evidenceIds: ['memory-back-pain'],
    });
    expect(completion).toMatchObject({
      accepted: false,
      code: 'stale_claim',
    });
  });
});
