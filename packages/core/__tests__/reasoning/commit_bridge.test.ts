import {
  InMemoryStagingRepository,
  InMemoryVaultRepository,
  InMemoryWorkflowRepository,
  WorkflowService,
  clearVaults,
  createPersona,
  createReasoningCommitBridge,
  getItem,
  openPersona,
  resetPersonaState,
  resetStagingState,
  setStagingRepository,
  setVaultRepository,
  setWorkflowService,
  stagingGetItem,
  type AuthorityOrigin,
  type ReasoningTaskEnvelopeV1,
  type ReasoningTaskKind,
  type ReasoningValidatedProposal,
  type WorkflowTask,
} from '../../src';
import { setReminderRepository } from '../../src/reminders/repository';
import { listByPersona, resetReminderState } from '../../src/reminders/service';

const OWNER = 'did:plc:owner';
const AGENT = 'did:key:connected';

function origin(kind: AuthorityOrigin['kind'] = 'owner_interactive'): AuthorityOrigin {
  return {
    kind,
    ownerDid: OWNER,
    ...(kind === 'owner_interactive' ? { requesterDid: OWNER } : { requesterDid: 'did:plc:peer' }),
    ingress: kind === 'owner_interactive' ? 'mobile' : 'service',
    correlationId: 'request-1',
    authenticatedAtMs: 1_000,
  };
}

function proposal(
  taskKind: ReasoningTaskKind,
  input: unknown,
  result: unknown,
  authorityOrigin = origin(),
): ReasoningValidatedProposal {
  const taskId = `reason-${taskKind.replace('.', '-')}`;
  const envelope: ReasoningTaskEnvelopeV1 = {
    version: 1,
    taskId,
    taskKind,
    ownerDid: OWNER,
    authorityOrigin,
    authorityPolicyRef: null,
    backendBindingId: 'claude',
    requestSchemaId: `request-${taskKind}`,
    resultSchemaId: `result-${taskKind}`,
    policySnapshotHash: 'a'.repeat(64),
    inputProjectionId: `input-${taskId}`,
    inputProjectionHash: 'b'.repeat(64),
    contextProjectionId: null,
    contextProjectionHash: null,
    sensitivity: 'sensitive',
    evidencePolicy: 'none',
    allowedEvidenceIdsHash: null,
    requestFingerprint: 'c'.repeat(64),
    purpose: 'test',
    executionId: `exec-${taskId}`,
    idempotencyKey: `idem-${taskId}`,
    createdAtMs: 1_000,
    deadlineAtMs: 60_000,
    maxAttempts: 3,
  };
  const task: WorkflowTask = {
    id: taskId,
    kind: 'reasoning',
    status: 'completed',
    priority: 'normal',
    description: 'Reasoning',
    payload: JSON.stringify(envelope),
    result: JSON.stringify({ result }),
    result_summary: '',
    policy: '{}',
    agent_did: AGENT,
    created_at: 1_000,
    updated_at: 2_000,
  };
  return {
    task,
    envelope,
    input,
    context: null,
    result,
    evidenceIds: [],
    backendPrincipalDid: AGENT,
    authenticatedSessionId: 'host-session',
  };
}

function memoryResult(persona = 'general') {
  return {
    persona,
    subject: { kind: 'preference', label: 'Chair preference' },
    facts: [{ text: 'Needs strong lower-back support.', confidence: 0.95 }],
    reminderCandidates: [{ text: 'Review chairs', dueAtMs: 50_000 }],
  };
}

describe('reasoning commit bridge', () => {
  beforeEach(() => {
    resetPersonaState();
    resetStagingState();
    resetReminderState();
    setReminderRepository(null);
    clearVaults([]);
    setStagingRepository(new InMemoryStagingRepository());
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    createPersona('general', 'default');
    openPersona('general');
    setVaultRepository('general', new InMemoryVaultRepository());
  });

  afterEach(() => {
    resetPersonaState();
    resetStagingState();
    resetReminderState();
    setReminderRepository(null);
    setStagingRepository(null);
    setWorkflowService(null);
  });

  test('commits owner memory through staging and is idempotent on replay', async () => {
    const bridge = createReasoningCommitBridge();
    const work = proposal(
      'memory.structure',
      { text: 'I need a chair with lower-back support.' },
      memoryResult(),
    );

    const first = await bridge(work);
    const replay = await bridge(work);

    expect(first).toMatchObject({
      state: 'committed',
      receipt: { status: 'stored', persona: 'general' },
    });
    expect(replay).toEqual(first);
    const proposalId = String(first.receipt?.proposal_id);
    expect(stagingGetItem(proposalId)?.status).toBe('stored');
    expect(getItem('general', `stg-${proposalId}`)).toMatchObject({
      body: 'I need a chair with lower-back support.',
      source: 'agent_memory_proposal',
    });
    expect(listByPersona('general')).toHaveLength(1);
  });

  test('parks a sealed-persona memory behind a durable owner approval', async () => {
    createPersona('health', 'sensitive');
    setVaultRepository('health', new InMemoryVaultRepository());
    const bridge = createReasoningCommitBridge();

    const receipt = await bridge(
      proposal('memory.structure', { text: 'My back hurts.' }, memoryResult('health')),
    );

    expect(receipt).toMatchObject({
      state: 'pending_approval',
      receipt: {
        status: 'pending_approval',
        persona: 'health',
        task_id: expect.any(String),
      },
    });
    expect(stagingGetItem(String(receipt.receipt?.proposal_id))).toMatchObject({
      status: 'pending_unlock',
      persona: 'health',
    });
    expect(getItem('health', `stg-${String(receipt.receipt?.proposal_id)}`)).toBeNull();
  });

  test('never commits memory or reminders for non-owner authority', async () => {
    const bridge = createReasoningCommitBridge();
    await expect(
      bridge(
        proposal(
          'memory.structure',
          { text: 'Untrusted input.' },
          memoryResult(),
          origin('service_request'),
        ),
      ),
    ).rejects.toThrow('direct owner authority');
    await expect(
      bridge(
        proposal(
          'reminder.extract',
          { text: 'Remind me tomorrow', referenceTimeMs: 1_000 },
          { reminders: [{ text: 'Do it', dueAtMs: 50_000 }] },
          origin('contact_request'),
        ),
      ),
    ).rejects.toThrow('direct owner authority');
  });

  test('commits extracted reminders durably and deduplicates replay', async () => {
    const bridge = createReasoningCommitBridge();
    const work = proposal(
      'reminder.extract',
      {
        text: 'Remind me to call tomorrow.',
        referenceTimeMs: 1_000,
        preferredPersona: 'general',
      },
      { reminders: [{ text: 'Call tomorrow', dueAtMs: 50_000 }] },
    );

    await expect(bridge(work)).resolves.toMatchObject({
      state: 'committed',
      receipt: { reminder_count: 1, persona: 'general' },
    });
    await bridge(work);
    expect(listByPersona('general')).toHaveLength(1);
  });

  test('fails closed when a service response bridge is not wired', async () => {
    const bridge = createReasoningCommitBridge();
    await expect(
      bridge(
        proposal(
          'service.respond',
          { capabilityId: 'appointment_availability', params: {} },
          { result: { slots: [] } },
          origin('service_request'),
        ),
      ),
    ).rejects.toThrow('service response commit bridge is unavailable');
  });
});
