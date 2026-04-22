/**
 * Pair routes — `POST /v1/pair/initiate` (admin) + `POST /v1/pair/complete` (public).
 *
 * Proves the two-phase handshake `dina-admin device pair` +
 * `dina configure --pairing-code …` uses:
 *   1. Admin calls initiate → gets a code tied to (device_name, role).
 *   2. Agent presents the code + its public key → registered as a
 *      paired device with callerType='agent', which unlocks the
 *      `/v1/workflow/tasks/claim` subtree.
 */

import { createCoreRouter } from '../../../src/server/core_server';
import type { CoreRequest } from '../../../src/server/router';
import { signRequest } from '../../../src/auth/canonical';
import { setNodeDID, clearPairingState } from '../../../src/pairing/ceremony';
import { resetDeviceRegistry, getDeviceByDID } from '../../../src/devices/registry';
import {
  resetCallerTypeState,
  registerService,
  resolveCallerType,
  setDeviceRoleResolver,
  isDevice,
} from '../../../src/auth/caller_type';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../../src/auth/middleware';
import { deriveDIDKey, publicKeyToMultibase } from '../../../src/identity/did';
import { getPublicKey } from '../../../src/crypto/ed25519';
import { randomBytes } from '@noble/ciphers/utils.js';

const NODE_DID = 'did:plc:test-node';

interface Actor {
  did: string;
  seed: Uint8Array;
  pub: Uint8Array;
}

function makeActor(): Actor {
  const seed = randomBytes(32);
  const pub = getPublicKey(seed);
  return { did: deriveDIDKey(pub), seed, pub };
}

function signedReq(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  actor: Actor,
): CoreRequest {
  const bodyBytes =
    body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  const headers = signRequest(method, path, '', bodyBytes, actor.seed, actor.did);
  return {
    method,
    path,
    query: {},
    headers: {
      'x-did': headers['X-DID'],
      'x-timestamp': headers['X-Timestamp'],
      'x-nonce': headers['X-Nonce'],
      'x-signature': headers['X-Signature'],
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : body,
    rawBody: bodyBytes,
    params: {},
  };
}

function unsignedReq(method: CoreRequest['method'], path: string, body: unknown): CoreRequest {
  const bodyBytes =
    body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  return {
    method,
    path,
    query: {},
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : body,
    rawBody: bodyBytes,
    params: {},
  };
}

let admin: Actor;
let router: ReturnType<typeof createCoreRouter>;

beforeEach(() => {
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  resetMiddlewareState();

  admin = makeActor();
  // Register the admin DID + its public key so signed requests resolve
  // to callerType='admin' and authz passes for `/v1/pair/initiate`.
  registerService(admin.did, 'admin');
  registerPublicKeyResolver((did) => (did === admin.did ? admin.pub : null));

  // Paired devices use this resolver to land as callerType='agent'
  // when their role is 'agent'.
  setDeviceRoleResolver((did) => {
    const device = getDeviceByDID(did);
    return device?.role ?? null;
  });

  setNodeDID(NODE_DID);
  router = createCoreRouter();
});

async function initiate(
  device_name = 'openclaw-user',
  role = 'agent',
): Promise<{ status: number; code?: string; body: unknown }> {
  const resp = await router.handle(
    signedReq('POST', '/v1/pair/initiate', { device_name, role }, admin),
  );
  const body = resp.body as { code?: string };
  return { status: resp.status, code: body?.code, body };
}

describe('POST /v1/pair/initiate — admin only', () => {
  it('generates a pairing code with the captured device_name + role', async () => {
    const result = await initiate('openclaw-user', 'agent');
    expect(result.status).toBe(201);
    expect(result.code).toMatch(/^\d{6}$/);
    const body = result.body as { device_name: string; role: string; expires_at: number };
    expect(body.device_name).toBe('openclaw-user');
    expect(body.role).toBe('agent');
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects unsigned callers with 401', async () => {
    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/initiate', { device_name: 'x', role: 'agent' }),
    );
    expect(resp.status).toBe(401);
  });

  it('rejects empty device_name with 400', async () => {
    const resp = await router.handle(
      signedReq('POST', '/v1/pair/initiate', { device_name: '', role: 'agent' }, admin),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toMatch(/device_name/);
  });

  it('rejects invalid role with 400', async () => {
    const resp = await router.handle(
      signedReq('POST', '/v1/pair/initiate', { device_name: 'x', role: 'overlord' }, admin),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toMatch(/role must be one of/);
  });
});

describe('POST /v1/pair/complete — public, code-authenticated', () => {
  it('is reachable without a signed request (the code IS the credential)', async () => {
    const { code } = await initiate();
    const agent = makeActor();
    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(agent.pub),
      }),
    );
    expect(resp.status).toBe(201);
  });

  it('registers the agent and promotes its DID to callerType="agent"', async () => {
    const { code } = await initiate('openclaw-user', 'agent');
    const agent = makeActor();

    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(agent.pub),
      }),
    );
    expect(resp.status).toBe(201);

    expect(isDevice(agent.did)).toBe(true);
    const caller = resolveCallerType(agent.did);
    expect(caller.callerType).toBe('agent');
    expect(caller.name).toBe('openclaw-user');
  });

  it('applies override device_name + role when supplied on complete', async () => {
    const { code } = await initiate('placeholder', 'rich');
    const agent = makeActor();

    await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(agent.pub),
        device_name: 'openclaw-user',
        role: 'agent',
      }),
    );

    const caller = resolveCallerType(agent.did);
    expect(caller.callerType).toBe('agent');
    expect(caller.name).toBe('openclaw-user');
  });

  it('rejects an unknown code', async () => {
    const agent = makeActor();
    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code: '000000',
        public_key: publicKeyToMultibase(agent.pub),
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toMatch(/invalid|expired/);
  });

  it('rejects missing public_key', async () => {
    const { code } = await initiate();
    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', { code, public_key: '' }),
    );
    expect(resp.status).toBe(400);
  });

  it('single-use: second completion with the same code fails', async () => {
    const { code } = await initiate();
    const first = makeActor();
    const second = makeActor();

    const ok = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(first.pub),
      }),
    );
    expect(ok.status).toBe(201);

    const again = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(second.pub),
      }),
    );
    expect(again.status).toBe(400);
  });
});
