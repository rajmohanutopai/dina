/**
 * WEB_OWNER_SURFACE_PLAN §3.3 — the owner device.
 *
 * A browser the owner connected is a paired device with role `owner`. The
 * load-bearing rules:
 *   - it resolves to its OWN caller class, never the generic `device`;
 *   - the authz matrix grants that class nothing, anywhere — including the
 *     owner surface itself;
 *   - `authenticateOwnerDevice` verifies it with the same signed pipeline as
 *     every device (window, signature, nonce, rate limit) and admits only the
 *     owner role; the host's owner entry point is its only way in.
 */

import { randomBytes } from '@noble/ciphers/utils.js';

import { isAuthorized } from '../../src/auth/authz';
import {
  registerDevice,
  resetCallerTypeState,
  resolveCallerType,
  setDeviceRoleResolver,
} from '../../src/auth/caller_type';
import { signRequest } from '../../src/auth/canonical';
import {
  authenticateOwnerDevice,
  authenticateRequest,
  registerPublicKeyResolver,
  resetMiddlewareState,
  type AuthRequest,
} from '../../src/auth/middleware';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { authenticateOwnerDeviceCore, namesOwnerDevice } from '../../src/server/router';

import type { CoreRequest } from '../../src/server/router';

interface Actor {
  did: string;
  seed: Uint8Array;
  pub: Uint8Array;
}

function actor(): Actor {
  const seed = randomBytes(32);
  const pub = getPublicKey(seed);
  return { did: deriveDIDKey(pub), seed, pub };
}

const owner = actor();
const staff = actor();
const stranger = actor();
const roles: Record<string, string> = { [owner.did]: 'owner', [staff.did]: 'staff' };

function signed(a: Actor, method: string, path: string, body = ''): AuthRequest {
  const bytes = new TextEncoder().encode(body);
  return {
    method,
    path,
    query: '',
    body: bytes,
    headers: signRequest(method, path, '', bytes, a.seed, a.did),
  };
}

beforeEach(() => {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((did) =>
    did === owner.did ? owner.pub : did === staff.did ? staff.pub : null,
  );
  registerDevice(owner.did, 'Office laptop');
  registerDevice(staff.did, 'Clerk phone');
  setDeviceRoleResolver((did) => roles[did] ?? null);
});

afterEach(() => {
  resetMiddlewareState();
  resetCallerTypeState();
});

describe('caller class', () => {
  it("role 'owner' resolves to 'owner_device', never the generic 'device'", () => {
    expect(resolveCallerType(owner.did).callerType).toBe('owner_device');
  });
});

describe('authz matrix grants an owner device nothing', () => {
  const PATHS: [string, string][] = [
    // The owner surface itself: reached only through the host's entry point.
    ['GET', '/v1/commerce/trade/inbox'],
    ['POST', '/v1/commerce/orders/from_quote'],
    ['POST', '/v1/plugins/install/begin'],
    ['GET', '/v1/owner/setup/status'],
    ['POST', '/v1/run'],
    ['GET', '/v1/workflow/tasks'],
    ['POST', '/v1/workflow/tasks/abc/approve'],
    // And the generic device surface an unmapped role would inherit.
    ['POST', '/v1/vault/query'],
    ['GET', '/v1/personas'],
    ['GET', '/v1/devices'],
    ['POST', '/v1/pair/initiate'],
    ['POST', '/api/v1/ask'],
  ];
  it.each(PATHS)('refuses %s %s', (method, path) => {
    expect(isAuthorized('owner_device', method, path)).toBe(false);
  });

  it('a signed owner-device request through the ordinary pipeline is refused at authorization', () => {
    const r = authenticateRequest(signed(owner, 'GET', '/v1/commerce/trade/inbox'));
    expect(r.authenticated).toBe(false);
    expect(r.rejectedAt).toBe('authorization');
  });
});

describe('authenticateOwnerDevice', () => {
  it('admits a correctly signed owner device', () => {
    const r = authenticateOwnerDevice(
      signed(owner, 'POST', '/v1/commerce/trade/tender/award', '{"a":1}'),
    );
    expect(r).toEqual({ authenticated: true, did: owner.did, callerType: 'owner_device' });
  });

  it('refuses a correctly signed device of any other role', () => {
    const r = authenticateOwnerDevice(signed(staff, 'GET', '/v1/commerce/trade/inbox'));
    expect(r.authenticated).toBe(false);
    expect(r.rejectedAt).toBe('authorization');
  });

  it('refuses an unknown key', () => {
    const r = authenticateOwnerDevice(signed(stranger, 'GET', '/v1/commerce/trade/inbox'));
    expect(r.authenticated).toBe(false);
  });

  it('refuses a body changed after signing', () => {
    const req = signed(owner, 'POST', '/v1/commerce/orders/submit', '{"approval_id":"a"}');
    const r = authenticateOwnerDevice({
      ...req,
      body: new TextEncoder().encode('{"approval_id":"b"}'),
    });
    expect(r.rejectedAt).toBe('signature');
  });

  it('refuses a replay (the nonce is spent once)', () => {
    const req = signed(owner, 'GET', '/v1/workflow/tasks');
    expect(authenticateOwnerDevice(req).authenticated).toBe(true);
    expect(authenticateOwnerDevice(req).rejectedAt).toBe('nonce');
  });

  it('refuses a request outside the time window', () => {
    const req = signed(owner, 'GET', '/v1/workflow/tasks');
    const stale = { ...req, headers: { ...req.headers, 'X-Timestamp': '2020-01-01T00:00:00Z' } };
    expect(authenticateOwnerDevice(stale).rejectedAt).toBe('timestamp');
  });

  it('a revoked (unregistered) owner device is refused', () => {
    resetCallerTypeState();
    setDeviceRoleResolver((did) => roles[did] ?? null);
    expect(authenticateOwnerDevice(signed(owner, 'GET', '/v1/workflow/tasks')).authenticated).toBe(
      false,
    );
  });
});

describe('the CoreRequest helpers the host uses', () => {
  function coreReq(a: Actor, method: CoreRequest['method'], path: string): CoreRequest {
    const h = signRequest(method, path, '', new Uint8Array(), a.seed, a.did);
    return {
      method,
      path,
      query: {},
      headers: {
        'x-did': h['X-DID'],
        'x-timestamp': h['X-Timestamp'],
        'x-nonce': h['X-Nonce'],
        'x-signature': h['X-Signature'],
      },
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
    };
  }

  it('namesOwnerDevice is true only for an owner device, and spends nothing', () => {
    const req = coreReq(owner, 'GET', '/v1/workflow/tasks');
    expect(namesOwnerDevice(req)).toBe(true);
    expect(namesOwnerDevice(coreReq(staff, 'GET', '/v1/workflow/tasks'))).toBe(false);
    expect(namesOwnerDevice({ ...req, headers: {} })).toBe(false);
    // The nonce is still unspent: verification afterwards succeeds.
    expect(authenticateOwnerDeviceCore(req).authenticated).toBe(true);
  });

  it('authenticateOwnerDeviceCore fails closed on malformed material', () => {
    const req = coreReq(owner, 'GET', '/v1/workflow/tasks');
    const bad = { ...req, headers: { ...req.headers, 'x-signature': 'not-hex' } };
    const r = authenticateOwnerDeviceCore(bad);
    expect(r.authenticated).toBe(false);
  });
});
