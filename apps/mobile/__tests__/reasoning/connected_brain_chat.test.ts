import { addUserMessage, getThread, readLifecycle, resetThreads } from '@dina/brain/chat';

import {
  cancelConnectedBrainChatJob,
  connectedBrainChatRows,
  reconcileConnectedBrainChat,
  trySubmitConnectedBrainAsk,
} from '../../src/reasoning/connected_brain_chat';
import { setOwnerRunClient } from '../../src/services/owner_run_client';

import type {
  OwnerReasoningBackendView,
  OwnerReasoningJobView,
  OwnerReasoningSubmitRequest,
  OwnerReasoningSubmitResult,
  OwnerRunClient,
} from '@dina/core';

const NOW = Date.now();

function backend(overrides: Partial<OwnerReasoningBackendView> = {}): OwnerReasoningBackendView {
  return {
    backend_id: 'connected-1',
    kind: 'connected_host',
    principal_did: 'did:key:agent',
    allowed_task_kinds: ['answer.compose'],
    max_sensitivity: 'sensitive',
    availability: 'foreground',
    model_class: 'claude',
    policy_version: 1,
    selected_by_owner_did: 'did:plc:owner',
    enabled: true,
    created_at: NOW - 1_000,
    updated_at: NOW,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function job(overrides: Partial<OwnerReasoningJobView> = {}): OwnerReasoningJobView {
  return {
    taskId: 'reasoning-1',
    taskKind: 'answer.compose',
    state: 'queued',
    purpose: 'mobile-chat:main:missing',
    backendId: 'connected-1',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    deadlineAtMs: NOW + 60_000,
    attempt: 0,
    commitState: 'not_applicable',
    ...overrides,
  };
}

interface FakeState {
  backends: OwnerReasoningBackendView[];
  jobs: OwnerReasoningJobView[];
  listedJobs?: OwnerReasoningJobView[];
  submitted: OwnerReasoningSubmitRequest[];
  cancelled: string[];
  submitResult?: OwnerReasoningSubmitResult;
  backendError?: Error;
}

function wireFake(state: FakeState): void {
  const fake = {
    async reasoningBackends() {
      if (state.backendError !== undefined) throw state.backendError;
      return { backends: state.backends };
    },
    async reasoningSubmit(req: OwnerReasoningSubmitRequest) {
      state.submitted.push(req);
      if (state.submitResult !== undefined) return state.submitResult;
      const created = job({
        taskId: 'reasoning-created',
        purpose: req.purpose ?? '',
        backendId: req.backend_id ?? null,
      });
      state.jobs.push(created);
      return {
        submission: { taskId: created.taskId, duplicate: false },
        job: created,
        restricted_personas: [],
      };
    },
    async reasoningList() {
      return { jobs: state.listedJobs ?? state.jobs };
    },
    async reasoningGet(taskId: string) {
      const found = state.jobs.find((candidate) => candidate.taskId === taskId);
      if (found === undefined) throw new Error('not found');
      return { job: found };
    },
    async reasoningCancel(taskId: string) {
      state.cancelled.push(taskId);
      return { ok: true };
    },
  };
  setOwnerRunClient(fake as unknown as OwnerRunClient);
}

function emptyState(): FakeState {
  return {
    backends: [],
    jobs: [],
    submitted: [],
    cancelled: [],
  };
}

beforeEach(() => {
  resetThreads();
  setOwnerRunClient(null);
});

afterEach(() => {
  setOwnerRunClient(null);
  resetThreads();
});

describe('connected Brain mobile chat projection', () => {
  it('leaves the legacy Brain path untouched only when no managed answer backend exists', async () => {
    expect(await trySubmitConnectedBrainAsk('What should I buy?')).toEqual({ handled: false });
    expect(getThread('main')).toEqual([]);

    const state = emptyState();
    state.backends = [backend({ allowed_task_kinds: ['intent.route'] })];
    wireFake(state);
    expect(await trySubmitConnectedBrainAsk('What should I buy?')).toEqual({ handled: false });
    expect(state.submitted).toEqual([]);
    expect(getThread('main')).toEqual([]);
  });

  it('does not bypass an owner-disabled backend through the legacy Brain path', async () => {
    const state = emptyState();
    state.backends = [backend({ enabled: false })];
    wireFake(state);

    expect(await trySubmitConnectedBrainAsk('What should I buy?')).toEqual({ handled: true });
    expect(state.submitted).toEqual([]);
    expect(getThread('main').map((message) => message.type)).toEqual(['user', 'error']);
    expect(getThread('main')[1].content).toBe(
      'No approved reasoning backend is currently available.',
    );
  });

  it('fails closed instead of bypassing Core when backend discovery fails', async () => {
    const state = emptyState();
    state.backendError = new Error('Core transport unavailable');
    wireFake(state);

    expect(await trySubmitConnectedBrainAsk('What should I buy?')).toEqual({ handled: true });
    expect(state.submitted).toEqual([]);
    expect(getThread('main').map((message) => message.type)).toEqual(['user', 'error']);
    expect(getThread('main')[1].content).toBe(
      'Dina could not check your approved reasoning backends. Please try again.',
    );
  });

  it('delegates backend selection to Core and creates one durable lifecycle row', async () => {
    const state = emptyState();
    state.backends = [
      backend({ backend_id: 'older', updated_at: NOW - 100 }),
      backend({ backend_id: 'newer', updated_at: NOW }),
      backend({
        backend_id: 'internal',
        kind: 'internal_brain',
        availability: 'always_on',
      }),
    ];
    wireFake(state);

    const result = await trySubmitConnectedBrainAsk('Find a chair');
    expect(result).toEqual({ handled: true, taskId: 'reasoning-created' });
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0]).toMatchObject({
      task_kind: 'answer.compose',
      input: { query: 'Find a chair' },
    });
    expect(state.submitted[0].backend_id).toBeUndefined();
    expect(state.submitted[0].idempotency_key).toMatch(/^mobile-cm-/);
    expect(state.submitted[0].purpose).toMatch(/^mobile-chat:main:cm-/);

    const messages = getThread('main');
    expect(messages.map((message) => message.type)).toEqual(['user', 'dina']);
    expect(connectedBrainChatRows()).toEqual([
      expect.objectContaining({
        status: 'queued',
        taskId: 'reasoning-created',
        backendId: 'policy-selected',
        userMessageId: messages[0].id,
      }),
    ]);
  });

  it('morphs the existing row into the validated completed answer', async () => {
    const state = emptyState();
    state.backends = [backend()];
    wireFake(state);
    await trySubmitConnectedBrainAsk('Find a chair');
    const before = getThread('main')[1];

    state.jobs[0] = job({
      taskId: 'reasoning-created',
      purpose: state.submitted[0].purpose ?? '',
      backendId: 'connected-1',
      state: 'completed',
      commitState: 'committed',
      result: { answer: 'The chair from your ranked reviews is the best fit.' },
    });
    expect(await reconcileConnectedBrainChat()).toBe(1);

    const after = getThread('main')[1];
    expect(after.id).toBe(before.id);
    expect(after.content).toBe('The chair from your ranked reviews is the best fit.');
    expect(readLifecycle(after)).toMatchObject({
      kind: 'reasoning_job',
      status: 'complete',
      taskId: 'reasoning-created',
    });
    expect(getThread('main')).toHaveLength(2);
    expect(await reconcileConnectedBrainChat()).toBe(0);
  });

  it('heals a crash after Core accepted a job but before chat stored its lifecycle row', async () => {
    const state = emptyState();
    wireFake(state);
    const user = addUserMessage('main', 'Resume this ask');
    state.jobs.push(
      job({
        taskId: 'reasoning-orphan',
        purpose: `mobile-chat:main:${user.id}`,
        backendId: 'connected-1',
      }),
    );

    expect(await reconcileConnectedBrainChat()).toBe(1);
    expect(getThread('main')).toHaveLength(2);
    expect(connectedBrainChatRows()[0]).toMatchObject({
      taskId: 'reasoning-orphan',
      userMessageId: user.id,
      status: 'queued',
    });
  });

  it('refreshes an older persisted row by exact task id when it falls outside the recent list', async () => {
    const state = emptyState();
    state.backends = [backend()];
    wireFake(state);
    await trySubmitConnectedBrainAsk('Find an older answer');
    const submitted = state.jobs[0];

    state.jobs[0] = job({
      ...submitted,
      state: 'completed',
      commitState: 'committed',
      result: { answer: 'Recovered by exact task lookup.' },
    });
    state.listedJobs = [];

    expect(await reconcileConnectedBrainChat()).toBe(1);
    expect(getThread('main')[1].content).toBe('Recovered by exact task lookup.');
    expect(connectedBrainChatRows()[0].status).toBe('complete');
  });

  it('cancels through Core and patches the same lifecycle row', async () => {
    const state = emptyState();
    state.backends = [backend()];
    wireFake(state);
    await trySubmitConnectedBrainAsk('Cancel me');

    expect(await cancelConnectedBrainChatJob('reasoning-created')).toBe(true);
    expect(state.cancelled).toEqual(['reasoning-created']);
    expect(connectedBrainChatRows()[0].status).toBe('cancelled');
    expect(getThread('main')[1].content).toBe('Reasoning request cancelled.');
  });
});
