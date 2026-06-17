/**
 * GET /v1/identity — public node-identity surface for thin clients.
 *
 * The route is `auth: 'public'` (the DID lives in the PLC directory and
 * the handle is the public ATProto handle — neither is a secret), and it
 * is the single source of truth a thin web client adopts via the
 * brain-server proxy at `/api/v1/identity`. These tests exercise the real
 * router so the public-auth wiring + payload shape are both covered.
 */

import {
  setNodeDID,
  setNodeHandle,
  clearPairingState,
} from '../../../src/pairing/ceremony';
import { createCoreRouter } from '../../../src/server/core_server';
import type { CoreRequest } from '../../../src/server/router';

function getIdentityReq(): CoreRequest {
  return {
    method: 'GET',
    path: '/v1/identity',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(0),
    params: {},
  };
}

let router: ReturnType<typeof createCoreRouter>;

beforeEach(() => {
  clearPairingState();
  router = createCoreRouter();
});

describe('GET /v1/identity', () => {
  it('returns the node DID + handle once identity is loaded', async () => {
    setNodeDID('did:plc:alonso123');
    setNodeHandle('alonso.test-pds.dinakernel.com');

    const res = await router.handle(getIdentityReq());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      did: 'did:plc:alonso123',
      handle: 'alonso.test-pds.dinakernel.com',
    });
  });

  it('returns a null handle for a did:key node with no PDS handle', async () => {
    setNodeDID('did:key:z6Mklocalnode');
    // setNodeHandle never called — handle stays null.

    const res = await router.handle(getIdentityReq());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ did: 'did:key:z6Mklocalnode', handle: null });
  });

  it('returns both null before identity is loaded (fresh boot)', async () => {
    const res = await router.handle(getIdentityReq());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ did: null, handle: null });
  });

  it('normalises a blank handle to null', async () => {
    setNodeDID('did:plc:alonso123');
    setNodeHandle('   ');

    const res = await router.handle(getIdentityReq());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ did: 'did:plc:alonso123', handle: null });
  });

  it('is reachable WITHOUT auth headers (public route)', async () => {
    setNodeDID('did:plc:alonso123');
    setNodeHandle('alonso.test-pds.dinakernel.com');

    // No X-DID / X-Signature headers — a public route must not 401.
    const res = await router.handle(getIdentityReq());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
