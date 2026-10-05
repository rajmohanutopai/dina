import { mirrorExpiresAt } from '../../../src/approval/mirror_text';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { SEARCH_REVIEW_TTL_MS } from '../../../src/commerce/ucp/search_projection';
import { registerDevice, resetDeviceRegistry } from '../../../src/devices/registry';
import { createCoreRouter } from '../../../src/server/core_server';
import { CoreRouter } from '../../../src/server/router';
import {
  REMOTE_APPROVAL_API_PREFIX,
  REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE,
  REMOTE_APPROVAL_PAYLOAD_TYPE,
  REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE,
  remoteApprovalProposalId,
} from '../../../src/server/routes/remote_approval';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../../src/workflow/service';

import type { CoreRequest } from '../../../src/server/router';

const DEVICE = 'did:key:z6MkRemoteLaptop';
const OTHER = 'did:key:z6MkOtherLaptop';
const HASH = 'a'.repeat(64);

function request(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  callerDID = DEVICE,
  callerType: CoreRequest['callerType'] = 'agent',
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body)),
    params: {},
    trustedInProcess: true,
    callerType,
    callerDID,
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_task_id: 'coding-gate-local-1',
    source_payload_hash: HASH,
    agent_did: 'did:key:z6MkCodingAgent',
    action: 'filesystem.write',
    risk_level: 'HIGH',
    tool_name: 'Write',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

/** The request as the owner's server node sends it: an agent paired with the `node` scope. */
const asNode = (req: CoreRequest): CoreRequest => ({ ...req, agentScope: 'node' });

describe('remote approval synchronization routes', () => {
  beforeEach(() => {
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });

  afterEach(() => {
    setWorkflowService(null);
    resetDeviceRegistry();
  });

  it('a held-search card’s mirrored copy is taken from a node whose clock runs 30 s ahead; its hour is cut to the phone’s window', async () => {
    const router = createCoreRouter();
    // The node made the card 30 s ahead of the phone's clock, to live an hour.
    const nodeNowMs = Date.now() + 30_000;
    const card = { created_at: nodeNowMs, expires_at: Math.floor((nodeNowMs + SEARCH_REVIEW_TTL_MS) / 1000) };
    const expiresAt = mirrorExpiresAt(card);
    expect(expiresAt).toBe(Math.floor(nodeNowMs / 1000) + 14 * 60);
    const res = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({
          proposal_type: 'facade_action',
          action: 'ucp_search',
          display_title: 'Search a-shop.example?',
          display_detail: 'Exactly what will be sent:\ntea',
          expires_at: expiresAt,
        }),
        DEVICE,
        'device',
      ),
    );
    expect(res.status).toBe(201);
    // A card shorter than the window keeps its own end; one without an end is not mirrored.
    expect(mirrorExpiresAt({ created_at: 0, expires_at: 300 })).toBe(300);
    expect(mirrorExpiresAt({ created_at: 0 })).toBeNull();
  });

  it('names the sending device as this node paired it, never as the proposal says; a rename is no conflict', async () => {
    const device = registerDevice('Dina laptop approvals', 'z6MkRemoteLaptop', 'agent');
    expect(device.did).toBe(DEVICE);
    const router = createCoreRouter();
    const body = proposal({
      proposal_type: 'facade_action',
      action: 'ucp_search',
      display_title: 'Search 2 shops?',
      display_detail: 'Exactly what will be sent:\noat milk',
      source_device_name: 'your Home Node',
    });
    const first = await router.handle(asNode(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, body)));
    expect(first.status).toBe(201);
    const id = String((first.body as Record<string, unknown>).proposal_id);
    expect(JSON.parse(getTask(id).payload)).toMatchObject({
      source_device_did: DEVICE,
      source_device_name: 'Dina laptop approvals',
    });
    // The device is re-paired under another name; its retry of the same proposal is the same proposal.
    resetDeviceRegistry();
    registerDevice('Office server', 'z6MkRemoteLaptop', 'agent');
    const retry = await router.handle(asNode(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, body)));
    expect(retry.status).toBe(200);
    // A device this node does not know carries no name: the phone says "a paired device".
    const stranger = await router.handle(
      asNode(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, { ...body, source_task_id: 'other-1' }, OTHER)),
    );
    const strangerPayload = JSON.parse(getTask(String((stranger.body as Record<string, unknown>).proposal_id)).payload);
    expect(strangerPayload.source_device_name).toBeUndefined();
  });

  it('creates one phone-owned approval without storing source-supplied free text', async () => {
    const router = createCoreRouter();
    const res = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({
          description: 'SECRET raw command --token=hunter2',
          raw_tool_input: { command: 'curl --token=hunter2' },
          session_id: 'private-project-name',
        }),
      ),
    );

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.decision).toBe('pending');
    const task = getTask(String(body.proposal_id));
    const payload = JSON.parse(task.payload) as Record<string, unknown>;
    expect(payload.type).toBe(REMOTE_APPROVAL_PAYLOAD_TYPE);
    expect(payload.source_device_did).toBe(DEVICE);
    expect(task.description).toContain('filesystem.write via Write');
    expect(task.description).not.toContain('SECRET');
    expect(task.payload).not.toContain('private-project-name');
    expect(task.payload).not.toContain('hunter2');
    expect(task.payload).not.toContain('raw_tool_input');
  });

  it('deduplicates an identical retry and rejects a changed immutable proposal', async () => {
    const router = createCoreRouter();
    // A retry resends the same body: one body, built once (its expiry is read
    // from the clock, so two builds can straddle a second).
    const body = proposal();
    const first = await router.handle(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, body));
    const second = await router.handle(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, body));
    const conflict = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, { ...body, source_payload_hash: 'b'.repeat(64) }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as Record<string, unknown>).deduped).toBe(true);
    expect(conflict.status).toBe(409);
  });

  it('stores a facade action with its exact bounded owner-visible meaning', async () => {
    const router = createCoreRouter();
    const created = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({
          proposal_type: 'facade_action',
          source_task_id: 'agent-action-talk-1',
          action: 'talk',
          tool_name: 'dina_talk',
          display_title: 'Send a message to Bob',
          display_detail: 'Can we speak tomorrow?\\nAfter 10am works.',
        }),
      ),
    );

    expect(created.status).toBe(201);
    const task = getTask(String((created.body as Record<string, unknown>).proposal_id));
    const payload = JSON.parse(task.payload) as Record<string, unknown>;
    expect(task.description).toBe('Send a message to Bob');
    expect(payload).toMatchObject({
      type: REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE,
      proposal_type: 'facade_action',
      action: 'talk',
      tool_name: 'dina_talk',
      display_title: 'Send a message to Bob',
      display_detail: 'Can we speak tomorrow?\\nAfter 10am works.',
    });
  });

  it('rejects unsafe or incomplete facade display fields', async () => {
    const router = createCoreRouter();
    const missing = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ proposal_type: 'facade_action' }),
      ),
    );
    const spoofed = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({
          proposal_type: 'facade_action',
          display_title: 'Send to Bob',
          display_detail: 'invoice\u202Etxt.exe',
        }),
      ),
    );
    expect([missing.status, spoofed.status]).toEqual([400, 400]);
  });

  it('binds status reads to the authenticated source device', async () => {
    const router = createCoreRouter();
    const created = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const id = String((created.body as Record<string, unknown>).proposal_id);

    const hidden = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined, OTHER),
    );
    expect(hidden.status).toBe(404);

    const approved = await router.handle({
      ...request('POST', `/v1/workflow/tasks/${id}/approve`, {}),
      callerType: undefined,
      callerDID: undefined,
    });
    expect(approved.status).toBe(200);

    const status = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined, DEVICE, 'device'),
    );
    expect(status.status).toBe(200);
    expect((status.body as Record<string, unknown>).decision).toBe('approved');
  });

  it('withdraws only the authenticated source device proposal and is idempotent', async () => {
    const router = createCoreRouter();
    const created = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const id = String((created.body as Record<string, unknown>).proposal_id);

    const hidden = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined, OTHER),
    );
    expect(hidden.status).toBe(404);
    expect(getTask(id).status).toBe('pending_approval');

    const withdrawn = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined),
    );
    expect(withdrawn.status).toBe(204);
    expect(getTask(id).status).toBe('cancelled');

    const replay = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined),
    );
    expect(replay.status).toBe(204);
  });

  it('fails closed for non-HIGH, malformed hashes, excessive TTL, and non-device callers', async () => {
    const router = createCoreRouter();
    const badRisk = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ risk_level: 'MODERATE' }),
      ),
    );
    const badHash = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ source_payload_hash: 'x' }),
      ),
    );
    const badTTL = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      ),
    );
    const brain = await router.handle({
      ...request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
      callerType: 'brain',
    });
    expect([badRisk.status, badHash.status, badTTL.status, brain.status]).toEqual([
      400, 400, 400, 403,
    ]);
  });
});

function getTask(id: string) {
  const task = getWorkflowService()?.store().getById(id) ?? null;
  if (task === null) throw new Error(`missing task ${id}`);
  return task;
}

describe('a mirrored card whose yes needs a person present (UCP plan §3.9)', () => {
  const handoff = (overrides: Record<string, unknown> = {}) =>
    proposal({
      source_task_id: 'ucp-checkout-handoff-1:w1',
      proposal_type: 'facade_action',
      action: 'ucp_checkout_handoff',
      tool_name: 'ucp_checkout_handoff',
      display_title: 'Review and pay at shop.example',
      display_detail: '2 each × Sencha — EUR 56.00',
      link_url: 'https://shop.example/checkout/chk_1',
      presence_required: true,
      ...overrides,
    });
  const owner = (path: string) => {
    const router = new CoreRouter();
    registerWorkflowRoutes(router, 'cap');
    return router.handle({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      callerDID: 'did:key:owner',
      ownerCapability: 'cap',
    } as unknown as CoreRequest);
  };
  beforeEach(() => {
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });
  afterEach(() => {
    setWorkflowService(null);
    resetDeviceRegistry();
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('is stored with its link, gated on presence here, and reports a yes made in person', async () => {
    installOwnerPresenceVerifier(async (p) => p === 'pass phrase');
    const router = createCoreRouter();
    const created = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, handoff(), DEVICE, 'device'),
    );
    expect(created.status).toBe(201);
    const id = remoteApprovalProposalId(DEVICE, 'ucp-checkout-handoff-1:w1');
    const stored = JSON.parse(getWorkflowService()?.store().getById(id)?.payload ?? '{}');
    expect(stored).toMatchObject({
      type: REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE,
      link_url: 'https://shop.example/checkout/chk_1',
      presence_required: true,
    });
    expect((await owner(`/v1/workflow/tasks/${id}/approve`)).status).toBe(403);
    await proveOwnerPresence('pass phrase', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await owner(`/v1/workflow/tasks/${id}/approve`)).status).toBe(200);
    const status = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined, DEVICE, 'device'),
    );
    expect(status.body).toMatchObject({ decision: 'approved', presence_verified: true });
  });

  it('Brain on the phone reads none of the mirrored card’s words or its link', async () => {
    const router = createCoreRouter();
    await router.handle(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, handoff({ agent_did: 'ucp:checkout' }), DEVICE, 'device'));
    const id = remoteApprovalProposalId(DEVICE, 'ucp-checkout-handoff-1:w1');
    const wf = new CoreRouter();
    registerWorkflowRoutes(wf, 'cap');
    const read = await wf.handle({
      method: 'GET',
      path: `/v1/workflow/tasks/${id}`,
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toMatch(/shop\.example|Sencha|chk_1/);
  });

  it('the owner’s server node (an agent paired with the `node` scope) may send one; a coding agent may not', async () => {
    const router = createCoreRouter();
    const asAgent = (scope: 'node' | 'coding', id: string) => ({
      ...request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, handoff({ source_task_id: id }), DEVICE, 'agent'),
      agentScope: scope,
    });
    expect((await router.handle(asAgent('node', 'n:w1') as CoreRequest)).status).toBe(201);
    expect((await router.handle(asAgent('coding', 'c:w1') as CoreRequest)).status).toBe(403);
  });

  it('an outside agent may not send a card that opens a link, asks for presence, or speaks as Dina’s shopping', async () => {
    const router = createCoreRouter();
    for (const forged of [
      handoff(),
      handoff({ presence_required: undefined }),
      handoff({ presence_required: undefined, link_url: undefined }),
      proposal({ action: 'ucp_search', proposal_type: 'facade_action', display_title: 'Search?', display_detail: 'x' }),
    ]) {
      const res = await router.handle(
        request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, forged, DEVICE, 'agent'),
      );
      expect(res.status).toBe(403);
    }
  });

  it('a node that cannot tell whether a person is present never says yes to one', async () => {
    const router = createCoreRouter();
    await router.handle(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, handoff(), DEVICE, 'device'));
    const id = remoteApprovalProposalId(DEVICE, 'ucp-checkout-handoff-1:w1');
    const refused = await owner(`/v1/workflow/tasks/${id}/approve`);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('no_user_presence');
  });

  it('a plain mirror never reports presence; a link must be https and needs the full display', async () => {
    const router = createCoreRouter();
    for (const bad of [
      handoff({ link_url: 'http://shop.example/x' }),
      handoff({ link_url: 'https://u:p@shop.example/x' }),
      handoff({ link_url: `https://shop.example/${'x'.repeat(2100)}` }),
      handoff({ presence_required: false }),
      proposal({ link_url: 'https://shop.example/x' }),
    ]) {
      const res = await router.handle(request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, bad, DEVICE, 'device'));
      expect(res.status).toBe(400);
    }
    const plain = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        handoff({ source_task_id: 'plain:w1', presence_required: undefined, link_url: undefined }),
        DEVICE,
        'device',
      ),
    );
    expect(plain.status).toBe(201);
    const id = remoteApprovalProposalId(DEVICE, 'plain:w1');
    expect(JSON.parse(getWorkflowService()?.store().getById(id)?.payload ?? '{}').type).toBe(
      REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE,
    );
    expect((await owner(`/v1/workflow/tasks/${id}/approve`)).status).toBe(200);
    const status = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined, DEVICE, 'device'),
    );
    expect(status.body).not.toHaveProperty('presence_verified');
  });
});
