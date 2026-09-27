/**
 * WEB_OWNER_SURFACE_PLAN §3.8 — owner presence on the powerful actions that
 * lacked it: plugin consent, runner pairing, updates, a pack's consent and
 * runner binding, a payment note, redeeming or accepting an invite, buyer and
 * supplier settings, choosing a reasoning backend, and the yes on the cards
 * that move money or hand out commercial authority.
 *
 * Presence is kept per owner principal: a proof at one surface (a browser, the
 * capability, the phone's own app) lets only that surface act.
 *
 * The contract, route by route: with presence establishable and not proven,
 * the route answers `403 no_user_presence` before doing anything; once
 * proven, the route answers for itself (whatever that is here: this harness
 * wires no plugin registry). The routes that REDUCE authority (decline,
 * uninstall, retire, a card's no) and the read-only ones are never gated.
 */

import { PAYMENT_EVIDENCE_RECORD_TYPE } from '../../../src/commerce/integration';
import { INTEGRATION_SETTINGS_PROPOSAL_TYPE } from '../../../src/commerce/integration_settings';
import {
  NEGOTIATION_PRICE_APPROVAL_TYPE,
  TENDER_READY_TYPE,
} from '../../../src/commerce/negotiation_policy';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
  OWNER_CAPABILITY_PRINCIPAL,
  OWNER_IN_PROCESS_PRINCIPAL,
  ownerDevicePrincipal,
} from '../../../src/commerce/owner_presence';
import { STAFF_ESCALATION_APPROVAL_TYPE } from '../../../src/commerce/staff_escalation';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { createCoreRouter } from '../../../src/server/core_server';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

import type { CoreRequest, CoreResponse } from '../../../src/server/router';

const OWNER_CAP = 'owner-capability-for-presence-gates-0123';
const router = createCoreRouter({ ownerCapability: OWNER_CAP });

function owner(
  path: string,
  body: Record<string, unknown> = {},
  method: CoreRequest['method'] = 'POST',
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
  };
}

function isPresenceRefusal(res: CoreResponse): boolean {
  return res.status === 403 && (res.body as { error?: string }).error === 'no_user_presence';
}

beforeEach(() => {
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  setNodeDID('did:plc:presencegatesowner');
});

afterEach(() => {
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
});

const GATED: [string, Record<string, unknown>, CoreRequest['method']][] = [
  ['/v1/plugins/install/setup_code', { install_id: 'inst-1' }, 'POST'],
  ['/v1/plugins/install/confirm', { install_id: 'inst-1' }, 'POST'],
  ['/v1/plugins/update/confirm', { install_id: 'inst-1', to_cid: 'bafy' }, 'POST'],
  ['/v1/commerce/install/confirm', { install_id: 'inst-1' }, 'POST'],
  [
    '/v1/commerce/install/bind_device',
    { install_id: 'inst-1', device_did: 'did:key:z6Mk' },
    'POST',
  ],
  ['/v1/commerce/install/bind_reference_runner', { install_id: 'inst-1' }, 'POST'],
  ['/v1/commerce/install/update/confirm', { install_id: 'inst-1', to_cid: 'bafy' }, 'POST'],
  [
    '/v1/commerce/trade/payment-note',
    { supplier_did: 'did:plc:s', amount: { currency: 'INR', minor_units: '100' }, method: 'upi' },
    'POST',
  ],
  ['/v1/commerce/invites/redeem', { code: 'code', service_rkeys: ['self'] }, 'POST'],
  ['/v1/commerce/invites/accept-held', { nonce: 'n', service_rkeys: ['self'] }, 'POST'],
  ['/v1/commerce/settings/supplier', { listingState: 'live' }, 'PUT'],
  ['/v1/commerce/settings/buyer', { currency: 'INR' }, 'PUT'],
  [
    '/v1/reasoning/backends/register',
    { backend_id: 'b', principal_did: 'did:key:z6Mk', kind: 'connected_host' },
    'POST',
  ],
];

describe('gated routes', () => {
  it.each(GATED)(
    '%s refuses without presence, then answers for itself once proven',
    async (path, body, method) => {
      const refused = await router.handle(owner(path, body, method));
      expect(isPresenceRefusal(refused)).toBe(true);
      expect(typeof (refused.body as { detail?: string }).detail).toBe('string');

      expect(
        await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL),
      ).toBe(true);
      const answered = await router.handle(owner(path, body, method));
      expect(isPresenceRefusal(answered)).toBe(false);
    },
  );

  it.each(GATED)('%s: presence never stands in for the owner', async (path, body, method) => {
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const stranger = await router.handle({
      ...owner(path, body, method),
      ownerCapability: 'wrong',
    });
    expect([401, 403]).toContain(stranger.status);
    expect(isPresenceRefusal(stranger)).toBe(false);
  });

  it('a node that cannot establish presence is not gated (convenience mode)', async () => {
    installOwnerPresenceVerifier(null);
    for (const [path, body, method] of GATED) {
      expect([path, isPresenceRefusal(await router.handle(owner(path, body, method)))]).toEqual([
        path,
        false,
      ]);
    }
  });
});

describe('presence belongs to the principal that proved it', () => {
  const ALICE = ownerDevicePrincipal('did:key:z6MkBrowserAlice');
  const BOB = ownerDevicePrincipal('did:key:z6MkBrowserBob');
  const path = '/v1/plugins/install/confirm';

  function as(principal: string | undefined): CoreRequest {
    const req = owner(path, { install_id: 'inst-1' });
    return principal === undefined ? req : { ...req, ownerPrincipal: principal };
  }

  it('a proof sent through the route stamps only the surface that sent it', async () => {
    const proof = await router.handle({
      ...owner('/v1/commerce/catalog/drafts/presence', { passphrase: 'correct horse' }),
      ownerPrincipal: ALICE,
    });
    expect(proof.status).toBe(200);
    expect(isPresenceRefusal(await router.handle(as(ALICE)))).toBe(false);
    // Another browser, the capability (the console, a script), and the phone's
    // own app all still have to prove for themselves.
    expect(isPresenceRefusal(await router.handle(as(BOB)))).toBe(true);
    expect(isPresenceRefusal(await router.handle(as(OWNER_CAPABILITY_PRINCIPAL)))).toBe(true);
    expect(isPresenceRefusal(await router.handle(as(undefined)))).toBe(true);
  });

  it('the in-process owner app is one principal: a request with no stamp', async () => {
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect(isPresenceRefusal(await router.handle(as(undefined)))).toBe(false);
    expect(isPresenceRefusal(await router.handle(as(ALICE)))).toBe(true);
  });

  it('a wrong passphrase stamps nothing for anyone', async () => {
    const proof = await router.handle({
      ...owner('/v1/commerce/catalog/drafts/presence', { passphrase: 'wrong' }),
      ownerPrincipal: ALICE,
    });
    expect(proof.status).toBe(401);
    expect(isPresenceRefusal(await router.handle(as(ALICE)))).toBe(true);
  });
});

describe('routes that reduce authority or only read are never gated', () => {
  it.each([
    ['/v1/plugins/install/decline', { install_id: 'inst-1' }],
    ['/v1/plugins/install/uninstall', { install_id: 'inst-1' }],
    ['/v1/plugins/update/prepare', { install_id: 'inst-1', rkey: 'r' }],
    ['/v1/commerce/install/update/prepare', { install_id: 'inst-1' }],
    ['/v1/commerce/install/retire', { install_id: 'inst-1' }],
    ['/v1/reasoning/backends/b/revoke', { expected_version: 1 }],
  ] as [string, Record<string, unknown>][])('%s', async (path, body) => {
    expect(isPresenceRefusal(await router.handle(owner(path, body)))).toBe(false);
  });

  it('business settings (legal name, registrations, address) hand out nothing', async () => {
    const res = await router.handle(
      owner('/v1/commerce/settings/business', { legalName: 'Alonso Traders' }, 'PUT'),
    );
    expect(isPresenceRefusal(res)).toBe(false);
  });
});

describe('cards that move money or hand out authority: the yes is gated, the no is not', () => {
  let workflow: WorkflowService;

  function card(id: string, type: string): void {
    workflow.create({
      id,
      kind: 'approval',
      description: id,
      payload: JSON.stringify({ type }),
      initialState: 'pending_approval' as never,
    });
  }

  beforeEach(() => {
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
  });
  afterEach(() => setWorkflowService(null));

  it.each([
    NEGOTIATION_PRICE_APPROVAL_TYPE,
    PAYMENT_EVIDENCE_RECORD_TYPE,
    STAFF_ESCALATION_APPROVAL_TYPE,
    INTEGRATION_SETTINGS_PROPOSAL_TYPE,
  ])('approving a %s card needs presence; it stays pending until then', async (type) => {
    card('c1', type);
    const refused = await router.handle({
      ...owner('/v1/workflow/tasks/c1/approve'),
      params: { id: 'c1' },
    });
    expect(isPresenceRefusal(refused)).toBe(true);
    expect(workflow.store().getById('c1')?.status).toBe('pending_approval');
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const approved = await router.handle({
      ...owner('/v1/workflow/tasks/c1/approve'),
      params: { id: 'c1' },
    });
    expect(isPresenceRefusal(approved)).toBe(false);
  });

  it('declining one of those cards is immediate', async () => {
    card('c2', PAYMENT_EVIDENCE_RECORD_TYPE);
    const res = await router.handle({
      ...owner('/v1/workflow/tasks/c2/cancel'),
      params: { id: 'c2' },
    });
    expect(isPresenceRefusal(res)).toBe(false);
    expect(workflow.store().getById('c2')?.status).toBe('cancelled');
  });

  it('other cards are not gated (a tender-ready notice)', async () => {
    card('c3', TENDER_READY_TYPE);
    const res = await router.handle({
      ...owner('/v1/workflow/tasks/c3/approve'),
      params: { id: 'c3' },
    });
    expect(isPresenceRefusal(res)).toBe(false);
  });

  it('the gate holds for the phone’s in-process owner too (no owner stamp)', async () => {
    card('c4', NEGOTIATION_PRICE_APPROVAL_TYPE);
    const inProcess: CoreRequest = {
      method: 'POST',
      path: '/v1/workflow/tasks/c4/approve',
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: { id: 'c4' },
      trustedInProcess: true,
    };
    expect(isPresenceRefusal(await router.handle(inProcess))).toBe(true);
  });
});
