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

import { randomBytes } from '@noble/ciphers/utils.js';

import {
  setAgentGatingPolicyRepository,
  type AgentGatingPolicy,
  type AgentGatingPolicyRepository,
  type SetAgentGatingPolicyInput,
} from '../../../src/agent/gating_policy';
import {
  InMemoryAgentGrantRepository,
  setAgentGrantRepository,
} from '../../../src/agent/grant_repository';
import {
  resetCallerTypeState,
  registerService,
  resolveCallerType,
  setDeviceRoleResolver,
  isDevice,
} from '../../../src/auth/caller_type';
import { signRequest } from '../../../src/auth/canonical';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../../src/auth/middleware';
import { getPublicKey } from '../../../src/crypto/ed25519';
import { resetDeviceRegistry, getDeviceByDID } from '../../../src/devices/registry';
import { setDeviceRepository } from '../../../src/devices/repository';
import { deriveDIDKey, publicKeyToMultibase } from '../../../src/identity/did';
import { setNodeDID, clearPairingState } from '../../../src/pairing/ceremony';
import { createCoreRouter } from '../../../src/server/core_server';

import type { PairedDevice } from '../../../src/devices/registry';
import type { DeviceRepository } from '../../../src/devices/repository';
import type { CoreRequest } from '../../../src/server/router';

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
let policyRepo: MemoryPolicyRepository;

class MemoryPolicyRepository implements AgentGatingPolicyRepository {
  private readonly policies = new Map<string, AgentGatingPolicy>();

  get(agentDid: string): AgentGatingPolicy | null {
    return this.policies.get(agentDid) ?? null;
  }
  list(): AgentGatingPolicy[] {
    return [...this.policies.values()];
  }
  set(input: SetAgentGatingPolicyInput): AgentGatingPolicy {
    const existing = this.get(input.agentDid);
    if (existing !== null || input.expectedVersion !== null) throw new Error('policy conflict');
    const now = input.nowMs ?? Date.now();
    const policy: AgentGatingPolicy = {
      agentDid: input.agentDid,
      profile: input.profile,
      policyVersion: 1,
      selectedByOwnerDid: input.selectedByOwnerDid,
      createdAtMs: now,
      updatedAtMs: now,
      revokedAtMs: null,
    };
    this.policies.set(input.agentDid, policy);
    return policy;
  }
  revoke(): boolean {
    return false;
  }
}

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

  // Round-15 #4: persistDeviceDurable now FAILS CLOSED when no durable repo is
  // wired (a null repo is not "durable"). Wire a working in-memory repo so the
  // happy-path 201s reflect a genuine durable write; error-injection cases below
  // override this with a throwing repo to exercise the 503 + rollback path.
  const okRepo: DeviceRepository = {
    register: async () => undefined,
    get: async () => null,
    getByPublicKey: async () => null,
    getByDID: async () => null,
    list: async () => [] as PairedDevice[],
    revoke: async () => false,
    touch: async () => undefined,
  };
  setDeviceRepository(okRepo);
  policyRepo = new MemoryPolicyRepository();
  setAgentGatingPolicyRepository(policyRepo);

  setNodeDID(NODE_DID);
  router = createCoreRouter();
});

afterEach(() => {
  setAgentGatingPolicyRepository(null);
});

async function initiate(
  device_name = 'openclaw-user',
  role = 'agent',
  scope?: 'coding' | 'runner',
): Promise<{ status: number; code?: string; body: unknown }> {
  const resp = await router.handle(
    signedReq(
      'POST',
      '/v1/pair/initiate',
      { device_name, role, ...(scope !== undefined ? { scope } : {}) },
      admin,
    ),
  );
  const body = resp.body as { code?: string };
  return { status: resp.status, code: body?.code, body };
}

describe('POST /v1/pair/initiate — admin only', () => {
  it('generates a pairing code with the captured device_name + role', async () => {
    const result = await initiate('openclaw-user', 'agent');
    expect(result.status).toBe(201);
    expect(result.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
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

  it("accepts role 'staff' (§6 — a staff phone pairs over the wire like any device)", async () => {
    const resp = await router.handle(
      signedReq('POST', '/v1/pair/initiate', { device_name: 'clerk-phone', role: 'staff' }, admin),
    );
    expect(resp.status).toBe(201);
    expect((resp.body as { role: string }).role).toBe('staff');
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

  it('round-15 #4: with NO durable repo wired, complete fails closed with 503 (not a false 201)', async () => {
    setDeviceRepository(null); // simulate a partial/misconfigured boot
    const origErr = console.error;
    console.error = (): void => {
      /* silence the sanctioned server-side diag log */
    };
    try {
      const { code } = await initiate();
      const agent = makeActor();
      const resp = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(agent.pub),
        }),
      );
      expect(resp.status).toBe(503); // persistDeviceDurable threw → not a false success
    } finally {
      console.error = origErr;
    }
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

  it('creates an explicit Standard profile for a newly paired coding agent', async () => {
    const { code } = await initiate('Claude Code', 'agent', 'coding');
    const agent = makeActor();

    const resp = await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(agent.pub),
      }),
    );

    expect(resp.status).toBe(201);
    expect(resp.body).toMatchObject({ gating_profile: 'network_protection' });
    expect(policyRepo.get(agent.did)).toMatchObject({
      agentDid: agent.did,
      profile: 'network_protection',
      selectedByOwnerDid: NODE_DID,
      policyVersion: 1,
    });
  });

  it('revokes a coding agent when its Standard profile cannot be persisted', async () => {
    setAgentGatingPolicyRepository(null);
    const originalError = console.error;
    console.error = (): void => {
      /* silence the expected PII-safe diagnostic */
    };
    try {
      const { code } = await initiate('Claude Code', 'agent', 'coding');
      const agent = makeActor();

      const resp = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(agent.pub),
        }),
      );

      expect(resp.status).toBe(503);
      expect(resp.body).toMatchObject({ error: 'pairing: policy setup failed' });
      expect(isDevice(agent.did)).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  it('honours a device_name override on complete but IGNORES a role override (role is fixed at initiate)', async () => {
    // SECURITY: the role is a privilege boundary the admin fixes at /initiate.
    // A completion-time `role` must NOT escalate a 'rich' code into 'agent'.
    const { code } = await initiate('placeholder', 'rich');
    const agent = makeActor();

    await router.handle(
      unsignedReq('POST', '/v1/pair/complete', {
        code,
        public_key: publicKeyToMultibase(agent.pub),
        device_name: 'openclaw-user',
        role: 'agent', // attempted escalation — must be ignored
      }),
    );

    const caller = resolveCallerType(agent.did);
    // The device_name override is a label, so it IS applied...
    expect(caller.name).toBe('openclaw-user');
    // ...but the role stays what the admin captured at initiate ('rich' → device),
    // NOT the escalated 'agent' the completer asked for.
    expect(caller.callerType).toBe('device');
    expect(caller.callerType).not.toBe('agent');
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

  // MT-2026-05-28-E-BUG2 — when the durable persistence path throws, the
  // 503 body must NOT leak the raw underlying error. A network probe of
  // /v1/pair/complete shouldn't learn the ORM / table / column / constraint
  // shape; that's a P2.9-class implementation-detail leak.
  it('503 body does NOT leak storage internals when persistDeviceDurable throws (MT-2026-05-28-E-BUG2)', async () => {
    // Stub a DeviceRepository whose register() throws with a sentinel that
    // mirrors the real op-sqlite UNIQUE error so any echo would be obvious.
    const SQL_SENTINEL =
      '[op-sqlite] statement execution error: UNIQUE constraint failed: paired_devices.device_id';
    const throwingRepo: DeviceRepository = {
      register: () => Promise.reject(new Error(SQL_SENTINEL)),
      get: async () => null,
      getByPublicKey: async () => null,
      getByDID: async () => null,
      list: async () => [] as PairedDevice[],
      revoke: async () => false,
      touch: async () => undefined,
    };
    // Silence the operator-facing console.error in this test (it's the
    // sanctioned server-side log path; we just don't want it in jest output).
    const origErr = console.error;
    console.error = (): void => {
      /* */
    };
    setDeviceRepository(throwingRepo);
    try {
      const { code } = await initiate();
      const actor = makeActor();
      const resp = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(resp.status).toBe(503);
      const body = resp.body as { error: string; diag_id: string };
      // Generic, fingerprint-free.
      expect(body.error).toMatch(/pairing: server error/);
      expect(body.diag_id).toMatch(/^[0-9a-f]{8}$/);
      // None of the storage-internal tokens may surface.
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain('sqlite');
      expect(serialised).not.toContain('paired_devices');
      expect(serialised).not.toContain('UNIQUE');
      expect(serialised).not.toContain('device_id');
      // And the raw sentinel must not appear anywhere.
      expect(serialised).not.toContain(SQL_SENTINEL);
    } finally {
      setDeviceRepository(null);
      console.error = origErr;
    }
  });

  it('round-9 #10: a persistence failure ROLLS BACK the in-memory + auth registration (key cannot authenticate)', async () => {
    // Durable persistence fails → 503. Without rollback the just-added device
    // key would still authenticate (in-memory registry + auth map survived)
    // until the next restart. Assert the DID is NOT a recognized device after.
    const throwingRepo: DeviceRepository = {
      register: () => Promise.reject(new Error('disk full')),
      get: async () => null,
      getByPublicKey: async () => null,
      getByDID: async () => null,
      list: async () => [] as PairedDevice[],
      revoke: async () => false,
      touch: async () => undefined,
    };
    const origErr = console.error;
    console.error = (): void => {
      /* */
    };
    setDeviceRepository(throwingRepo);
    try {
      const { code } = await initiate('openclaw-user', 'agent');
      const actor = makeActor();
      const resp = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(resp.status).toBe(503);
      // Rolled back: the DID is no longer a paired device and cannot authenticate.
      expect(isDevice(actor.did)).toBe(false);
      expect(resolveCallerType(actor.did).callerType).toBe('unknown');
    } finally {
      setDeviceRepository(null);
      console.error = origErr;
    }
  });

  // PLG-27 #2: the round-16 #3 restore is now GATED on a CONFIRMED durable
  // rollback. `revokeDeviceDurable` fails closed to `durable:false` (it never
  // throws for a persistence failure), and the same fault that failed persist can
  // leave a device row written-but-unrevoked — restoring the code unconditionally
  // would then let a SECOND device pair with it while the first stays trusted in
  // SQL. So the code is restored ONLY when the rollback durably lands; otherwise
  // it is burned and the user re-initiates pairing (access is cut in-memory
  // regardless).
  const okRepo: DeviceRepository = {
    register: async () => undefined,
    get: async () => null,
    getByPublicKey: async () => null,
    getByDID: async () => null,
    list: async () => [] as PairedDevice[],
    revoke: async () => false,
    touch: async () => undefined,
  };
  function makeThrowingRepo(revokeResult: boolean): DeviceRepository {
    return {
      register: () => Promise.reject(new Error('transient disk error')),
      get: async () => null,
      getByPublicKey: async () => null,
      getByDID: async () => null,
      list: async () => [] as PairedDevice[],
      revoke: async () => revokeResult,
      touch: async () => undefined,
    };
  }

  it('PLG-27 #2: a 503 with a CONFIRMED durable rollback restores the code — retry with the same code succeeds', async () => {
    const origErr = console.error;
    console.error = (): void => {
      /* silence the sanctioned server-side diag log */
    };
    // An agent-grant repo must be wired for the revoke's agent-grant cascade to
    // report success — otherwise `revokeDeviceDurable` downgrades `durable` to
    // false regardless of the SQL revoke, and the confirmed-durable path is
    // unreachable (production always wires this repo).
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
    try {
      const { code } = await initiate('openclaw-user', 'agent');
      const actor = makeActor();
      // First attempt: persist throws, BUT the durable rollback revoke SUCCEEDS
      // (revoke → true) → the rollback is confirmed durable → the code is safe to
      // restore, so a retry with the SAME code + a working repo succeeds.
      setDeviceRepository(makeThrowingRepo(true));
      const first = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(first.status).toBe(503);
      setDeviceRepository(okRepo);
      const retry = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(retry.status).toBe(201);
    } finally {
      setDeviceRepository(null);
      setAgentGrantRepository(null);
      console.error = origErr;
    }
  });

  it('PLG-27 #2: a 503 whose rollback is NOT durable BURNS the code — retry with the same code is refused (fail-closed)', async () => {
    const origErr = console.error;
    console.error = (): void => {
      /* silence the sanctioned server-side diag log */
    };
    try {
      const { code } = await initiate('openclaw-user', 'agent');
      const actor = makeActor();
      // First attempt: persist throws AND the durable rollback revoke FAILS
      // (revoke → false, durable:false) → the code must be burned, not restored.
      setDeviceRepository(makeThrowingRepo(false));
      const first = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(first.status).toBe(503);
      // A retry with the SAME code is refused — the code was consumed and not
      // restored, so the user must start a fresh pairing.
      setDeviceRepository(okRepo);
      const retry = await router.handle(
        unsignedReq('POST', '/v1/pair/complete', {
          code,
          public_key: publicKeyToMultibase(actor.pub),
        }),
      );
      expect(retry.status).not.toBe(201);
    } finally {
      setDeviceRepository(null);
      console.error = origErr;
    }
  });
});
