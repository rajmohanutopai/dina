/**
 * The gateway's doors into Core (design §4.1, §4.3, §7.5): one route per A2A
 * method and the two delivery doors, open to the gateway alone — in the
 * authorization matrix and again in each handler — and nothing else open
 * to it.
 */

import {
  A2A_DID_COMPLETE_ROUTE,
  A2A_EVENTS_ACK_ROUTE,
  A2A_EVENTS_CLAIM_ROUTE,
  A2A_METHODS,
  ingressRouteOf,
} from '@dina/a2a';

import { isAuthorized, type CallerType } from '../../src/auth/authz';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { isA2AGatewayRoute, registerA2AIngressRoutes } from '../../src/server/routes/a2a_ingress';

import { InboundWorld, sentTask } from './inbound_fixture';

const concrete = (template: string) =>
  template.replace(':extId', 't-1').replace(':configId', 'c-1');
const methodRoutes = A2A_METHODS.map((m) => concrete(ingressRouteOf(m)));
const deliveryRoutes = [A2A_EVENTS_CLAIM_ROUTE, A2A_EVENTS_ACK_ROUTE, A2A_DID_COMPLETE_ROUTE];

describe('the authorization matrix', () => {
  it.each([...methodRoutes, ...deliveryRoutes])(
    'opens POST %s to the gateway and no one else',
    (path) => {
      expect(isAuthorized('gateway', 'POST', path)).toBe(true);
      for (const other of ['brain', 'device', 'agent', 'plugin', 'owner'] as CallerType[]) {
        expect(isAuthorized(other, 'POST', path)).toBe(false);
      }
      expect(isAuthorized('gateway', 'GET', path)).toBe(false);
    },
  );

  it('opens nothing else to the gateway', () => {
    for (const path of [
      '/v1/a2a/ingress/events',
      '/v1/a2a/ingress/message/other',
      '/v1/workflow/tasks/claim',
      '/v1/vault/query',
    ]) {
      expect(isAuthorized('gateway', 'POST', path)).toBe(false);
    }
  });

  it('the hosts’ limiter exemption covers exactly the same routes', () => {
    for (const path of [...methodRoutes, ...deliveryRoutes])
      expect(isA2AGatewayRoute('POST', path)).toBe(true);
    expect(isA2AGatewayRoute('GET', '/v1/a2a/card')).toBe(true);
    expect(isA2AGatewayRoute('POST', '/v1/a2a/ingress/events')).toBe(false);
    expect(isA2AGatewayRoute('GET', A2A_EVENTS_CLAIM_ROUTE)).toBe(false);
  });
});

describe('through the router', () => {
  let iw: InboundWorld;
  const router = new CoreRouter();
  registerA2AIngressRoutes(router);
  const post = (
    path: string,
    body: unknown,
    callerType = 'gateway',
    callerDID = 'did:key:z6MkGateway',
  ) =>
    router.handle({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body,
      rawBody: new TextEncoder().encode(JSON.stringify(body)),
      params: {},
      trustedInProcess: true,
      callerType,
      callerDID,
    } as unknown as CoreRequest);

  beforeEach(async () => {
    iw = await InboundWorld.create();
  });
  afterEach(() => iw.close());

  it('registers a route for every A2A method; a caller other than the gateway is refused in the handler too', async () => {
    for (const path of methodRoutes) {
      expect((await post(path, iw.request('GetTask', { id: 't-1' }), 'brain')).status).toBe(403);
      expect((await post(path, { not: 'an envelope' })).status).toBe(400);
    }
  });

  it('claims and reports task events, the gateway alone', async () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    iw.claimChild(id);
    expect((await post(A2A_EVENTS_CLAIM_ROUTE, {}, 'brain')).status).toBe(403);
    const claimed = await post(A2A_EVENTS_CLAIM_ROUTE, { limit: 10, webhook_limit: 4 });
    expect(claimed.status).toBe(200);
    const items = (claimed.body as { items: { id: number; claim_id: string; task_id: string }[] })
      .items;
    expect(items.map((i) => i.task_id)).toEqual([id]);
    expect(
      (await post(A2A_EVENTS_ACK_ROUTE, { acks: [{ id: 1, claim_id: 'x', outcome: 'gone' }] }))
        .status,
    ).toBe(400);
    // The claim is held under the DID that made it, through the route.
    const [first] = items;
    if (first === undefined) throw new Error('no item');
    expect(iw.world.store.getOutboxRow(first.id)).toEqual(expect.objectContaining({ status: 'claimed', claimed_by: 'did:key:z6MkGateway' }));
    // Cold audit C6-13: another gateway key cannot report a claim it does not hold, even with its
    // claim id; asked while the claim is live, so only the claimant binding can refuse it.
    const foreign = await post(
      A2A_EVENTS_ACK_ROUTE,
      { acks: [{ id: first.id, claim_id: first.claim_id, outcome: 'delivered' }] },
      'gateway',
      'did:key:z6MkOther',
    );
    expect(foreign.body).toEqual({ applied: 0 });
    expect(iw.world.store.getOutboxRow(first.id)?.status).toBe('claimed');
    const acked = await post(A2A_EVENTS_ACK_ROUTE, {
      acks: items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' })),
    });
    expect(acked.body).toEqual({ applied: 1 });
    expect(iw.world.store.getOutboxRow(first.id)?.status).toBe('delivered');
  });

  it('a claim asks for at most the cap, whatever it says', async () => {
    expect((await post(A2A_EVENTS_CLAIM_ROUTE, { limit: 'all' })).status).toBe(200);
    expect((await post(A2A_EVENTS_CLAIM_ROUTE, [])).status).toBe(400);
  });
});
