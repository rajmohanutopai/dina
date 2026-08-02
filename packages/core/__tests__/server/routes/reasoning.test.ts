import {
  CoreReasoningBroker,
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  setReasoningBackendRepository,
  setReasoningContextRepository,
  setReasoningBroker,
  isReasoningBackendPresent,
  markReasoningBackendPresent,
  resetReasoningBackendPresence,
  type PublicReasoningEvidenceSource,
} from '../../../src';
import { registerDevice, resetDeviceRegistry } from '../../../src/devices/registry';
import { setNodeDID } from '../../../src/pairing/ceremony';
import {
  createPersona,
  openPersona,
  resetPersonaState,
} from '../../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerReasoningRoutes } from '../../../src/server/routes/reasoning';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService } from '../../../src/workflow/service';

const OWNER = 'did:plc:owner';

function request(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  overrides: Partial<CoreRequest> = {},
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body ?? {})),
    params: {},
    trustedInProcess: true,
    ...overrides,
  };
}

function setup(publicEvidenceSource?: PublicReasoningEvidenceSource) {
  const workflows = new InMemoryWorkflowRepository();
  const workflowService = new WorkflowService({ repository: workflows });
  const backends = new InMemoryReasoningBackendRepository();
  const contexts = new InMemoryReasoningContextRepository();
  const sessions = new SessionRegistry();
  const broker = new CoreReasoningBroker({
    workflowService,
    workflowRepository: workflows,
    backendRepository: backends,
    contextRepository: contexts,
    isAuthenticatedSessionActive: ({ sessionId, principalDid, authorityOrigin }) =>
      sessions.authorizesAuthorityOrigin(sessionId, principalDid, authorityOrigin),
    activateAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
      sessions.activateAuthorityOrigin(sessionId, principalDid, authorityOrigin),
    releaseAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
      sessions.clearAuthorityOrigin(sessionId, principalDid, authorityOrigin).ok,
  });
  setReasoningBackendRepository(backends);
  setReasoningContextRepository(contexts);
  setReasoningBroker(broker);
  setSessionRegistry(sessions);
  const router = new CoreRouter();
  registerReasoningRoutes(router, {
    ownerCapability: 'owner-cap',
    ...(publicEvidenceSource === undefined ? {} : { publicEvidenceSource }),
  });
  return { router, backends, broker, contexts, sessions };
}

function ownerRequest(method: CoreRequest['method'], path: string, body: unknown): CoreRequest {
  return request(method, path, body, {
    callerType: 'owner',
    callerDID: OWNER,
    ownerCapability: 'owner-cap',
  });
}

function agentRequest(
  agentDid: string,
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  query: Record<string, string> = {},
): CoreRequest {
  return request(method, path, body, {
    callerType: 'agent',
    callerDID: agentDid,
    agentScope: 'coding',
    query,
  });
}

async function registerConnectedBackend(
  router: CoreRouter,
  principalDid: string,
  expectedVersion: number | null = null,
) {
  return router.handle(
    ownerRequest('POST', '/v1/reasoning/backends/register', {
      backend_id: 'claude',
      kind: 'connected_host',
      principal_did: principalDid,
      allowed_task_kinds: ['answer.compose', 'memory.structure'],
      max_sensitivity: 'sensitive',
      availability: 'foreground',
      expected_version: expectedVersion,
      expires_at: null,
    }),
  );
}

describe('connected reasoning routes', () => {
  beforeEach(() => {
    resetDeviceRegistry();
    resetPersonaState();
    setNodeDID(OWNER);
    resetReasoningBackendPresence();
  });

  afterEach(() => {
    resetDeviceRegistry();
    resetPersonaState();
    setReasoningBackendRepository(null);
    setReasoningContextRepository(null);
    setReasoningBroker(null);
    setSessionRegistry(null);
    resetReasoningBackendPresence();
  });

  test('owner registers, lists, and CAS-revokes an exact paired coding host', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkReasoningAgent', 'agent', 'coding');

    const created = await registerConnectedBackend(router, agent.did);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      backend_id: 'claude',
      principal_did: agent.did,
      policy_version: 1,
    });

    const listed = await router.handle(ownerRequest('GET', '/v1/reasoning/backends', undefined));
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      backends: [{ backend_id: 'claude', policy_version: 1 }],
    });

    const stale = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/claude/revoke', {
        expected_version: 2,
      }),
    );
    expect(stale.status).toBe(409);

    markReasoningBackendPresent('claude', agent.did);
    expect(isReasoningBackendPresent('claude', agent.did)).toBe(true);
    const revoked = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/claude/revoke', {
        expected_version: 1,
      }),
    );
    expect(revoked.status).toBe(204);
    expect(isReasoningBackendPresent('claude', agent.did)).toBe(false);
  });

  test('coding agent discovers only its own active connected-Brain bindings', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkSelfAgent', 'agent', 'coding');
    const other = registerDevice('Other', 'z6MkOtherAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const otherRegistered = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/register', {
        backend_id: 'other',
        kind: 'connected_host',
        principal_did: other.did,
        allowed_task_kinds: ['answer.compose'],
        max_sensitivity: 'personal',
        availability: 'foreground',
        expected_version: null,
        expires_at: null,
      }),
    );
    expect(otherRegistered.status).toBe(201);

    const listed = await router.handle(
      agentRequest(agent.did, 'GET', '/v1/reasoning/backends/self', undefined),
    );

    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      backends: [
        {
          backend_id: 'claude',
          principal_did: agent.did,
          kind: 'connected_host',
        },
      ],
    });
    expect(isReasoningBackendPresent('claude', agent.did)).toBe(true);
    expect(isReasoningBackendPresent('other', other.did)).toBe(false);
  });

  test('self backend discovery requires a coding-scoped agent caller', async () => {
    const { router } = setup();

    const unauthenticated = await router.handle(
      request('GET', '/v1/reasoning/backends/self', undefined),
    );
    expect(unauthenticated).toEqual({
      status: 401,
      body: { error: 'unauthenticated_backend' },
    });

    const wrongScope = await router.handle(
      request('GET', '/v1/reasoning/backends/self', undefined, {
        callerType: 'agent',
        callerDID: 'did:key:z6MkWrongScope',
        agentScope: 'runner',
      }),
    );
    expect(wrongScope).toEqual({
      status: 401,
      body: { error: 'unauthenticated_backend' },
    });
  });

  test('owner can retry an incomplete revocation cascade at the post-revoke version', async () => {
    const { router, backends, contexts } = setup();
    const agent = registerDevice('Claude', 'z6MkRetryRevokeAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);

    setReasoningContextRepository(null);
    const incomplete = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/claude/revoke', {
        expected_version: 1,
      }),
    );
    expect(incomplete).toEqual({
      status: 503,
      body: { error: 'reasoning_revocation_incomplete' },
    });
    expect(backends.get('claude')).toMatchObject({
      enabled: false,
      policyVersion: 2,
    });

    setReasoningContextRepository(contexts);
    const completed = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/claude/revoke', {
        expected_version: 2,
      }),
    );
    expect(completed).toEqual({ status: 204, body: null });

    const staleRetry = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/claude/revoke', {
        expected_version: 1,
      }),
    );
    expect(staleRetry).toEqual({
      status: 409,
      body: { error: 'policy_version_conflict' },
    });
  });

  test('registration rejects an unpaired principal and always-on connected host', async () => {
    const { router } = setup();
    const unpaired = await registerConnectedBackend(router, 'did:key:z6MkMissing');
    expect(unpaired.status).toBe(404);

    const agent = registerDevice('Claude', 'z6MkForegroundAgent', 'agent', 'coding');
    const alwaysOn = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/register', {
        backend_id: 'claude',
        kind: 'connected_host',
        principal_did: agent.did,
        allowed_task_kinds: ['answer.compose'],
        max_sensitivity: 'sensitive',
        availability: 'always_on',
        expected_version: null,
        expires_at: null,
      }),
    );
    expect(alwaysOn.status).toBe(400);
    expect(alwaysOn.body).toEqual({ error: 'connected_host_must_be_foreground' });
  });

  test('inline begin derives owner origin and sensitivity, then completes a typed result', async () => {
    const { router, sessions } = setup();
    createPersona('general', 'default');
    openPersona('general');
    const agent = registerDevice('Claude', 'z6MkInlineAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    markReasoningBackendPresent('claude', agent.did);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'claude-turn-1' });

    const begun = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        backend_id: 'claude',
        session_id: session.sessionId,
        task_kind: 'answer.compose',
        input: { query: 'What should I work on next?' },
        idempotency_key: 'turn-1-answer',
        personas: ['general'],
        limit: 5,
      }),
    );
    expect(begun.status).toBe(200);
    const claim = (begun.body as { claim: Record<string, unknown> }).claim;
    expect(claim).toMatchObject({
      taskKind: 'answer.compose',
      authorityOrigin: {
        kind: 'owner_interactive',
        ownerDid: OWNER,
        requesterDid: OWNER,
      },
      context: expect.objectContaining({
        items: [],
        scrubbed: true,
        sensitivity: 'personal',
      }),
    });

    const completed = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${String(claim.taskId)}/complete`, {
        backend_id: 'claude',
        session_id: session.sessionId,
        claim_id: claim.claimId,
        context_ticket_id: claim.contextTicketId,
        execution_id: claim.executionId,
        context_projection_hash: claim.contextProjectionHash,
        policy_snapshot_hash: claim.policySnapshotHash,
        result: { answer: 'Finish the release validation pass.' },
        evidence_ids: [],
      }),
    );
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      accepted: true,
      code: 'completed',
      committed: true,
    });
  });

  test('inline begin validates and enforces context scoping options', async () => {
    const { router, sessions } = setup();
    createPersona('general', 'default');
    openPersona('general');
    const agent = registerDevice('Claude', 'z6MkScopedInlineAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'scoped-turn' });
    const base = {
      backend_id: 'claude',
      session_id: session.sessionId,
    };

    const unknownPersona = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        ...base,
        task_kind: 'answer.compose',
        input: { query: 'Use only a vault that does not exist.' },
        personas: ['does-not-exist'],
      }),
    );
    expect(unknownPersona).toEqual({
      status: 400,
      body: { error: 'unknown_context_persona' },
    });

    const wrongTask = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        ...base,
        task_kind: 'memory.structure',
        input: { text: 'Remember this.' },
        personas: ['general'],
      }),
    );
    expect(wrongTask).toEqual({
      status: 400,
      body: { error: 'context_options_not_supported' },
    });

    const unsupported = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        ...base,
        task_kind: 'answer.compose',
        input: { query: 'Reject unknown authority-like options.' },
        personas: ['general'],
        arbitrary_context: true,
      }),
    );
    expect(unsupported).toEqual({
      status: 400,
      body: { error: 'unsupported_reasoning_field' },
    });
  });

  test('inline begin cannot escape a non-owner reservation through another session', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkNonOwnerBeginAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const reserved = sessions.start({
      agentDid: agent.did,
      hostSessionId: 'service-worker',
    });
    const alternate = sessions.start({
      agentDid: agent.did,
      hostSessionId: 'alternate-owner-session',
    });
    expect(
      sessions.activateAuthorityOrigin(reserved.sessionId, agent.did, {
        kind: 'service_request',
        ownerDid: OWNER,
        requesterDid: 'did:plc:requester',
        ingress: 'd2d',
        correlationId: 'service-query-1',
        authenticatedAtMs: 1,
      }),
    ).toBe(true);

    for (const session of [reserved, alternate]) {
      const response = await router.handle(
        agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
          backend_id: 'claude',
          session_id: session.sessionId,
          task_kind: 'answer.compose',
          input: { query: 'Treat this as owner work.' },
        }),
      );
      expect(response).toEqual({
        status: 403,
        body: { error: 'inline_begin_requires_owner_authority' },
      });
    }
  });

  test('a replacement session for the same DID cannot reuse an earlier claim ticket', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkSessionBoundAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    markReasoningBackendPresent('claude', agent.did);
    const original = sessions.start({
      agentDid: agent.did,
      hostSessionId: 'original-host-session',
    });

    const begun = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        backend_id: 'claude',
        session_id: original.sessionId,
        task_kind: 'answer.compose',
        input: { query: 'Keep this claim bound to the original session.' },
      }),
    );
    expect(begun.status).toBe(200);
    const claim = (
      begun.body as {
        claim: {
          taskId: string;
          claimId: string;
          contextTicketId: string;
          executionId: string;
          contextProjectionHash: string | null;
          policySnapshotHash: string;
        };
      }
    ).claim;

    const replacement = sessions.start({
      agentDid: agent.did,
      hostSessionId: 'replacement-host-session',
    });
    const shared = {
      backend_id: 'claude',
      session_id: replacement.sessionId,
      claim_id: claim.claimId,
      context_ticket_id: claim.contextTicketId,
    };
    const heartbeat = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${claim.taskId}/heartbeat`, shared),
    );
    expect(heartbeat).toEqual({
      status: 409,
      body: { ok: false, error: 'stale_claim' },
    });

    const failed = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${claim.taskId}/fail`, {
        ...shared,
        error: 'replacement session attempted failure',
        retryable: false,
      }),
    );
    expect(failed).toEqual({
      status: 409,
      body: { accepted: false, state: 'rejected', code: 'ticket_invalid' },
    });

    const replacementCompletion = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${claim.taskId}/complete`, {
        ...shared,
        execution_id: claim.executionId,
        context_projection_hash: claim.contextProjectionHash,
        policy_snapshot_hash: claim.policySnapshotHash,
        result: { answer: 'This must not be accepted.' },
        evidence_ids: [],
      }),
    );
    expect(replacementCompletion).toMatchObject({
      status: 409,
      body: { accepted: false, state: 'rejected', code: 'ticket_invalid' },
    });

    const originalCompletion = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${claim.taskId}/complete`, {
        backend_id: 'claude',
        session_id: original.sessionId,
        claim_id: claim.claimId,
        context_ticket_id: claim.contextTicketId,
        execution_id: claim.executionId,
        context_projection_hash: claim.contextProjectionHash,
        policy_snapshot_hash: claim.policySnapshotHash,
        result: { answer: 'Only the original session may complete this claim.' },
        evidence_ids: [],
      }),
    );
    expect(originalCompletion).toMatchObject({
      status: 200,
      body: { accepted: true, code: 'completed' },
    });
  });

  test('schema-invalid output from a session-bound claim terminalizes the job', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkInvalidOutputAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    markReasoningBackendPresent('claude', agent.did);
    const session = sessions.start({
      agentDid: agent.did,
      hostSessionId: 'invalid-output-session',
    });
    const begun = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        backend_id: 'claude',
        session_id: session.sessionId,
        task_kind: 'answer.compose',
        input: { query: 'Return a typed answer.' },
      }),
    );
    expect(begun.status).toBe(200);
    const claim = (
      begun.body as {
        claim: {
          taskId: string;
          claimId: string;
          contextTicketId: string;
          executionId: string;
          contextProjectionHash: string | null;
          policySnapshotHash: string;
        };
      }
    ).claim;

    const completion = await router.handle(
      agentRequest(agent.did, 'POST', `/v1/reasoning/${claim.taskId}/complete`, {
        backend_id: 'claude',
        session_id: session.sessionId,
        claim_id: claim.claimId,
        context_ticket_id: claim.contextTicketId,
        execution_id: claim.executionId,
        context_projection_hash: claim.contextProjectionHash,
        policy_snapshot_hash: claim.policySnapshotHash,
        result: { wrong: 'shape' },
        evidence_ids: [],
      }),
    );
    expect(completion).toMatchObject({
      status: 409,
      body: { accepted: false, code: 'invalid_result' },
    });

    const job = await router.handle(
      ownerRequest('GET', `/v1/owner/reasoning/jobs/${claim.taskId}`, undefined),
    );
    expect(job).toMatchObject({
      status: 200,
      body: { job: { state: 'failed' } },
    });
  });

  test('inline begin claims the job it created, not an older queued backend job', async () => {
    const { router, sessions, broker } = setup();
    const agent = registerDevice('Claude', 'z6MkExactClaimAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'exact-turn' });
    const older = broker.submit({
      taskKind: 'answer.compose',
      ownerDid: OWNER,
      authorityOrigin: {
        kind: 'owner_interactive',
        ownerDid: OWNER,
        ingress: 'coding_host',
        correlationId: 'older-turn',
        authenticatedAtMs: Date.now(),
      },
      input: { query: 'Older queued question' },
      sensitivity: 'personal',
      evidencePolicy: 'none',
      purpose: 'older queued job',
      backendBindingId: 'claude',
    });

    const begun = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        backend_id: 'claude',
        session_id: session.sessionId,
        task_kind: 'answer.compose',
        input: { query: 'Current inline question' },
      }),
    );
    expect(begun.status).toBe(200);
    const body = begun.body as {
      submission: { taskId: string };
      claim: { taskId: string };
    };
    expect(body.claim.taskId).toBe(body.submission.taskId);
    expect(body.claim.taskId).not.toBe(older.taskId);
  });

  test('rejects caller-supplied authority and does not create work', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkSpoofAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'claude-turn-2' });

    for (const field of ['owner_did', 'authority_origin', 'profile', 'policy_version', 'context']) {
      const result = await router.handle(
        agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
          backend_id: 'claude',
          session_id: session.sessionId,
          task_kind: 'answer.compose',
          input: { query: 'spoof' },
          [field]: field === 'owner_did' ? 'did:plc:attacker' : 'attacker-value',
        }),
      );
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'caller_authority_not_accepted' });
    }
  });

  test('requires a live DID-bound session for every connected-host operation', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkSessionAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);

    const begin = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/begin', {
        backend_id: 'claude',
        task_kind: 'answer.compose',
        input: { query: 'No session' },
      }),
    );
    expect(begin.status).toBe(401);

    const claim = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/claim', {
        backend_id: 'claude',
        session_id: 'sess-forged',
      }),
    );
    expect(claim.status).toBe(401);
  });

  test('a foreign authenticated DID cannot probe or use another backend', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkOwnerAgent', 'agent', 'coding');
    const other = registerDevice('Other', 'z6MkOtherAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const otherSession = sessions.start({ agentDid: other.did, hostSessionId: 'other-turn' });

    const result = await router.handle(
      agentRequest(other.did, 'POST', '/v1/reasoning/claim', {
        backend_id: 'claude',
        session_id: otherSession.sessionId,
      }),
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'reasoning_backend_unavailable' });
  });

  test('status uses signed query parameters and never trusts a JSON body on GET', async () => {
    const { router, sessions } = setup();
    const agent = registerDevice('Claude', 'z6MkStatusAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'status-turn' });

    const status = await router.handle(
      agentRequest(agent.did, 'GET', '/v1/reasoning/status', undefined, {
        backend_id: 'claude',
        session_id: session.sessionId,
      }),
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ backendIds: ['claude'], queued: 0, running: 0 });
  });

  test('owner submits and reads a durable payload-free job projection', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkOwnerSubmitAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);

    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'My unreleased project codename is Bluebird.' },
        backend_id: 'claude',
        idempotency_key: 'owner-answer-bluebird',
      }),
    );
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      submission: { state: 'queued', deduplicated: false },
      job: {
        taskKind: 'answer.compose',
        state: 'queued',
        backendId: 'claude',
      },
    });
    expect(JSON.stringify(submitted.body)).not.toContain('Bluebird');

    const taskId = String((submitted.body as { submission: { taskId: string } }).submission.taskId);
    const fetched = await router.handle(
      ownerRequest('GET', `/v1/owner/reasoning/jobs/${taskId}`, undefined),
    );
    const listed = await router.handle(ownerRequest('GET', '/v1/owner/reasoning/jobs', undefined));
    expect(fetched.status).toBe(200);
    expect(listed.status).toBe(200);
    expect(fetched.body).toMatchObject({ job: { taskId } });
    expect(listed.body).toMatchObject({ jobs: [{ taskId }] });
    for (const projection of [fetched.body, listed.body]) {
      const encoded = JSON.stringify(projection);
      expect(encoded).not.toContain('Bluebird');
      expect(encoded).not.toContain('projectionId');
      expect(encoded).not.toContain('policySnapshotHash');
      expect(encoded).not.toContain('ownerDid');
    }
  });

  test('Core selects the default backend after deriving request sensitivity', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkCoreSelectAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    markReasoningBackendPresent('claude', agent.did);

    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'Choose the best next step.' },
        idempotency_key: 'owner-core-select',
      }),
    );
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      job: { backendId: 'claude' },
    });
  });

  test('owner work queues for an authorized foreground Brain that is currently closed', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkOfflineBrainAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    // No runtime-presence heartbeat: the connected host is closed.
    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'Answer this when my foreground Brain returns.' },
        idempotency_key: 'offline-foreground-answer',
      }),
    );

    expect(submitted).toMatchObject({
      status: 202,
      body: {
        submission: { state: 'queued' },
        job: {
          state: 'queued',
          backendId: 'claude',
        },
      },
    });
  });

  test('owner submission fails closed when managed reasoning has no eligible backend', async () => {
    const { router } = setup();
    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'Do not silently run this elsewhere.' },
        idempotency_key: 'owner-no-backend',
      }),
    );
    expect(submitted.status).toBe(503);
    expect(submitted.body).toEqual({ error: 'reasoning_backend_unavailable' });
  });

  test('owner answer projects public evidence with opaque IDs into the exact backend claim', async () => {
    const publicEvidenceSource: PublicReasoningEvidenceSource = {
      searchReviews: async () => [
        {
          externalId: 'at://did:plc:reviewer/com.dinakernel.peerlens.attestation/chair',
          text: 'A reviewer found the lumbar support effective. Contact: alice@example.com',
          confidence: 0.75,
        },
      ],
      searchServices: async () => [
        {
          externalId: 'at://did:plc:shop/com.dinakernel.service.profile/chairs',
          text: 'Chair finder service.',
        },
      ],
    };
    const { router, sessions } = setup(publicEvidenceSource);
    const agent = registerDevice('Claude', 'z6MkEvidenceAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const session = sessions.start({ agentDid: agent.did, hostSessionId: 'evidence-turn' });

    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'Find a supportive chair' },
        backend_id: 'claude',
        idempotency_key: 'owner-chair-evidence',
        public_evidence_sources: ['review', 'service'],
      }),
    );
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      restricted_personas: [],
      unavailable_sources: [],
    });

    const claimed = await router.handle(
      agentRequest(agent.did, 'POST', '/v1/reasoning/claim', {
        backend_id: 'claude',
        session_id: session.sessionId,
      }),
    );
    expect(claimed.status).toBe(200);
    const claim = (claimed.body as { claim: Record<string, unknown> }).claim;
    expect(claim).toMatchObject({
      taskKind: 'answer.compose',
      context: {
        scrubbed: true,
        sensitivity: 'personal',
        items: [
          expect.objectContaining({
            sourceId: expect.stringMatching(/^review:[a-f0-9]{32}$/),
            sourceType: 'review',
            text: expect.stringContaining('[EMAIL_1]'),
          }),
          expect.objectContaining({
            sourceId: expect.stringMatching(/^service:[a-f0-9]{32}$/),
            sourceType: 'service',
            text: expect.stringContaining('metadata, not an executed service'),
          }),
        ],
      },
      allowedEvidenceIds: [
        expect.stringMatching(/^review:[a-f0-9]{32}$/),
        expect.stringMatching(/^service:[a-f0-9]{32}$/),
      ],
    });
    expect(JSON.stringify(claim)).not.toContain('at://');
    expect(JSON.stringify(claim)).not.toContain('alice@example.com');
  });

  test('owner submission reports unavailable public sources without failing the job', async () => {
    const publicEvidenceSource: PublicReasoningEvidenceSource = {
      searchReviews: async () => {
        throw new Error('review AppView unavailable');
      },
      searchServices: async () => [],
    };
    const { router } = setup(publicEvidenceSource);
    const agent = registerDevice('Claude', 'z6MkPartialEvidenceAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);

    const submitted = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'answer.compose',
        input: { query: 'What should I buy?' },
        backend_id: 'claude',
        idempotency_key: 'owner-partial-evidence',
        public_evidence_sources: ['review', 'service'],
      }),
    );

    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      submission: { state: 'queued' },
      unavailable_sources: ['review'],
    });
  });

  test('owner submission is idempotent and a changed retry conflicts', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkOwnerRetryAgent', 'agent', 'coding');
    expect((await registerConnectedBackend(router, agent.did)).status).toBe(201);
    const body = {
      task_kind: 'answer.compose',
      input: { query: 'What is next?' },
      backend_id: 'claude',
      idempotency_key: 'owner-answer-retry',
    };

    const first = await router.handle(ownerRequest('POST', '/v1/owner/reasoning/jobs', body));
    const retry = await router.handle(ownerRequest('POST', '/v1/owner/reasoning/jobs', body));
    const changed = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        ...body,
        input: { query: 'What changed?' },
      }),
    );

    expect(first.status).toBe(202);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      submission: {
        taskId: (first.body as { submission: { taskId: string } }).submission.taskId,
        deduplicated: true,
      },
    });
    expect(changed).toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  test('owner cannot supply authority or create service-origin reasoning work', async () => {
    const { router } = setup();
    for (const body of [
      {
        task_kind: 'answer.compose',
        input: { query: 'Spoof authority' },
        idempotency_key: 'owner-spoof-origin',
        authority_origin: { kind: 'service_request' },
      },
      {
        task_kind: 'service.respond',
        input: { capabilityId: 'appointment_book', params: {} },
        idempotency_key: 'owner-service-response',
      },
      {
        task_kind: 'review.summarize',
        input: { query: 'Summarize without evidence' },
        idempotency_key: 'owner-review-without-evidence',
      },
    ]) {
      const result = await router.handle(ownerRequest('POST', '/v1/owner/reasoning/jobs', body));
      expect(result.status).toBe(400);
    }
  });

  test('Core-derived sensitivity prevents a personal-only backend from structuring memory', async () => {
    const { router } = setup();
    const agent = registerDevice('Claude', 'z6MkPersonalOnlyAgent', 'agent', 'coding');
    const registered = await router.handle(
      ownerRequest('POST', '/v1/reasoning/backends/register', {
        backend_id: 'personal-only',
        kind: 'connected_host',
        principal_did: agent.did,
        allowed_task_kinds: ['memory.structure'],
        max_sensitivity: 'personal',
        availability: 'foreground',
        expected_version: null,
        expires_at: null,
      }),
    );
    expect(registered.status).toBe(201);

    const result = await router.handle(
      ownerRequest('POST', '/v1/owner/reasoning/jobs', {
        task_kind: 'memory.structure',
        input: { text: 'My health condition is private.' },
        backend_id: 'personal-only',
        idempotency_key: 'owner-sensitive-memory',
      }),
    );
    expect(result).toMatchObject({
      status: 403,
      body: { error: 'backend_not_allowed' },
    });
  });

  test('non-owner callers cannot list another owner reasoning jobs', async () => {
    const { router } = setup();
    const result = await router.handle(
      request('GET', '/v1/owner/reasoning/jobs', undefined, {
        callerType: 'device',
        callerDID: 'did:plc:other-owner',
      }),
    );
    expect(result.status).toBe(403);
  });
});
