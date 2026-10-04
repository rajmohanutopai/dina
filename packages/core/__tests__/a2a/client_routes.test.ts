/**
 * Owner routes for inbound A2A clients and their grants (design §4.3, §5.1,
 * §5.2): owner-only; the bearer appears in the response that mints it and in
 * no other; revocation reports the grants it ended.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isAuthorized } from '../../src/auth/authz';
import { registerDevice, resetDeviceRegistry, revokeDevice } from '../../src/devices/registry';
import { setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { resetServiceConfigState, setServiceConfig } from '../../src/service/service_config';
import {
  SQLiteServiceGrantRepository,
  setServiceGrantRepository,
} from '../../src/service/service_grant_repository';

import { LaneWorld } from './outbound_fixture';

const CAP = 'owner-capability-for-tests';

let world: LaneWorld;
let router: CoreRouter;

beforeEach(() => {
  world = new LaneWorld();
  router = new CoreRouter();
  registerA2ARoutes(router, CAP);
  setServiceGrantRepository(new SQLiteServiceGrantRepository(world.store.db));
  resetServiceConfigState();
  setServiceConfig(
    {
      isDiscoverable: false,
      discoverability: 'known_only',
      status: 'active',
      name: 'Private ETA',
      capabilities: {
        eta_query: {
          mcpServer: 'transit',
          mcpTool: 'get_eta',
          responsePolicy: 'auto',
          category: 'transit',
        },
      },
    },
    'private',
  );
});

afterEach(() => {
  setServiceGrantRepository(null);
  resetServiceConfigState();
  world.close();
});

async function call(
  caller: 'owner' | 'brain' | 'agent',
  method: CoreRequest['method'],
  path: string,
  body: Record<string, unknown> = {},
) {
  return router.handle({
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(caller === 'owner'
      ? { callerType: 'owner', ownerCapability: CAP }
      : { callerType: caller, callerDID: 'did:key:caller' }),
  });
}

const json = (resp: CoreResponse) => resp.body as Record<string, unknown>;

describe('owner-only', () => {
  it.each([
    ['POST', '/v1/owner/a2a/clients'],
    ['GET', '/v1/owner/a2a/clients'],
    ['POST', '/v1/owner/a2a/clients/ac_x/rotate'],
    ['POST', '/v1/owner/a2a/clients/ac_x/revoke'],
    ['POST', '/v1/owner/a2a/clients/ac_x/did-challenge'],
    ['POST', '/v1/owner/a2a/clients/ac_x/grants'],
    ['GET', '/v1/owner/a2a/clients/ac_x/grants'],
    ['POST', '/v1/owner/a2a/grants/ag_x/revoke'],
  ] as const)(
    '%s %s refuses Brain and agents, and the matrix never opens it to Brain',
    async (method, path) => {
      expect((await call('brain', method, path)).status).toBe(403);
      expect((await call('agent', method, path)).status).toBe(403);
      expect(isAuthorized('brain', method, path)).toBe(false);
    },
  );
});

describe('client lifecycle through the routes', () => {
  it('creates, lists without the token, rotates, issues and revokes', async () => {
    const created = await call('owner', 'POST', '/v1/owner/a2a/clients', {
      display_name: 'Acme agent',
      scope: ['eta_query'],
    });
    expect(created.status).toBe(201);
    const { client, token } = json(created) as {
      client: { client_id: string; principal: string };
      token: string;
    };
    expect(token).toMatch(/^dina_a2a_/);

    const list = await call('owner', 'GET', '/v1/owner/a2a/clients');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect((json(list).clients as unknown[]).length).toBe(1);

    const rotated = await call('owner', 'POST', `/v1/owner/a2a/clients/${client.client_id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(json(rotated).token).not.toBe(token);

    const grant = await call('owner', 'POST', `/v1/owner/a2a/clients/${client.client_id}/grants`, {
      service_rkey: 'private',
      capability: 'eta_query',
    });
    expect(grant.status).toBe(201);
    expect(json(grant)).toEqual(
      expect.objectContaining({
        principal: client.principal,
        service_rkey: 'private',
        capability: 'eta_query',
      }),
    );
    const grants = await call('owner', 'GET', `/v1/owner/a2a/clients/${client.client_id}/grants`);
    expect((json(grants).grants as unknown[]).length).toBe(1);

    const revoked = await call('owner', 'POST', `/v1/owner/a2a/clients/${client.client_id}/revoke`);
    expect(json(revoked)).toEqual({ grants_revoked: 1 });
    expect(
      (await call('owner', 'POST', `/v1/owner/a2a/clients/${client.client_id}/revoke`)).status,
    ).toBe(409);
    expect(
      (await call('owner', 'POST', `/v1/owner/a2a/clients/${client.client_id}/rotate`)).status,
    ).toBe(409);
  });

  it('answers 400, 404 and 503 for the wrong input, the unknown and the unwired', async () => {
    expect(
      (await call('owner', 'POST', '/v1/owner/a2a/clients', { display_name: '' })).status,
    ).toBe(400);
    expect((await call('owner', 'POST', '/v1/owner/a2a/clients/ac_nope/rotate')).status).toBe(404);
    expect((await call('owner', 'GET', '/v1/owner/a2a/clients/ac_nope/grants')).status).toBe(404);
    expect((await call('owner', 'POST', '/v1/owner/a2a/grants/ag_nope/revoke')).status).toBe(404);
    const created = json(
      await call('owner', 'POST', '/v1/owner/a2a/clients', { display_name: 'A' }),
    ) as { client: { client_id: string } };
    expect(
      (await call('owner', 'POST', `/v1/owner/a2a/clients/${created.client.client_id}/grants`, {}))
        .status,
    ).toBe(400);
    expect(
      (
        await call('owner', 'POST', `/v1/owner/a2a/clients/${created.client.client_id}/grants`, {
          service_rkey: 'nope',
          capability: 'eta_query',
        })
      ).status,
    ).toBe(404);
    setServiceGrantRepository(null);
    expect(
      (await call('owner', 'POST', `/v1/owner/a2a/clients/${created.client.client_id}/revoke`))
        .status,
    ).toBe(503);
  });
});

describe('runner bindings', () => {
  afterEach(() => resetDeviceRegistry());

  it('binds a lane to a paired runner, lists it, and unbinds it; owner only', async () => {
    const device = registerDevice('Transit runner', 'z6MkRouteRunner', 'agent', 'runner');
    const runner = device.did;
    expect(
      (
        await call('brain', 'POST', '/v1/owner/a2a/runners', {
          lane: 'transit',
          device_did: runner,
        })
      ).status,
    ).toBe(403);
    const bound = await call('owner', 'POST', '/v1/owner/a2a/runners', {
      lane: 'transit',
      device_did: runner,
    });
    expect(bound.status).toBe(201);
    expect(json(bound)).toEqual(expect.objectContaining({ lane: 'transit', device_did: runner }));
    const list = json(await call('owner', 'GET', '/v1/owner/a2a/runners')).runners as {
      lane: string;
      live: boolean;
    }[];
    expect(list).toEqual([expect.objectContaining({ lane: 'transit', live: true })]);
    revokeDevice(device.deviceId);
    expect(
      (json(await call('owner', 'GET', '/v1/owner/a2a/runners')).runners as { live: boolean }[])[0]
        ?.live,
    ).toBe(false);
    expect((await call('owner', 'POST', '/v1/owner/a2a/runners/transit/unbind')).status).toBe(200);
    expect((await call('owner', 'POST', '/v1/owner/a2a/runners/transit/unbind')).status).toBe(404);
  });

  it.each([
    ['a reserved lane', { lane: 'plugin:x' }, 'lane_reserved'],
    ['a malformed lane', { lane: '../etc' }, 'lane_malformed'],
    [
      'a device that is no runner',
      { lane: 'transit', device_did: 'did:key:z6MkNobody' },
      'device_not_runner',
    ],
  ])('refuses %s', async (_name, input, reason) => {
    const out = await call('owner', 'POST', '/v1/owner/a2a/runners', {
      device_did: 'did:key:z6MkNobody',
      ...input,
    });
    expect([out.status, json(out).error]).toEqual([400, reason]);
  });
});

describe('the DID binding challenge (§5.1, M4)', () => {
  const ALICE_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  it('names the client and the DID; a fresh one replaces an unused one', async () => {
    setNodeDID('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
    const created = json(
      await call('owner', 'POST', '/v1/owner/a2a/clients', { display_name: 'Acme agent' }),
    );
    const id = (created.client as { client_id: string }).client_id;
    const path = `/v1/owner/a2a/clients/${id}/did-challenge`;
    const first = await call('owner', 'POST', path, { did: ALICE_DID });
    expect(first.status).toBe(201);
    expect(json(first)).toEqual({
      challenge: expect.stringMatching(/^dch_[A-Za-z0-9_-]{43}$/),
      expires_at: expect.any(Number),
      node_did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      client_id: id,
      did: ALICE_DID,
      binding_path: '/a2a/v1/did-binding',
    });
    const second = json(await call('owner', 'POST', path, { did: ALICE_DID }));
    expect(second.challenge).not.toBe(json(first).challenge);
    const live = world.store.db.query(
      'SELECT challenge_hash, did FROM a2a_did_challenges WHERE client_id = ?',
      [id],
    ) as { challenge_hash: string; did: string }[];
    expect(live).toEqual([
      { challenge_hash: bytesToHex(sha256(new TextEncoder().encode(String(second.challenge)))), did: ALICE_DID },
    ]);
    const listed = json(await call('owner', 'GET', '/v1/owner/a2a/clients')) as {
      clients: { client_id: string; credential: string }[];
    };
    expect(listed.clients.find((c) => c.client_id === id)?.credential).toBe('bearer');
  });

  it.each([
    ['no DID', {}, 400, 'did_malformed'],
    ['a DID that is not one', { did: 'alice' }, 400, 'did_malformed'],
    ['another DID than the client\'s expected one', { did: 'did:plc:mallory00000000000000000' }, 400, 'did_not_expected'],
  ])('refuses %s', async (_name, body, status, error) => {
    setNodeDID('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
    const created = json(
      await call('owner', 'POST', '/v1/owner/a2a/clients', { display_name: 'Pinned', expected_did: ALICE_DID }),
    );
    const id = (created.client as { client_id: string }).client_id;
    const out = await call('owner', 'POST', `/v1/owner/a2a/clients/${id}/did-challenge`, body);
    expect([out.status, json(out).error]).toEqual([status, error]);
  });

  it('refuses an unknown client', async () => {
    setNodeDID('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
    const out = await call('owner', 'POST', '/v1/owner/a2a/clients/ac_missing/did-challenge', { did: ALICE_DID });
    expect(out.status).toBe(404);
  });
});
