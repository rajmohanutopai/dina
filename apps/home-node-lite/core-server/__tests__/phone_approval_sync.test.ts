import {
  InMemoryWorkflowRepository,
  WorkflowService,
  createCodingGateApproval,
  getWorkflowService,
  setCodingPermitAuthority,
  setWorkflowService,
} from '@dina/core';

import {
  PhoneApprovalSyncWorker,
  runPhoneApprovalSyncTick,
  type PhoneApprovalClient,
} from '../src/approval/phone_approval_sync';

const NOW = 2_000_000_000_000;

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

function clientFor(decision: 'pending' | 'approved' | 'denied'): PhoneApprovalClient {
  return {
    request: jest.fn(async () => {
      return {
        status: 201,
        body: { proposal_id: 'remote-1', decision },
      };
    }),
  };
}

describe('phone approval synchronization worker', () => {
  const minted: unknown[] = [];

  beforeEach(() => {
    minted.length = 0;
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    setCodingPermitAuthority({
      mintApproved: (claim) => minted.push(claim),
    });
  });

  afterEach(() => {
    setCodingPermitAuthority(null);
    setWorkflowService(null);
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

  it('fails closed and preserves the pending task on relay failure', async () => {
    const id = createSourceTask();
    const result = await runPhoneApprovalSyncTick({
      client: {
        request: async () => {
          throw new Error('offline');
        },
      },
      nowMs: NOW,
    });
    expect(result.failed).toBe(1);
    expect(getWorkflowService()?.store().getById(id)?.status).toBe('pending_approval');
  });

  it('single-flights overlapping worker ticks', async () => {
    createSourceTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: PhoneApprovalClient = {
      request: jest.fn(async () => {
        await gate;
        return {
          status: 201,
          body: { proposal_id: 'remote-1', decision: 'pending' },
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
      client: { request },
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
        request: async () => {
          await gate;
          return {
            status: 201,
            body: { proposal_id: 'remote-1', decision: 'pending' },
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
