import {
  InMemoryWorkflowRepository,
  WorkflowService,
  createFacadeActionApproval,
  createCodingGateApproval,
  getWorkflowService,
  inboundReviewDisplay,
  installUcpCheckoutRuntime,
  remoteApprovalProposalId,
  setCodingPermitAuthority,
  setWorkflowService,
} from '@dina/core';
import { kvGet, resetKVStore } from '@dina/core/kv';

import {
  PhoneApprovalSyncWorker,
  phoneNeedsServerNodePairing,
  pullUcpLinkCallbacks,
  resetServerNodePairingNeeded,
  runPhoneApprovalSyncTick,
  withdrawAllPhoneApprovalMirrors,
  type PhoneApprovalClient,
} from '../src/approval/phone_approval_sync';

import type { UcpCheckoutRuntime } from '@dina/core';


const NOW = 2_000_000_000_000;
const PHONE_CLIENT_DID = 'did:key:z6MkLaptopApprovalClient';

function createSourceTask(): string {
  const created = createCodingGateApproval({
    agentDid: 'did:key:z6MkAgent',
    sessionId: 'session-1',
    effectiveProfile: 'full_supervision',
    policyVersion: 1,
    authorityOrigin: 'owner_interactive',
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

function clientFor(decision: 'pending' | 'approved' | 'denied' | 'expired'): PhoneApprovalClient {
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
          source_payload_hash: (body as { source_payload_hash?: unknown } | undefined)
            ?.source_payload_hash,
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
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
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
        source_task_id: `${id}:w1`,
        proposal_type: 'facade_action',
        action: 'talk',
        tool_name: 'dina_talk',
        display_title: 'Send a message to Bob',
        display_detail: 'Can we speak tomorrow?',
      });
      return {
        status: 201,
        body: {
          proposal_id: remoteApprovalProposalId(PHONE_CLIENT_DID, `${id}:w1`),
          decision: 'approved',
          source_payload_hash: wire.source_payload_hash,
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
      expect.stringContaining(
        `/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, `${id}:w1`)}`,
      ),
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
      expect.stringContaining(
        `/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, `${id}:w1`)}`,
      ),
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
      expect.stringContaining(
        `/proposals/${remoteApprovalProposalId(PHONE_CLIENT_DID, `${id}:w1`)}`,
      ),
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
      effectiveProfile: 'full_supervision',
      policyVersion: 1,
      authorityOrigin: 'owner_interactive',
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

describe('A2A consent cards on the paired phone (plan §3.20)', () => {
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  function consentTask(id: string, text: string): void {
    const card = {
      type: 'a2a_delegation_consent',
      operation_id: `op-${id}`,
      consent_hash: 'c'.repeat(64),
      consent: {
        remote_agent_id: 'ra-1',
        card_hash: 'a'.repeat(64),
        endpoint: 'https://agent.example/rpc',
        skill: 'summarize',
        action_class: 'read',
        credential_ref: 'cr-1',
        credential_revision: 1,
        labels: ['may_contain_sensitive', 'unverified'],
        projection: { parts: [{ text }] },
      },
      display: {
        agent_name: 'Summarizer',
        card_url: 'https://agent.example/.well-known/agent-card.json',
        endpoint: 'https://agent.example/rpc',
        signature_state: 'unsigned',
        signature_detail: 'The card carries no signature.',
        skill_name: 'Summarize',
        credential: 'No credential. The agent receives no secret from Dina.',
        labels: ['Dina cannot yet prove where any of this text came from.'],
        placeholders: [],
        effect: 'The agent is asked for information.',
      },
    };
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: 'Send to Summarizer: Summarize',
      payload: JSON.stringify(card),
      expiresAtSec: Math.floor(NOW / 1000) + 600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }

  it('mirrors the card with every byte that would be sent', async () => {
    consentTask('a2a-consent-1', 'Summarize: the meeting moved to Friday.');
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    const body = (client.request as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).toMatchObject({
      source_task_id: 'a2a-consent-1:w1',
      source_payload_hash: 'c'.repeat(64),
      agent_did: 'a2a:ra-1',
      action: 'a2a_delegate',
      proposal_type: 'facade_action',
      display_title: 'Send to Summarizer: Summarize',
    });
    expect(String(body.display_detail)).toContain(
      'Exactly what will be sent:\nSummarize: the meeting moved to Friday.',
    );
  });

  it('keeps a card the phone cannot show in full on the console', async () => {
    consentTask('a2a-consent-2', 'x'.repeat(5_000));
    consentTask('a2a-consent-3', 'line one\r\nline two');
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    expect((client.request as jest.Mock).mock.calls).toEqual([]);
  });
});

describe('A2A inbound review cards on the paired phone (design §7.3)', () => {
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  function reviewTask(
    id: string,
    params: Parameters<typeof inboundReviewDisplay>[0]['params'],
  ): void {
    const fields = {
      client_name: 'Acme agent',
      skill: 'appointment_book@clinic',
      action_class: 'booking' as const,
      params,
      service_name: 'Dr. Lee',
    };
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: 'A2A call under review',
      payload: JSON.stringify({
        type: 'a2a_inbound_review',
        operation_id: `op-${id}`,
        client_id: 'ac_1',
        ...fields,
        post_hash: 'd'.repeat(64),
        display: inboundReviewDisplay({ ...fields, proof: { kind: 'bearer' } }),
      }),
      expiresAtSec: Math.floor(NOW / 1000) + 600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }

  it('mirrors Core’s words and the exact params, bound to the call’s hash', async () => {
    reviewTask('a2a-in-1', { slot: '9am' });
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    const body = (client.request as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).toMatchObject({
      source_task_id: 'a2a-in-1:w1',
      source_payload_hash: 'd'.repeat(64),
      agent_did: 'a2a:ac_1',
      action: 'a2a_inbound',
      proposal_type: 'facade_action',
      display_title: 'Acme agent asks to use appointment_book@clinic',
    });
    expect(String(body.display_detail)).toContain('Exactly what it sent:\n{\n  "slot": "9am"\n}');
  });

  it('keeps a card too long for the phone on the console', async () => {
    reviewTask('a2a-in-2', { note: 'x'.repeat(5_000) });
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    expect((client.request as jest.Mock).mock.calls).toEqual([]);
  });
});

describe('UCP search review cards on the paired phone (UCP plan §3.16)', () => {
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  function searchReviewTask(id: string, query: string, merchants: string[]): void {
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: `Search ${merchants.join(', ')} for: ${query}`,
      payload: JSON.stringify({
        type: 'ucp_search_review',
        session_id: 'chat:main',
        binding: 'e'.repeat(64),
        query,
        merchants,
        why: ['personal_data'],
      }),
      expiresAtSec: Math.floor(NOW / 1000) + 600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }

  it('mirrors every shop and the exact query, bound to the card’s binding', async () => {
    searchReviewTask('ucp-search-review-1', 'tea for +1 415 555 0134', [
      'https://a-shop.example',
      'https://b-shop.example',
    ]);
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    const body = (client.request as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).toMatchObject({
      source_task_id: 'ucp-search-review-1:w1',
      source_payload_hash: 'e'.repeat(64),
      agent_did: 'ucp:search',
      action: 'ucp_search',
      proposal_type: 'facade_action',
      display_title: 'Search 2 shops?',
    });
    expect(String(body.display_detail)).toBe(
      [
        'Dina held this search before it left:',
        'It may carry personal details (a name, number or address).',
        'It goes to:',
        'https://a-shop.example',
        'https://b-shop.example',
        'Exactly what will be sent:',
        'tea for +1 415 555 0134',
      ].join('\n'),
    );
  });

  it('a phone copy that lapsed unanswered is no decision: the card stays for the console', async () => {
    searchReviewTask('ucp-search-review-5', 'tea for +1 415 555 0134', ['https://a-shop.example']);
    const result = await runPhoneApprovalSyncTick({ client: clientFor('expired'), nowMs: NOW });
    expect(result).toMatchObject({ lapsed: 1, denied: 0 });
    expect(getWorkflowService()?.store().getById('ucp-search-review-5')?.status).toBe(
      'pending_approval',
    );
  });

  it('keeps a card the phone cannot show whole on the console', async () => {
    searchReviewTask('ucp-search-review-2', 'tea‮evil', ['https://a-shop.example']);
    const client = clientFor('pending');
    await runPhoneApprovalSyncTick({ client, nowMs: NOW });
    expect((client.request as jest.Mock).mock.calls).toEqual([]);
  });
});

/**
 * A paired phone as the sync worker reaches it: windows kept by mirror id, the
 * status GET without an expiry check (`remote_approval.ts`), the owner's
 * decision made on it, and the network able to lose a POST's answer.
 */
function fakePhone(options: { hashless?: boolean; refuse?: number; now?: () => number } = {}) {
  const windows = new Map<
    string,
    {
      body: Record<string, unknown>;
      decision: 'pending' | 'approved' | 'denied' | 'expired';
      presence: boolean;
    }
  >();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let loseNextAnswer = false;
  let offline = false;
  const idOf = (path: string) =>
    decodeURIComponent(path.split('/proposals/')[1]?.split('/')[0] ?? '');
  const answer = (id: string) => {
    const w = windows.get(id);
    // With a clock, an undecided window past its expiry reads as lapsed, as on a real phone.
    const lapsed =
      options.now !== undefined &&
      w?.decision === 'pending' &&
      Number(w.body.expires_at) * 1000 <= options.now();
    return {
      proposal_id: id,
      decision: lapsed ? 'expired' : (w?.decision ?? 'pending'),
      ...(options.hashless === true ? {} : { source_payload_hash: w?.body.source_payload_hash }),
      ...(w?.decision === 'approved' && w.presence ? { presence_verified: true } : {}),
    };
  };
  const client: PhoneApprovalClient = {
    did: PHONE_CLIENT_DID,
    request: async (method, path, body) => {
      if (offline) throw new Error('relay offline');
      calls.push({
        method,
        path,
        ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
      });
      if (method === 'POST') {
        if (options.refuse !== undefined)
          return { status: options.refuse, body: { error: 'expires_at out of range' } };
        const b = body as Record<string, unknown>;
        const id = remoteApprovalProposalId(PHONE_CLIENT_DID, String(b.source_task_id));
        const existing = windows.get(id);
        if (existing !== undefined && JSON.stringify(existing.body) !== JSON.stringify(b))
          return { status: 409, body: { error: 'proposal_conflict' } };
        if (existing === undefined)
          windows.set(id, { body: b, decision: 'pending', presence: false });
        if (loseNextAnswer) {
          loseNextAnswer = false;
          throw new Error('answer lost');
        }
        return { status: 201, body: answer(id) };
      }
      if (method === 'GET') {
        const id = idOf(path);
        return windows.has(id)
          ? { status: 200, body: answer(id) }
          : { status: 404, body: { error: 'proposal_not_found' } };
      }
      windows.delete(idOf(path));
      return { status: 204, body: {} };
    },
  };
  return {
    client,
    calls,
    windows,
    /** The owner decides on the phone, in one window. */
    decide(window: string, decision: 'approved' | 'denied' | 'expired', presence = false) {
      const id = remoteApprovalProposalId(PHONE_CLIENT_DID, window);
      const w = windows.get(id);
      if (w === undefined) throw new Error(`no window ${window}`);
      w.decision = decision;
      w.presence = presence;
    },
    loseNextAnswer: () => {
      loseNextAnswer = true;
    },
    setOffline: (v: boolean) => {
      offline = v;
    },
    posts: () => calls.filter((c) => c.method === 'POST'),
  };
}

describe('rolling windows on the phone (UCP plan §3.9)', () => {
  const NOW_SEC = Math.floor(NOW / 1000);
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  /** A held search card that lives `hours` hours. */
  function longCard(id: string, hours: number): void {
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: 'Search https://a-shop.example for: tea',
      payload: JSON.stringify({
        type: 'ucp_search_review',
        session_id: 'chat:main',
        binding: 'f'.repeat(64),
        query: 'tea for +1 415 555 0134',
        merchants: ['https://a-shop.example'],
        why: ['personal_data'],
      }),
      expiresAtSec: NOW_SEC + hours * 3600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }
  const at = (minutes: number) => NOW + minutes * 60_000;
  const status = (id: string) => getWorkflowService()?.store().getById(id)?.status;

  it('a six-hour card is decided in its third window: each window its own id and a fixed 14-minute life', async () => {
    longCard('c1', 6);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    expect(phone.posts().map((c) => [c.body?.source_task_id, c.body?.expires_at])).toEqual([
      ['c1:w1', NOW_SEC + 14 * 60],
    ]);
    // Inside a window nothing new opens; in its last minute the next one does.
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(5) });
    expect(phone.posts()).toHaveLength(1);
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(13.5) });
    expect(phone.posts().map((c) => c.body?.source_task_id)).toEqual(['c1:w1', 'c1:w2']);
    expect(phone.posts()[1]?.body?.expires_at).toBe(NOW_SEC + 13.5 * 60 + 14 * 60);
    // Window 1 lapses undecided on the phone: retired, not a denial.
    phone.decide('c1:w1', 'expired');
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(14.5) });
    expect(status('c1')).toBe('pending_approval');
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(27) });
    expect(phone.posts().map((c) => c.body?.source_task_id)).toEqual(['c1:w1', 'c1:w2', 'c1:w3']);
    phone.decide('c1:w3', 'approved');
    const settled = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(30) });
    expect(settled.approved).toBe(1);
    expect(status('c1')).toBe('queued');
    // Once the card is decided no window is left waiting on the owner (window 1 lapsed there).
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(30.1) });
    expect([...phone.windows.values()].filter((w) => w.decision === 'pending')).toEqual([]);
  });

  it('a POST whose answer was lost is read back, never sent twice: the GET finds it', async () => {
    longCard('c2', 1);
    const phone = fakePhone();
    phone.loseNextAnswer();
    const first = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    expect(first.failed).toBe(1);
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(1) });
    expect(phone.posts()).toHaveLength(1);
    expect(phone.calls.at(-1)).toMatchObject({ method: 'GET' });
  });

  it('a POST lost before it reached the phone is sent again, the same bytes, while the window has time', async () => {
    longCard('c3', 1);
    const phone = fakePhone();
    phone.setOffline(true);
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    phone.setOffline(false);
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(2) });
    const posts = phone.posts();
    expect(posts).toHaveLength(1);
    // The bytes written before the first attempt: the same expiry, though two minutes passed.
    expect(posts[0]?.body).toMatchObject({
      source_task_id: 'c3:w1',
      expires_at: NOW_SEC + 14 * 60,
    });
  });

  it('an approval made just before a window ended is read after the server comes back past that end', async () => {
    longCard('c4', 6);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    phone.decide('c4:w1', 'approved');
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(20) });
    expect(status('c4')).toBe('queued');
  });

  it('repeated ticks and a restart within a window send nothing new', async () => {
    longCard('c5', 1);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    for (const m of [1, 2, 3])
      await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(m) });
    expect(phone.posts()).toHaveLength(1);
  });

  it('a phone copy bound to other bytes decides nothing, and the card is left to the console', async () => {
    longCard('c7', 1);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    // The phone's copy under this window's id says another hash, and its owner said yes.
    const id = remoteApprovalProposalId(PHONE_CLIENT_DID, 'c7:w1');
    const copy = phone.windows.get(id);
    if (copy === undefined) throw new Error('no copy');
    copy.body = { ...copy.body, source_payload_hash: '0'.repeat(64) };
    phone.decide('c7:w1', 'approved');
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(1) });
    expect(tick).toMatchObject({ approved: 0, failed: 1 });
    expect(status('c7')).toBe('pending_approval');
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(14) });
    expect(phone.posts()).toHaveLength(1);
  });

  it('a phone that names no hash (an older build): a lapsed window retires only that window', async () => {
    longCard('c8', 6);
    const phone = fakePhone({ hashless: true });
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    phone.decide('c8:w1', 'expired');
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(14) });
    expect(tick).toMatchObject({ lapsed: 1, failed: 0 });
    expect(phone.posts().map((c) => c.body?.source_task_id)).toEqual(['c8:w1', 'c8:w2']);
    expect(status('c8')).toBe('pending_approval');
  });

  it('a window the phone refuses outright is sent once, and the card is left to the console', async () => {
    longCard('c9', 1);
    const phone = fakePhone({ refuse: 400 });
    const first = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    expect(first.failed).toBe(1);
    for (const m of [0.1, 0.2, 5, 14])
      await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(m) });
    expect(phone.posts()).toHaveLength(1);
    expect(status('c9')).toBe('pending_approval');
  });

  it('an approval on the phone whose sync comes after the card’s own end applies nothing', async () => {
    longCard('c10', 0.25);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    phone.decide('c10:w1', 'approved');
    // The card lapses on the server before the next tick reads the phone.
    getWorkflowService()?.expireTasks(Math.floor(at(16) / 1000), at(16));
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(16) });
    expect(tick.approved).toBe(0);
    expect(status('c10')).not.toBe('queued');
  });

  it('too many cards waiting on the phone (429) is a wait: the window is sent again later', async () => {
    longCard('c11', 1);
    const phone = fakePhone({ refuse: 429 });
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(1) });
    expect(phone.posts().length).toBeGreaterThanOrEqual(2);
    expect(phoneNeedsServerNodePairing()).toBe(false);
  });

  it('a phone that refuses this server as an ordinary agent (403) leaves the card to the console and asks for re-pairing', async () => {
    await resetServerNodePairingNeeded();
    longCard('c12', 1);
    const phone = fakePhone({ refuse: 403 });
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(0) });
    expect(phoneNeedsServerNodePairing()).toBe(true);
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(1) });
    expect(phone.posts()).toHaveLength(1);
    // A coding card the phone takes says nothing about this server's scope: the flag stays.
    createCodingGateApproval({
      agentDid: 'did:key:z6MkAgent',
      sessionId: 'session-9',
      effectiveProfile: 'full_supervision',
      policyVersion: 1,
      authorityOrigin: 'owner_interactive',
      payloadHash: 'c'.repeat(64),
      tool: 'Write',
      action: 'filesystem.write',
      risk: 'HIGH',
      now: NOW,
    });
    await runPhoneApprovalSyncTick({ client: fakePhone().client, nowMs: at(2) });
    expect(phoneNeedsServerNodePairing()).toBe(true);
    // It is stored: still set as a fresh process reads it.
    expect(await kvGet('server_node_pairing_needed', 'phone_approval_status')).not.toBeNull();
    // A shopping card the phone takes (re-paired as a Server node) clears it.
    longCard('c13', 1);
    await runPhoneApprovalSyncTick({ client: fakePhone().client, nowMs: at(3) });
    expect(phoneNeedsServerNodePairing()).toBe(false);
  });

  it('a card past its own end opens no window', async () => {
    longCard('c6', 1);
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: at(60) });
    expect(phone.posts()).toEqual([]);
  });
});

describe('order notice cards on the phone (UCP plan §3.14)', () => {
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  it('carries Core’s words and the shop’s order page, needs no person present, and the phone’s "Seen" is applied', async () => {
    getWorkflowService()?.create({
      id: 'n1',
      kind: 'approval',
      description: 'A delivery attempt failed on your order at tea.example.',
      payload: JSON.stringify({
        type: 'ucp_order_notice',
        merchant_origin: 'https://tea.example',
        merchant_host: 'tea.example',
        order_id: 'ord_1',
        permalink_url: 'https://tea.example/orders/ord_1',
        what: 'a delivery attempt failed',
        notice: { kind: 'event', id: 'e1', type: 'failed_attempt' },
        at: NOW,
      }),
      expiresAtSec: Math.floor(NOW / 1000) + 30 * 86_400,
      origin: 'system',
      initialState: 'pending_approval',
    });
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW });
    const body = phone.posts()[0]?.body;
    expect(body).toMatchObject({
      source_task_id: 'n1:w1',
      agent_did: 'ucp:order',
      action: 'ucp_order_notice',
      display_title: 'A delivery attempt failed on your order at tea.example.',
      link_url: 'https://tea.example/orders/ord_1',
    });
    expect(body?.presence_required).toBeUndefined();
    expect(String(body?.display_detail)).toContain('Track or return at tea.example.');
    phone.decide('n1:w1', 'approved');
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW + 60_000 });
    expect(tick).toMatchObject({ approved: 1 });
  });

  it('a checkout that ended unconfirmed goes as its own action, pointing at the store', async () => {
    getWorkflowService()?.create({
      id: 'n3',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify({
        type: 'ucp_order_notice',
        merchant_origin: 'https://tea.example',
        merchant_host: 'tea.example',
        order_id: 'ucp-checkout-1',
        permalink_url: 'https://tea.example/',
        what: 'Dina could not confirm whether the shop opened your checkout',
        notice: { kind: 'checkout', id: 'ucp-checkout-1', type: 'create_unknown' },
        at: NOW,
      }),
      expiresAtSec: Math.floor(NOW / 1000) + 30 * 86_400,
      origin: 'system',
      initialState: 'pending_approval',
    });
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW });
    expect(phone.posts()[0]?.body).toMatchObject({
      action: 'ucp_checkout_notice',
      link_url: 'https://tea.example/',
    });
    expect(String(phone.posts()[0]?.body?.display_detail)).toContain('Go to tea.example.');
  });

  it('unseen on the phone, it comes back once a day, three times in all, never every quarter hour', async () => {
    getWorkflowService()?.create({
      id: 'n2',
      kind: 'approval',
      description: 'A dispute was opened on your order at tea.example.',
      payload: JSON.stringify({
        type: 'ucp_order_notice',
        merchant_origin: 'https://tea.example',
        merchant_host: 'tea.example',
        order_id: 'ord_2',
        permalink_url: 'https://tea.example/orders/ord_2',
        what: 'a dispute was opened',
        notice: { kind: 'adjustment', id: 'd1', type: 'dispute', reason: 'new' },
        at: NOW,
      }),
      expiresAtSec: Math.floor(NOW / 1000) + 30 * 86_400,
      origin: 'system',
      initialState: 'pending_approval',
    });
    let clock = NOW;
    const phone = fakePhone({ now: () => clock });
    for (let minutes = 0; minutes <= 120; minutes += 5) {
      clock = NOW + minutes * 60_000;
      await runPhoneApprovalSyncTick({ client: phone.client, nowMs: clock });
    }
    expect(phone.posts()).toHaveLength(1);
    // Over the next days the phone reports each window lapsed: one new window a day, three in
    // all, each a new card there (a new window id), none after the third.
    for (let hours = 2; hours <= 24 * 5; hours += 1) {
      clock = NOW + hours * 3_600_000;
      await runPhoneApprovalSyncTick({ client: phone.client, nowMs: clock });
    }
    const ids = phone.posts().map((p) => p.body?.source_task_id);
    expect(ids).toEqual(['n2:w1', 'n2:w2', 'n2:w3']);
    expect(getWorkflowService()?.store().getById('n2')?.status).toBe('pending_approval');
    // Still the owner's on the console.
    expect(getWorkflowService()?.store().getById('n2')?.status).toBe('pending_approval');
  });
});

describe('the checkout hand-off card on the phone (UCP plan §3.9)', () => {
  const NOW_SEC = Math.floor(NOW / 1000);
  beforeEach(() => {
    resetKVStore();
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  function handoffCard(id: string): void {
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: 'Review and pay at shop.example',
      payload: JSON.stringify({
        type: 'ucp_checkout_handoff',
        session_id: 'ucp-checkout-1',
        merchant: 'https://shop.example',
        status: 'incomplete',
        lines: [
          {
            title: 'Sencha',
            quantity: '2',
            unit: 'each',
            total: { amount: '5600', currency: 'EUR' },
          },
        ],
        totals: [{ type: 'total', label: 'Total', amount: { amount: '5600', currency: 'EUR' } }],
        messages: [],
        discounts: [],
        fulfillment: [],
        links: [],
        expires_at: NOW + 6 * 3_600_000,
        handoff: {
          url: 'https://shop.example/checkout/chk_1',
          source: 'continue_url',
          off_host: false,
        },
        notes: [],
      }),
      expiresAtSec: NOW_SEC + 6 * 3600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }

  it('carries the link to open and asks for a person present on the phone', async () => {
    handoffCard('h1');
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW });
    expect(phone.posts()[0]?.body).toMatchObject({
      source_task_id: 'h1:w1',
      action: 'ucp_checkout_handoff',
      proposal_type: 'facade_action',
      display_title: 'Review and pay at shop.example',
      link_url: 'https://shop.example/checkout/chk_1',
      presence_required: true,
    });
    expect(String(phone.posts()[0]?.body?.display_detail)).toContain('2 each × Sencha');
  });

  it('a yes without proof of presence is refused here: the card stays for the console and leaves the phone', async () => {
    handoffCard('h2');
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW });
    phone.decide('h2:w1', 'approved', false);
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW + 60_000 });
    expect(tick).toMatchObject({ approved: 0, failed: 1 });
    expect(getWorkflowService()?.store().getById('h2')?.status).toBe('pending_approval');
    // No window of it is read or opened again.
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW + 14 * 60_000 });
    expect(phone.posts()).toHaveLength(1);
  });

  it('a yes made in person on the phone is applied', async () => {
    handoffCard('h3');
    const phone = fakePhone();
    await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW });
    phone.decide('h3:w1', 'approved', true);
    const tick = await runPhoneApprovalSyncTick({ client: phone.client, nowMs: NOW + 60_000 });
    expect(tick.approved).toBe(1);
    // The owner's yes reached Core (the checkout handler, not installed here, completes the card).
    expect(getWorkflowService()?.store().getById('h3')?.status).toBe('queued');
  });
});

describe('linked-account callbacks the phone caught (UCP plan §3.17)', () => {
  const S1 = 'a'.repeat(43);
  const S2 = 'b'.repeat(43);
  let waiting: string[];
  let finished: Record<string, string>[];
  let relayed: string[][];
  let sent: { method: string; path: string; body: unknown }[];
  let pullAnswer: { status: number; body: unknown };
  const client: PhoneApprovalClient = {
    did: 'did:key:z6MkPhone',
    async request(method, path, body) {
      sent.push({ method, path, body });
      if (path.endsWith('/oauth-callbacks/pull')) return pullAnswer;
      return { status: 200, body: { dropped: 1 } };
    },
  };
  beforeEach(() => {
    waiting = [S1];
    finished = [];
    relayed = [];
    sent = [];
    pullAnswer = { status: 200, body: { callbacks: [] } };
    installUcpCheckoutRuntime({
      links: {
        waitingStates: () => waiting,
        complete: async (p: Record<string, string>, o: { relayed?: boolean }) => {
          expect(o).toEqual({ relayed: true });
          finished.push(p);
          return { ok: true, merchantOrigin: 'https://shop.example', scopes: [] };
        },
        markRelayed: (states: string[]) => relayed.push(states),
      },
      stop: () => undefined,
    } as unknown as UcpCheckoutRuntime);
  });
  afterEach(() => installUcpCheckoutRuntime(null));

  it('pulls by the states its links wait on, finishes each, then acknowledges them', async () => {
    pullAnswer = {
      status: 200,
      body: { callbacks: [{ state: S1, params: { code: 'c', state: S1, iss: 'https://shop.example' } }] },
    };
    expect(await pullUcpLinkCallbacks(client)).toBe(1);
    expect(finished).toEqual([{ code: 'c', state: S1, iss: 'https://shop.example' }]);
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/agent/approval-sync/v1/oauth-callbacks/pull', body: { states: [S1] } },
      { method: 'POST', path: '/v1/agent/approval-sync/v1/oauth-callbacks/ack', body: { states: [S1] } },
    ]);
    // Acknowledged: nothing more is owed for it.
    expect(relayed).toEqual([[S1]]);
  });

  it('an acknowledgement the phone did not take leaves the state owed: the next pull asks again', async () => {
    pullAnswer = { status: 200, body: { callbacks: [{ state: S1, params: { code: 'c', state: S1 } }] } };
    const failing: PhoneApprovalClient = {
      did: client.did,
      async request(method, path, body) {
        if (path.endsWith('/ack')) return { status: 503, body: {} };
        return client.request(method, path, body);
      },
    };
    expect(await pullUcpLinkCallbacks(failing)).toBe(1);
    expect(relayed).toEqual([]);
  });

  it('a callback another run is still finishing (busy) is not acknowledged: the phone keeps it (dual review R1-7)', async () => {
    waiting = [S1, S2];
    pullAnswer = {
      status: 200,
      body: {
        callbacks: [
          { state: S1, params: { code: 'c', state: S1 } },
          { state: S2, params: { code: 'd', state: S2 } },
        ],
      },
    };
    installUcpCheckoutRuntime({
      links: {
        waitingStates: () => waiting,
        complete: async (p: Record<string, string>) =>
          p.state === S1
            ? { ok: false, reason: 'busy' }
            : { ok: true, merchantOrigin: 'https://shop.example', scopes: [] },
        markRelayed: (states: string[]) => relayed.push(states),
      },
      stop: () => undefined,
    } as unknown as UcpCheckoutRuntime);
    expect(await pullUcpLinkCallbacks(client)).toBe(1);
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/agent/approval-sync/v1/oauth-callbacks/ack',
      body: { states: [S2] },
    });
    expect(relayed).toEqual([[S2]]);
  });

  it('asks nothing while no link waits, and never with no UCP runtime', async () => {
    waiting = [];
    expect(await pullUcpLinkCallbacks(client)).toBe(0);
    installUcpCheckoutRuntime(null);
    expect(await pullUcpLinkCallbacks(client)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('takes only what it asked for, read strictly; a refused pull finishes and acknowledges nothing', async () => {
    pullAnswer = {
      status: 200,
      body: {
        callbacks: [
          { state: S2, params: { code: 'c', state: S2 } },
          { state: S1, params: { code: 'c', state: S2 } },
          { state: S1, params: { code: 7, state: S1 } },
          { state: S1, params: null },
          'nonsense',
        ],
      },
    };
    expect(await pullUcpLinkCallbacks(client)).toBe(0);
    expect(finished).toEqual([]);
    expect(sent).toHaveLength(1);
    pullAnswer = { status: 403, body: { error: 'access_denied' } };
    expect(await pullUcpLinkCallbacks(client)).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('the sync worker pulls on its tick, before the cards', async () => {
    pullAnswer = { status: 200, body: { callbacks: [{ state: S1, params: { code: 'c', state: S1 } }] } };
    await new PhoneApprovalSyncWorker(client).tick();
    expect(finished).toHaveLength(1);
    expect(sent[0]?.path).toBe('/v1/agent/approval-sync/v1/oauth-callbacks/pull');
  });
});
