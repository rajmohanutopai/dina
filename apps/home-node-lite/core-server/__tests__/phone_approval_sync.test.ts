import {
  InMemoryWorkflowRepository,
  WorkflowService,
  createFacadeActionApproval,
  createCodingGateApproval,
  getWorkflowService,
  remoteApprovalProposalId,
  setCodingPermitAuthority,
  setWorkflowService,
} from '@dina/core';
import { resetKVStore } from '@dina/core/kv';

import {
  PhoneApprovalSyncWorker,
  runPhoneApprovalSyncTick,
  withdrawAllPhoneApprovalMirrors,
  type PhoneApprovalClient,
} from '../src/approval/phone_approval_sync';

const NOW = 2_000_000_000_000;
const PHONE_CLIENT_DID = 'did:key:z6MkLaptopApprovalClient';

function createSourceTask(): string {
  const created = createCodingGateApproval({
    agentDid: 'did:key:z6MkAgent',
    sessionId: 'session-1',
    payloadHash: 'a'.repeat(64),
    tool: 'Write',
    action: 'filesystem.write',
    risk: 'HIGH',
    now: NOW,
  });
  if (created.kind !== 'approval_required') throw new Error('source approval was not created');
  return created.taskId;
}

function createFacadeSourceTask(): string {
  const created = createFacadeActionApproval({
    action: 'talk',
    agentDid: 'did:key:z6MkAgent',
    sessionId: 'session-1',
    requestId: 'talk-request-0001',
    actionPayload: {
      recipient_did: 'did:plc:bob',
      body: { text: 'Can we speak tomorrow?' },
    },
    displayTitle: 'Send a message to Bob',
    displayDetail: 'Can we speak tomorrow?',
    nowMs: NOW,
  });
  if (created.kind !== 'created') throw new Error('facade source approval was not created');
  return created.task.id;
}

function clientFor(decision: 'pending' | 'approved' | 'denied'): PhoneApprovalClient {
  return {
    did: PHONE_CLIENT_DID,
    request: jest.fn(async (_method, _path, body) => {
      const sourceTaskId =
        body !== null && typeof body === 'object' && 'source_task_id' in body
          ? String(body.source_task_id)
          : '';
      return {
        status: 201,
        body: {
          proposal_id: remoteApprovalProposalId(PHONE_CLIENT_DID, sourceTaskId),
          decision,
        },
      };
    }),
  };
}

describe('phone approval synchronization worker', () => {
  const minted: unknown[] = [];

  beforeEach(() => {
    minted.length = 0;
    resetKVStore();
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    setCodingPermitAuthority({
      mintApproved: (claim) => minted.push(claim),
    });
  });

  afterEach(() => {
    setCodingPermitAuthority(null);
    setWorkflowService(null);
    resetKVStore();
    jest.useRealTimers();
  });

  it('leaves the local task pending while the phone decision is pending', async () => {
    const id = createSourceTask();
    const result = await runPhoneApprovalSyncTick({
      client: clientFor('pending'),
      nowMs: NOW,
    });
    expect(result.pending).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('pending_approval');
    expect(minted).toHaveLength(0);
  });

  it('applies phone approval through the normal permit-minting path', async () => {
    const id = createSourceTask();
    const result = await runPhoneApprovalSyncTick({
      client: clientFor('approved'),
      nowMs: NOW,
    });
    expect(result.approved).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('queued');
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      agentDid: 'did:key:z6MkAgent',
      sessionId: 'session-1',
      payloadHash: 'a'.repeat(64),
    });
  });

  it('maps a phone denial to a local cancellation without minting authority', async () => {
    const id = createSourceTask();
    const result = await runPhoneApprovalSyncTick({
      client: clientFor('denied'),
      nowMs: NOW,
    });
    expect(result.denied).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('cancelled');
    expect(minted).toHaveLength(0);
  });

  it('mirrors exact facade action copy and approves it without minting a coding permit', async () => {
    const id = createFacadeSourceTask();
    const request = jest.fn(async (_method, _path, body) => {
      const wire = body as Record<string, unknown>;
      expect(wire).toMatchObject({
        source_task_id: id,
        proposal_type: 'facade_action',
        action: 'talk',
        tool_name: 'dina_talk',
        display_title: 'Send a message to Bob',
        display_detail: 'Can we speak tomorrow?',
      });
      return {
        status: 201,
        body: {
          proposal_id: remoteApprovalProposalId(PHONE_CLIENT_DID, id),
          decision: 'approved',
        },
      };
    });

    const result = await runPhoneApprovalSyncTick({
      client: { did: PHONE_CLIENT_DID, request },
      nowMs: NOW,
    });

    expect(result.approved).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('queued');
    expect(minted).toHaveLength(0);
  });

  it('fails closed and preserves the pending task on relay failure', async () => {
    const id = createSourceTask();
    const result = await runPhoneApprovalSyncTick({
      client: {
        did: PHONE_CLIENT_DID,
        request: async () => {
          throw new Error('offline');
        },
      },
      nowMs: NOW,
    });
    expect(result.failed).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('pending_approval');
  });

  it('withdraws a durable phone mirror after its laptop task is cancelled', async () => {
    const id = createSourceTask();
    const pendingClient = clientFor('pending');
    await runPhoneApprovalSyncTick({ client: pendingClient, nowMs: NOW });
    getWorkflowService()?.cancel(id, 'owner cancelled locally');

    const request = jest.fn(async (method: 'GET' | 'POST' | 'DELETE') => {
      if (method === 'DELETE') return { status: 204, body: {} };
      throw new Error('unexpected request');
    });
    const result = await runPhoneApprovalSyncTick({
      client: { did: PHONE_CLIENT_DID, request },
      nowMs: NOW,
    });

    expect(result.withdrawn).toBe(1);
    expect(request).toHaveBeenCalledWith(
      'DELETE',
      expect.stringContaining(`/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, id)}`),
    );
  });

  it('can withdraw after transport fails because the deterministic receipt is persisted first', async () => {
    const id = createSourceTask();
    const offline = jest.fn(async () => {
      throw new Error('response lost after remote create');
    });
    await runPhoneApprovalSyncTick({
      client: { did: PHONE_CLIENT_DID, request: offline },
      nowMs: NOW,
    });
    getWorkflowService()?.cancel(id, 'owner cancelled locally');

    const request = jest.fn(async (method: 'GET' | 'POST' | 'DELETE') => {
      if (method === 'DELETE') return { status: 204, body: {} };
      throw new Error('unexpected request');
    });
    const result = await runPhoneApprovalSyncTick({
      client: { did: PHONE_CLIENT_DID, request },
      nowMs: NOW,
    });

    expect(result.withdrawn).toBe(1);
    expect(request).toHaveBeenCalledWith(
      'DELETE',
      expect.stringContaining(`/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, id)}`),
    );
  });

  it('withdraws pending mirrors before an approval phone is replaced', async () => {
    const id = createSourceTask();
    await runPhoneApprovalSyncTick({
      client: clientFor('pending'),
      nowMs: NOW,
    });
    const request = jest.fn(async (method: 'GET' | 'POST' | 'DELETE') => {
      if (method === 'DELETE') return { status: 204, body: {} };
      throw new Error('unexpected request');
    });

    const result = await withdrawAllPhoneApprovalMirrors({
      did: PHONE_CLIENT_DID,
      request,
    });

    expect(result).toEqual({ withdrawn: 1, failed: 0 });
    expect(request).toHaveBeenCalledWith(
      'DELETE',
      expect.stringContaining(`/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, id)}`),
    );
  });

  it('single-flights overlapping worker ticks', async () => {
    createSourceTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: PhoneApprovalClient = {
      did: PHONE_CLIENT_DID,
      request: jest.fn(async (_method, _path, body) => {
        await gate;
        const sourceTaskId =
          body !== null && typeof body === 'object' && 'source_task_id' in body
            ? String(body.source_task_id)
            : '';
        return {
          status: 201,
          body: {
            proposal_id: remoteApprovalProposalId(PHONE_CLIENT_DID, sourceTaskId),
            decision: 'pending',
          },
        };
      }),
    };
    const worker = new PhoneApprovalSyncWorker(client, 60_000);
    const first = worker.tick();
    const second = worker.tick();
    release();
    await Promise.all([first, second]);
    expect(client.request).toHaveBeenCalledTimes(1); // idempotent POST is create + poll
    await worker.stop();
  });

  it('stops an offline batch after one shared-transport failure', async () => {
    createSourceTask();
    createCodingGateApproval({
      agentDid: 'did:key:z6MkAgent',
      sessionId: 'session-1',
      payloadHash: 'b'.repeat(64),
      tool: 'Bash',
      action: 'network.write',
      risk: 'HIGH',
      now: NOW,
    });
    const request = jest.fn(async () => {
      throw new Error('relay offline');
    });

    const result = await runPhoneApprovalSyncTick({
      client: { did: PHONE_CLIENT_DID, request },
      nowMs: NOW,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
  });

  it('waits for an in-flight tick during shutdown', async () => {
    createSourceTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new PhoneApprovalSyncWorker(
      {
        did: PHONE_CLIENT_DID,
        request: async (_method, _path, body) => {
          await gate;
          const sourceTaskId =
            body !== null && typeof body === 'object' && 'source_task_id' in body
              ? String(body.source_task_id)
              : '';
          return {
            status: 201,
            body: {
              proposal_id: remoteApprovalProposalId(PHONE_CLIENT_DID, sourceTaskId),
              decision: 'pending',
            },
          };
        },
      },
      60_000,
    );
    const tick = worker.tick();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stopping]);
    expect(stopped).toBe(true);
  });
});
