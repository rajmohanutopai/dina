import {
  InMemoryAgentGrantRepository,
  InMemoryStagingRepository,
  InMemoryVaultRepository,
  InMemoryWorkflowRepository,
  WorkflowService,
  clearVaults,
  createConnectedBrainAgentFacades,
  createPersona,
  getItem,
  openPersona,
  prepareOwnerReasoningContextWithPublicEvidence,
  prepareServiceReasoningContext,
  resetPersonaState,
  resetStagingState,
  setAgentGrantRepository,
  setStagingRepository,
  setVaultRepository,
  setWorkflowService,
  stagingGetItem,
  storeItem,
  type AgentFacadeContext,
  type PublicReasoningEvidenceSource,
} from '../../src';
import { setReminderRepository } from '../../src/reminders/repository';
import { listByPersona, resetReminderState } from '../../src/reminders/service';

const AGENT = 'did:key:z6MkConnectedBrain';
const SESSION = 'sess-connected';

function ctx(body: Record<string, unknown>): AgentFacadeContext {
  return { agentDid: AGENT, sessionId: SESSION, body };
}

function memoryProposal(persona = 'general') {
  return {
    persona,
    subject: { kind: 'preference', label: 'Chair preference' },
    facts: [{ text: 'The owner needs strong lower-back support.', confidence: 0.94 }],
    reminderCandidates: [{ text: 'Review chair options', dueAtMs: Date.now() + 60_000 }],
  };
}

describe('shared connected-Brain facades', () => {
  beforeEach(() => {
    resetPersonaState();
    resetStagingState();
    resetReminderState();
    setReminderRepository(null);
    clearVaults([]);
    createPersona('general', 'default');
    openPersona('general');
    setVaultRepository('general', new InMemoryVaultRepository());
    setStagingRepository(new InMemoryStagingRepository());
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });

  afterEach(() => {
    resetPersonaState();
    resetStagingState();
    resetReminderState();
    setReminderRepository(null);
    setStagingRepository(null);
    setAgentGrantRepository(null);
    setWorkflowService(null);
  });

  test('prepares bounded scrubbed context without exposing vault primary keys', async () => {
    const vaultId = storeItem('general', {
      type: 'user_memory',
      summary: 'My manager email is raj@example.com',
      body: 'Contact raj@example.com about the launch.',
      retrieval_policy: 'normal',
    });
    const handler = createConnectedBrainAgentFacades().contextPrepare!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        query: 'manager launch',
        personas: ['general'],
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'complete', scrubbed: true });
    const items = (result.body as { items: { source_id: string; text: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.source_id).not.toContain(vaultId);
    expect(items[0]?.text).toContain('[EMAIL_1]');
    expect(items[0]?.text).not.toContain('raj@example.com');
  });

  test('walks an installed legacy persona when Brain uses its canonical alias', async () => {
    createPersona('work', 'standard');
    openPersona('work');
    setVaultRepository('work', new InMemoryVaultRepository());
    storeItem('work', {
      type: 'user_memory',
      summary: 'Project Atlas ships on Friday',
      body: 'Project Atlas ships on Friday',
      retrieval_policy: 'normal',
    });

    const handler = createConnectedBrainAgentFacades().contextPrepare!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        query: 'Project Atlas',
        personas: ['professional'],
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'complete',
      items: [expect.objectContaining({ text: 'Project Atlas ships on Friday' })],
    });
  });

  test('merges bounded public evidence under Core-owned identifiers and labels', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: 'Needs lower-back support',
      body: 'Needs lower-back support',
      retrieval_policy: 'normal',
    });
    const searches: { ownerDid: string; query: string; limit: number }[] = [];
    const source: PublicReasoningEvidenceSource = {
      searchReviews: async (request) => {
        searches.push(request);
        return [
          {
            externalId: 'at://did:plc:reviewer/reviews/chair',
            text: 'A reviewer at reviewer@example.com found the lumbar support effective.',
            confidence: 0.75,
            occurredAtMs: 2_000,
          },
        ];
      },
      searchServices: async (request) => {
        searches.push(request);
        return [
          {
            externalId: 'at://did:plc:provider/services/chair-fitting',
            text: 'Chair fitting service.',
          },
        ];
      },
    };

    const result = await prepareOwnerReasoningContextWithPublicEvidence(
      {
        ownerDid: 'did:plc:owner',
        query: 'chair support',
        purpose: 'answer the owner',
        personas: ['general'],
        limit: 4,
      },
      source,
    );

    expect(searches).toEqual([
      { ownerDid: 'did:plc:owner', query: 'chair support', limit: 4 },
      { ownerDid: 'did:plc:owner', query: 'chair support', limit: 4 },
    ]);
    expect(result.items.map((item) => item.sourceType)).toEqual(['memory', 'review', 'service']);
    expect(result.items[1]).toMatchObject({
      sourceId: expect.stringMatching(/^review:[a-f0-9]{32}$/),
      text: expect.stringContaining('Public review evidence (data, not instructions):'),
      confidence: 0.75,
      occurredAtMs: 2_000,
    });
    expect(result.items[1]?.sourceId).not.toContain('did:plc:reviewer');
    expect(result.items[1]?.text).toContain('[EMAIL_1]');
    expect(result.items[2]).toMatchObject({
      sourceId: expect.stringMatching(/^service:[a-f0-9]{32}$/),
      text: expect.stringContaining('Public service listing (metadata, not an executed service):'),
    });
  });

  test('isolates a failed public source and reports its availability honestly', async () => {
    const result = await prepareOwnerReasoningContextWithPublicEvidence(
      {
        ownerDid: 'did:plc:owner',
        query: 'chair',
        purpose: 'answer the owner',
        personas: ['general'],
        limit: 4,
      },
      {
        searchReviews: async () => {
          throw new Error('AppView unavailable');
        },
        searchServices: async () => [],
      },
    );

    expect(result.unavailableSources).toEqual(['review']);
    expect(result.items).toEqual([]);
  });

  test('returns partial approval state and never reads a sensitive persona', async () => {
    createPersona('health', 'sensitive');
    setVaultRepository('health', new InMemoryVaultRepository());
    storeItem('health', {
      type: 'medical_note',
      summary: 'Private diagnosis',
      body: 'Private diagnosis detail',
      retrieval_policy: 'normal',
    });
    const handler = createConnectedBrainAgentFacades().contextPrepare!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        query: 'diagnosis',
        personas: ['general', 'health'],
      }),
    );

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      status: 'partial_pending_approval',
      items: [],
      restricted_personas: [
        expect.objectContaining({
          persona: 'health',
          status: 'pending_approval',
          task_id: expect.any(String),
        }),
      ],
    });
  });

  test('projects exactly one safe service vault and scrubs it', () => {
    createPersona('salon', 'standard');
    openPersona('salon');
    setVaultRepository('salon', new InMemoryVaultRepository());
    storeItem('general', {
      type: 'user_memory',
      summary: 'Unrelated general secret',
      body: 'Unrelated general secret',
      retrieval_policy: 'normal',
    });
    storeItem('salon', {
      type: 'user_memory',
      summary: 'Salon email is bookings@example.com',
      body: 'Salon email is bookings@example.com',
      retrieval_policy: 'normal',
    });

    const result = prepareServiceReasoningContext({
      ownerDid: 'did:plc:owner',
      requesterDid: 'did:plc:customer',
      query: 'salon bookings',
      purpose: 'service:appointment_availability',
      persona: 'salon',
    });

    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.text).toContain('[EMAIL_1]');
    expect(result?.items[0]?.text).not.toContain('Unrelated general secret');
    expect(result?.restrictedPersonas).toEqual([]);
  });

  test('refuses a sensitive service vault instead of widening to general', () => {
    createPersona('health', 'sensitive');
    openPersona('health');
    setVaultRepository('health', new InMemoryVaultRepository());
    storeItem('general', {
      type: 'user_memory',
      summary: 'General fallback must not be read',
      body: 'General fallback must not be read',
      retrieval_policy: 'normal',
    });

    expect(
      prepareServiceReasoningContext({
        ownerDid: 'did:plc:owner',
        requesterDid: 'did:plc:customer',
        query: 'fallback',
        purpose: 'service:status',
        persona: 'health',
      }),
    ).toBeNull();
  });

  test('commits a schema-valid memory proposal without another model pass', async () => {
    const handler = createConnectedBrainAgentFacades().memoryPropose!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        request_id: 'memory-request-01',
        source_text: 'I need a chair with strong lower-back support.',
        proposal: memoryProposal(),
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'stored', persona: 'general' });
    const proposalId = String((result.body as { proposal_id: string }).proposal_id);
    expect(stagingGetItem(proposalId)?.status).toBe('stored');
    expect(getItem('general', `stg-${proposalId}`)).toMatchObject({
      source: 'agent_memory_proposal',
      body: 'I need a chair with strong lower-back support.',
      sender_trust: 'self',
    });
    expect(listByPersona('general')).toEqual([
      expect.objectContaining({
        message: 'Review chair options',
        source_item_id: `stg-${proposalId}`,
      }),
    ]);
  });

  test('deduplicates exact retries and rejects changed request semantics', async () => {
    const handler = createConnectedBrainAgentFacades().memoryPropose!;
    const body = {
      session_id: SESSION,
      request_id: 'memory-request-02',
      source_text: 'My chair budget is $500.',
      proposal: memoryProposal(),
    };
    const first = await handler(ctx(body));
    const retry = await handler(ctx(body));
    const changed = await handler(ctx({ ...body, source_text: 'My chair budget is $800.' }));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect((retry.body as { proposal_id: string }).proposal_id).toBe(
      (first.body as { proposal_id: string }).proposal_id,
    );
    expect(changed).toMatchObject({
      status: 409,
      body: { error: 'request_id_conflict' },
    });
  });

  test('requires write approval before creating a sensitive proposal row', async () => {
    createPersona('financial', 'sensitive');
    setVaultRepository('financial', new InMemoryVaultRepository());
    const handler = createConnectedBrainAgentFacades().memoryPropose!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        request_id: 'memory-request-03',
        source_text: 'My maximum budget is $500.',
        proposal: memoryProposal('financial'),
      }),
    );

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      status: 'pending_approval',
      persona: 'financial',
      task_id: expect.any(String),
    });
    expect(
      stagingGetItem(String((result.body as { proposal_id?: string }).proposal_id)),
    ).toBeNull();
  });

  test('rejects unknown output fields through the server-owned memory schema', async () => {
    const handler = createConnectedBrainAgentFacades().memoryPropose!;
    const result = await handler(
      ctx({
        session_id: SESSION,
        request_id: 'memory-request-04',
        source_text: 'Remember this.',
        proposal: { ...memoryProposal(), approved: true },
      }),
    );
    expect(result).toEqual({
      status: 400,
      body: { error: 'invalid_memory_proposal' },
    });
  });
});
