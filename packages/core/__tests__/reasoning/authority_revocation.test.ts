import {
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  isReasoningBackendPresent,
  markReasoningBackendPresent,
  resetReasoningBackendPresence,
  revokeReasoningAuthorityForPrincipal,
  SessionRegistry,
  setReasoningBackendRepository,
  setReasoningContextRepository,
  setSessionRegistry,
} from '../../src';

const OWNER = 'did:plc:owner';
const PRINCIPAL = 'did:key:zConnectedBrain';

describe('reasoning authority revocation', () => {
  afterEach(() => {
    setReasoningBackendRepository(null);
    setReasoningContextRepository(null);
    setSessionRegistry(null);
    resetReasoningBackendPresence();
  });

  test('revokes all bindings, live presence, and outstanding tickets for a principal', () => {
    const backends = new InMemoryReasoningBackendRepository();
    const contexts = new InMemoryReasoningContextRepository();
    setReasoningBackendRepository(backends);
    setReasoningContextRepository(contexts);
    const sessions = new SessionRegistry(() => 2_000);
    setSessionRegistry(sessions);
    const session = sessions.start({
      agentDid: PRINCIPAL,
      hostSessionId: 'host-session',
    });
    const binding = backends.register({
      backendId: 'claude',
      kind: 'connected_host',
      principalDid: PRINCIPAL,
      allowedTaskKinds: ['answer.compose'],
      maxSensitivity: 'personal',
      availability: 'foreground',
      selectedByOwnerDid: OWNER,
      expectedVersion: null,
      nowMs: 1_000,
    });
    contexts.createTicket({
      ticketId: 'ticket-1',
      taskId: 'task-1',
      claimId: 'claim-1',
      backendId: binding.backendId,
      principalDid: PRINCIPAL,
      authenticatedSessionId: null,
      ownerDid: OWNER,
      purpose: 'owner ask',
      policyVersion: binding.policyVersion,
      inputProjectionId: 'projection-1',
      contextProjectionId: null,
      createdAtMs: 1_000,
      expiresAtMs: 10_000,
      consumedAtMs: null,
      revokedAtMs: null,
    });
    markReasoningBackendPresent(binding.backendId, PRINCIPAL, 2_000);

    expect(revokeReasoningAuthorityForPrincipal(PRINCIPAL, 3_000)).toEqual({
      available: true,
      ok: true,
      bindingsRevoked: 1,
      ticketsRevoked: 1,
      sessionsEnded: 1,
    });
    expect(backends.get(binding.backendId)).toMatchObject({
      enabled: false,
      revokedAtMs: 3_000,
    });
    expect(contexts.getTicket('ticket-1')).toMatchObject({ revokedAtMs: 3_000 });
    expect(sessions.get(session.sessionId)).toMatchObject({
      endedAtMs: 2_000,
      endReason: 'authority_revoked',
    });
    expect(isReasoningBackendPresent(binding.backendId, PRINCIPAL, 3_000)).toBe(false);
  });

  test('fails closed when only half of the reasoning repository pair is wired', () => {
    setReasoningBackendRepository(new InMemoryReasoningBackendRepository());
    setSessionRegistry(new SessionRegistry());

    expect(revokeReasoningAuthorityForPrincipal(PRINCIPAL, 3_000)).toEqual({
      available: true,
      ok: false,
      bindingsRevoked: 0,
      ticketsRevoked: 0,
      sessionsEnded: 0,
    });
  });

  test('backend revoke route can retry the original CAS after an incomplete cascade', async () => {
    const { CoreRouter } = await import('../../src/server/router');
    const { registerReasoningRoutes } = await import('../../src/server/routes/reasoning');
    const { setNodeDID } = await import('../../src/pairing/ceremony');
    const backends = new InMemoryReasoningBackendRepository();
    setReasoningBackendRepository(backends);
    setReasoningContextRepository(new InMemoryReasoningContextRepository());
    setNodeDID(OWNER);
    backends.register({
      backendId: 'retryable',
      kind: 'connected_host',
      principalDid: PRINCIPAL,
      allowedTaskKinds: ['answer.compose'],
      maxSensitivity: 'personal',
      availability: 'foreground',
      selectedByOwnerDid: OWNER,
      expectedVersion: null,
      nowMs: 1_000,
    });
    const router = new CoreRouter();
    const ownerCapability = 'owner-capability';
    registerReasoningRoutes(router, ownerCapability);
    const request = (expectedVersion: number) =>
      router.handle({
        method: 'POST',
        path: '/v1/reasoning/backends/retryable/revoke',
        params: { id: 'retryable' },
        query: {},
        headers: {},
        body: { expected_version: expectedVersion },
        rawBody: new Uint8Array(),
        trustedInProcess: true,
        callerType: 'owner',
        ownerCapability,
      });

    // Missing session registry makes the first cascade incomplete, after the
    // backend CAS itself has committed.
    expect((await request(1)).status).toBe(503);
    expect(backends.get('retryable')).toMatchObject({
      enabled: false,
      policyVersion: 2,
    });

    setSessionRegistry(new SessionRegistry());
    expect((await request(2)).status).toBe(204);
  });
});
