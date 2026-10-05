/**
 * The `ucp_link_handoff` card (UCP plan §3.17): what it says, how it is read
 * back, how it travels to the phone, and what Brain may do with it (nothing:
 * Core mints it, a person present answers it, and Brain reads neither the
 * merchant nor the sign-in page, whose URL carries the flow's state).
 */

import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import {
  buildLinkCard,
  linkCardCorrelation,
  linkCardDescription,
  linkCardMirror,
  linkScopeWords,
  readLinkCard,
  UCP_LINK_HANDOFF_TYPE,
  type LinkCard,
} from '../../../src/commerce/ucp/link_card';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { WorkflowTaskKind, WorkflowTaskState } from '../../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

const ORDER_READ = 'dev.ucp.shopping.order:read';
const CHECKOUT = 'dev.ucp.shopping.checkout:manage';
const card = (over: Partial<LinkCard> = {}): LinkCard => ({
  type: UCP_LINK_HANDOFF_TYPE,
  merchant: 'https://tea.example',
  url: 'https://tea.example/auth/authorize?state=s3cr3t&code_challenge=c',
  scopes: [CHECKOUT, ORDER_READ],
  expires_at: Date.parse('2026-10-05T10:10:00Z'),
  ...over,
});

describe('the card’s words', () => {
  it('names the shop, what Dina may do, where the owner signs in, what Dina never does, and until when', () => {
    expect(linkCardDescription(card())).toBe(
      [
        'Link your account at tea.example?',
        'Dina may prepare checkouts, read your orders.',
        'You sign in at tea.example.',
        'Dina never cancels, returns or pays through this link.',
        'Open until 2026-10-05T10:10:00.000Z.',
      ].join('\n'),
    );
    // A shop whose sign-in lives elsewhere says so.
    expect(
      linkCardDescription(card({ url: 'https://accounts.example/authorize?state=s' })),
    ).toContain('You sign in at accounts.example, for tea.example.');
  });

  it('scopes in the owner’s words; one Dina does not know by its name', () => {
    expect(
      [
        ORDER_READ,
        CHECKOUT,
        'dev.ucp.shopping.cart:manage',
        'dev.ucp.shopping.catalog.search:read',
        'com.shop.loyalty:read',
      ].map(linkScopeWords),
    ).toEqual([
      'read your orders',
      'prepare checkouts',
      'manage carts',
      'search your account’s catalog',
      'com.shop.loyalty:read',
    ]);
  });

  it('on the phone: the question as its title, the rest as its detail, the page to open, a person present', () => {
    expect(linkCardMirror(card())).toEqual({
      title: 'Link your account at tea.example?',
      detail: linkCardDescription(card()).split('\n').slice(1).join('\n'),
      linkUrl: card().url,
      presenceRequired: true,
    });
  });
});

describe('building and reading a card', () => {
  it('a page too long for the phone’s mirror travels on no card', () => {
    const started = { url: card().url, scopes: [ORDER_READ], expiresAt: 1 };
    expect(buildLinkCard('https://tea.example', started)).toMatchObject({ scopes: [ORDER_READ] });
    expect(
      buildLinkCard('https://tea.example', {
        ...started,
        url: `https://tea.example/${'a'.repeat(2048)}`,
      }),
    ).toBeNull();
  });

  it('reads back only a card Core could have written', () => {
    expect(readLinkCard(JSON.stringify(card()))).toEqual(card());
    for (const bad of [
      { ...card(), type: 'ucp_checkout_handoff' },
      { ...card(), merchant: 'http://tea.example' },
      { ...card(), merchant: 'https://tea.example/path' },
      { ...card(), url: 'javascript:alert(1)' },
      { ...card(), url: 'https://user:pw@tea.example/auth' },
      { ...card(), url: `https://tea.example/${'a'.repeat(2048)}` },
      { ...card(), scopes: 'x' },
      { ...card(), scopes: [1] },
      { ...card(), expires_at: 1.5 },
      { ...card(), expires_at: '1' },
    ])
      expect(readLinkCard(JSON.stringify(bad))).toBeNull();
    expect(readLinkCard('{"type":"ucp_link_handoff",')).toBeNull();
  });
});

describe('what Brain cannot do with the card', () => {
  let workflow: WorkflowService;
  function call(
    caller: 'brain' | 'owner',
    method: CoreRequest['method'],
    p: string,
    body: Record<string, unknown> = {},
  ) {
    const router = new CoreRouter();
    registerWorkflowRoutes(router, 'cap');
    return router.handle({
      method,
      path: p,
      query: {},
      headers: { 'x-did': 'did:key:brain' },
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: caller,
      callerDID: 'did:key:brain',
      ...(caller === 'owner' ? { ownerCapability: 'cap' } : {}),
    } as CoreRequest);
  }
  beforeEach(() => {
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
    installOwnerPresenceVerifier(async (p) => p === 'pass phrase');
  });
  afterEach(() => {
    setWorkflowService(null);
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('Brain mints none, nor one dressed as the server node’s mirror', async () => {
    const forged = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'x1',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify(card()),
    });
    expect((forged.body as { error: string }).error).toBe('reserved_payload_type');
    const mirror = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'x2',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify({
        type: 'remote_facade_presence_v1',
        action: 'ucp_link_handoff',
        agent_did: 'ucp:link',
        link_url: 'https://evil.example/x',
      }),
    });
    expect((mirror.body as { error: string }).error).toBe('reserved_payload_type');
  });

  it('a yes needs a person present; Brain can neither decide it nor read the shop or its sign-in page', async () => {
    workflow.create({
      id: 'ucp-link-1',
      kind: WorkflowTaskKind.Approval,
      description: linkCardDescription(card()),
      payload: JSON.stringify(card()),
      correlationId: linkCardCorrelation('https://tea.example'),
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
    // The same card mirrored from a server node, as the phone holds it.
    workflow.create({
      id: 'm-link-1',
      kind: WorkflowTaskKind.Approval,
      description: 'Link your account at tea.example?',
      payload: JSON.stringify({
        type: 'remote_facade_presence_v1',
        source_device_did: 'did:key:z6MkServerNode',
        source_task_id: 'ucp-link-9:w1',
        source_payload_hash: 'f'.repeat(64),
        agent_did: 'ucp:link',
        action: 'ucp_link_handoff',
        tool_name: 'ucp_link_handoff',
        proposal_type: 'facade_action',
        display_title: 'Link your account at tea.example?',
        display_detail: 'You sign in at tea.example.',
        link_url: card().url,
        presence_required: true,
      }),
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
    const leaks = /tea\.example|s3cr3t|authorize/;
    expect((await call('brain', 'POST', '/v1/workflow/tasks/ucp-link-1/approve')).status).toBe(403);
    for (const id of ['ucp-link-1', 'm-link-1'])
      expect(
        JSON.stringify((await call('brain', 'GET', `/v1/workflow/tasks/${id}`)).body),
      ).not.toMatch(leaks);
    expect(JSON.stringify((await call('brain', 'GET', '/v1/workflow/events')).body)).not.toMatch(
      leaks,
    );
    const absent = await call('owner', 'POST', '/v1/workflow/tasks/ucp-link-1/approve');
    expect(absent.status).toBe(403);
    expect((absent.body as { error: string; detail: string }).detail).toBe(
      'linking an account at a merchant needs a person present',
    );
    expect(await proveOwnerPresence('pass phrase', Date.now(), OWNER_IN_PROCESS_PRINCIPAL)).toBe(
      true,
    );
    expect((await call('owner', 'POST', '/v1/workflow/tasks/ucp-link-1/approve')).status).toBe(200);
    // Decided: the events now carry the card. Brain still reads neither shop nor page.
    const events = await call('brain', 'GET', '/v1/workflow/events');
    const list = (events.body as { events?: { task_id?: string }[] }).events ?? [];
    expect(list.some((e) => e.task_id === 'ucp-link-1')).toBe(true);
    expect(JSON.stringify(events.body)).not.toMatch(leaks);
    expect(
      JSON.stringify((await call('owner', 'GET', '/v1/workflow/tasks/ucp-link-1')).body),
    ).toMatch(leaks);
  });
});
