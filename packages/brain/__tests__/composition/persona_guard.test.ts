/**
 * `createPersonaGuard` — unit tests for the per-ask approval factory
 * built in 5.21-E.
 *
 * Approvals are now workflow tasks (like Go Core's dina_tasks), so the
 * mock replaces `ApprovalManager` with a minimal `VaultApprovalWorkflowClient`.
 */

import {
  createPersona,
  openPersona,
  resetPersonaState,
} from '@dina/core';
import type { CreateWorkflowTaskInput, WorkflowTask } from '@dina/core';
import {
  approvalIdFor,
  createPersonaGuard,
  type VaultApprovalWorkflowClient,
} from '../../src/composition/persona_guard';

const REQUESTER = 'did:key:z6MkAlonsoTester';
const ASK_ID = 'ask-1';

// ---------------------------------------------------------------------------
// Minimal in-memory workflow client fake
// ---------------------------------------------------------------------------

interface FakeTask {
  id: string;
  status: string;
  payload: string;
}

function makeFakeWorkflowClient(): {
  client: VaultApprovalWorkflowClient;
  tasks: Map<string, FakeTask>;
  setStatus: (id: string, status: string) => void;
} {
  const tasks = new Map<string, FakeTask>();
  const client: VaultApprovalWorkflowClient = {
    async createWorkflowTask(input: CreateWorkflowTaskInput) {
      if (tasks.has(input.id)) {
        // Simulate idempotency conflict — guard catches and swallows it.
        throw new Error(`duplicate id: ${input.id}`);
      }
      const task: FakeTask = {
        id: input.id,
        status: input.initialState ?? 'pending_approval',
        payload: input.payload,
      };
      tasks.set(input.id, task);
      return { task: task as unknown as WorkflowTask, deduped: false };
    },
    async getWorkflowTask(id: string) {
      return (tasks.get(id) as unknown as WorkflowTask) ?? null;
    },
    async completeWorkflowTask(id: string) {
      const t = tasks.get(id);
      if (t) t.status = 'completed';
      return t as unknown as WorkflowTask;
    },
  };
  return {
    client,
    tasks,
    setStatus(id: string, status: string) {
      const t = tasks.get(id);
      if (t) t.status = status;
    },
  };
}

beforeEach(() => {
  resetPersonaState();
});

describe('createPersonaGuard — construction', () => {
  it('rejects missing coreClient', () => {
    expect(() =>
      createPersonaGuard({
        // @ts-expect-error testing runtime validation
        coreClient: undefined,
        askId: ASK_ID,
        requesterDid: REQUESTER,
      }),
    ).toThrow('coreClient is required');
  });

  it('rejects empty askId', () => {
    const { client } = makeFakeWorkflowClient();
    expect(() =>
      createPersonaGuard({
        coreClient: client,
        askId: '',
        requesterDid: REQUESTER,
      }),
    ).toThrow('askId must be a non-empty string');
  });

  it('rejects empty requesterDid', () => {
    const { client } = makeFakeWorkflowClient();
    expect(() =>
      createPersonaGuard({
        coreClient: client,
        askId: ASK_ID,
        requesterDid: '   ',
      }),
    ).toThrow('requesterDid must be a non-empty string');
  });
});

describe('createPersonaGuard — tier policy', () => {
  it('returns null for default tier (open)', async () => {
    createPersona('general', 'default');
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('general')).toBeNull();
  });

  it('returns null for standard tier', async () => {
    createPersona('work', 'standard');
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('work')).toBeNull();
  });

  it('returns null for unknown persona', async () => {
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('does_not_exist')).toBeNull();
  });

  it('returns approvalId for sensitive tier', async () => {
    createPersona('health', 'sensitive');
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    const result = await guard('health');
    expect(result).toBe('appr-ask-1-health');
  });

  it('returns approvalId for locked tier', async () => {
    createPersona('financial', 'locked');
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('financial')).toBe('appr-ask-1-financial');
  });
});

describe('createPersonaGuard — approval registration', () => {
  it('creates a pending workflow task with the right payload', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    await guard('health');

    const task = tasks.get('appr-ask-1-health');
    expect(task).toBeDefined();
    expect(task?.status).toBe('pending_approval');
    const payload = JSON.parse(task?.payload ?? '{}');
    expect(payload).toMatchObject({
      type: 'vault_read_request',
      persona: 'health',
      source_ask_id: ASK_ID,
      requester_did: REQUESTER,
    });
  });

  it('embeds the askId in the reason text', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: 'ask-xyz', requesterDid: REQUESTER });
    await guard('health');
    const payload = JSON.parse(tasks.get('appr-ask-xyz-health')?.payload ?? '{}');
    expect(payload.reason).toContain('ask-xyz');
  });

  it('is idempotent on a re-call with pending task', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    const id1 = await guard('health');
    const id2 = await guard('health'); // task exists (pending_approval) → idempotent
    expect(id1).toBe(id2);
    expect(tasks.size).toBe(1);
  });

  it('mints distinct approval ids for distinct personas in the same ask', async () => {
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    const { client, tasks } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('health')).toBe('appr-ask-1-health');
    expect(await guard('financial')).toBe('appr-ask-1-financial');
    expect(tasks.size).toBe(2);
  });

  it('mints distinct approval ids for the same persona across different asks', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks } = makeFakeWorkflowClient();
    const guard1 = createPersonaGuard({ coreClient: client, askId: 'ask-1', requesterDid: REQUESTER });
    const guard2 = createPersonaGuard({ coreClient: client, askId: 'ask-2', requesterDid: REQUESTER });
    expect(await guard1('health')).toBe('appr-ask-1-health');
    expect(await guard2('health')).toBe('appr-ask-2-health');
    expect(tasks.size).toBe(2);
  });
});

describe('createPersonaGuard — resume cycle (consume on second call)', () => {
  it('returns null after operator approves (task moves to queued)', async () => {
    createPersona('health', 'sensitive');
    const { client, setStatus } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });

    // First call: mint pending task.
    const id = await guard('health');
    expect(id).toBe('appr-ask-1-health');

    // Operator approves — workflow task transitions pending_approval → queued.
    setStatus(id!, 'queued');

    // Second call: finds queued → completes task → allows.
    expect(await guard('health')).toBeNull();
  });

  it('completing the task marks it consumed (status → completed)', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks, setStatus } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });

    const id = await guard('health');
    setStatus(id!, 'queued');
    await guard('health'); // consumes

    expect(tasks.get(id!)?.status).toBe('completed');
  });

  it('a third call after consuming mints a fresh task', async () => {
    createPersona('health', 'sensitive');
    const { client, tasks, setStatus } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });

    const firstId = await guard('health');
    setStatus(firstId!, 'queued');
    await guard('health'); // consume → completed

    // Third call: completed task → mint fresh pending (same id, no conflict
    // since mock allows re-insertion after removal).
    // Simulate removal of completed task from the fake store.
    tasks.delete(firstId!);
    const thirdId = await guard('health');
    expect(thirdId).toBe('appr-ask-1-health'); // same deterministic id
    expect(tasks.get(thirdId!)?.status).toBe('pending_approval');
  });

  it('a denied task (cancelled status) surfaces approvalId so the loop bails', async () => {
    createPersona('health', 'sensitive');
    const { client, setStatus } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    const id = await guard('health');
    setStatus(id!, 'cancelled');

    // Subsequent call sees cancelled → return approvalId (bail).
    expect(await guard('health')).toBe(id);
  });
});

describe('approvalIdFor', () => {
  it('exposes the deterministic id derivation', () => {
    expect(approvalIdFor('ask-42', 'financial')).toBe('appr-ask-42-financial');
  });
});

describe('createPersonaGuard — interaction with persona unlock state', () => {
  it('treats sensitive persona as approval-required regardless of isOpen', async () => {
    createPersona('health', 'sensitive');
    openPersona('health', true);
    const { client } = makeFakeWorkflowClient();
    const guard = createPersonaGuard({ coreClient: client, askId: ASK_ID, requesterDid: REQUESTER });
    expect(await guard('health')).toBe('appr-ask-1-health');
  });
});
