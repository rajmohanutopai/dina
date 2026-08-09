/**
 * The credential owner surface (§8.3, §18.3, §6.5 — WS-9.3 / WS-9.1).
 *
 * §8.3 forbids a generic secret read API, and the way that rule dies is
 * "the owner is allowed to see their own credential". So the first suite here
 * is not about a route's behaviour at all — it walks EVERY response the
 * surface can produce and asserts the material is in none of them. A test that
 * only checked the read route would pass on the day somebody added a
 * `GET /credentials/:resource` beside it.
 */

import { CredentialBroker } from '../../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../../src/commerce/credential_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';
const SECRET = 'sk-live-erp-token-0123456789abcd';

function request(
  method: Verb,
  path: string,
  body: Record<string, unknown> = {},
  callerType = 'owner',
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
    ...(callerType !== '' ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

let store: InMemoryCredentialStore;
let router: CoreRouter;

function installRuntime(): void {
  store = new InMemoryCredentialStore();
  installCommerceRuntime({
    availability: () => ({ available: true }),
    credentials: store,
    broker: new CredentialBroker({ store, executors: () => ({}) }),
    settings: {
      readSupplier: () => ({ ok: false, absent: true }),
      readBuyer: () => ({ ok: false, absent: true }),
      writeSupplier: () => ({ ok: true }),
      writeBuyer: () => ({ ok: true }),
    },
    orders: { listReserved: () => [] },
  } as unknown as CommerceRuntime);
}

beforeEach(() => {
  setNodeDID(SUPPLIER);
  installRuntime();
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  clearPairingState();
});

type Verb = 'GET' | 'PUT' | 'POST' | 'DELETE';

const PATHS: [Verb, string][] = [
  ['GET', '/v1/commerce/credentials'],
  ['PUT', '/v1/commerce/credentials/erp.primary'],
  ['DELETE', '/v1/commerce/credentials/erp.primary'],
  ['POST', '/v1/commerce/connector/change'],
];

describe('a credential cannot be read back, by anyone (§8.3)', () => {
  it('no response from any route on the surface carries the material', async () => {
    await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: ['read_catalog'],
      }),
    );
    // It really is stored — otherwise the assertions below prove nothing.
    let seen: string | null = null;
    await store.useSecret('erp.primary', async (secret) => {
      seen = secret;
      return null;
    });
    expect(seen).toBe(SECRET);

    for (const [method, path] of PATHS) {
      const response = await router.handle(
        request(method, path, {
          material: SECRET,
          install_id: 'install-1',
          operations: ['read_catalog'],
          previous: { domains: [], credential_resources: [], operations: [] },
          next: { domains: [], credential_resources: [], operations: [] },
        }),
      );
      expect(JSON.stringify(response.body ?? {})).not.toContain(SECRET);
    }
  });

  it('the rotation response carries no hint of the value either', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: ['read_catalog'],
      }),
    );
    // Not a prefix, not a length, not a hash: each narrows a guess and none
    // helps an owner decide anything.
    expect(response.body).toEqual({ ok: true, resource: 'erp.primary' });
  });

  it('there is no GET for a single credential', async () => {
    const response = await router.handle(request('GET', '/v1/commerce/credentials/erp.primary'));
    expect(response.status).toBe(404);
  });
});

describe('every credential route is owner-only', () => {
  it.each(PATHS)('%s %s refuses a non-owner caller', async (method, path) => {
    for (const callerType of ['agent', 'plugin', 'service', 'device']) {
      const response = await router.handle(request(method, path, {}, callerType));
      expect(response.status).toBe(403);
    }
  });

  it.each(PATHS)('%s %s refuses a caller with the wrong capability', async (method, path) => {
    const wrong = { ...request(method, path), ownerCapability: 'not-the-capability' };
    expect((await router.handle(wrong)).status).toBe(403);
  });

  it('a router registered with no capability refuses the owner too', async () => {
    const unguarded = new CoreRouter();
    registerCommerceRoutes(unguarded);
    for (const [method, path] of PATHS) {
      expect((await unguarded.handle(request(method, path))).status).toBe(403);
    }
  });
});

describe('rotation (§18.3)', () => {
  it('stores a credential and reports its status, never its value', async () => {
    await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: ['read_catalog', 'submit_purchase_order'],
      }),
    );
    const listed = await router.handle(request('GET', '/v1/commerce/credentials'));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      credentials: [
        {
          resource: 'erp.primary',
          install_id: 'install-1',
          operations: ['read_catalog', 'submit_purchase_order'],
          rotated_at_ms: expect.any(Number),
          last_result: 'never_used',
          last_checked_at_ms: null,
        },
      ],
    });
  });

  it('refuses a rotation missing any of its three required fields', async () => {
    const complete = {
      material: SECRET,
      install_id: 'install-1',
      operations: ['read_catalog'],
    };
    for (const field of ['material', 'install_id', 'operations'] as const) {
      const body: Record<string, unknown> = { ...complete };
      delete body[field];
      const response = await router.handle(
        request('PUT', '/v1/commerce/credentials/erp.primary', body),
      );
      expect(response.status).toBe(400);
    }
  });

  it('refuses an operations list that is not a list of strings', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: ['read_catalog', 7],
      }),
    );
    expect(response.status).toBe(400);
  });

  it('passes the store refusal through with its reason', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ ok: false, refusal: 'no_operations' });
  });

  it('removing a credential twice succeeds twice, and says which was real', async () => {
    await router.handle(
      request('PUT', '/v1/commerce/credentials/erp.primary', {
        material: SECRET,
        install_id: 'install-1',
        operations: ['read_catalog'],
      }),
    );
    const first = await router.handle(request('DELETE', '/v1/commerce/credentials/erp.primary'));
    const second = await router.handle(request('DELETE', '/v1/commerce/credentials/erp.primary'));
    expect(first.body).toEqual({ ok: true, resource: 'erp.primary', removed: true });
    // A 404 on the second would send a client into an error path over a
    // success: the owner asked for it to be gone, and it is gone.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, resource: 'erp.primary', removed: false });
  });

  it('answers 503 rather than 200 when commerce is not installed', async () => {
    installCommerceRuntime(null);
    for (const [method, path] of PATHS.slice(0, 3)) {
      const response = await router.handle(request(method, path));
      expect(response.status).toBe(503);
    }
  });
});

describe('changing backend (§6.5)', () => {
  it('reports a widening and names what widened', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/connector/change', {
        previous: { domains: [], credential_resources: [], operations: ['read_catalog'] },
        next: {
          domains: ['erp.example.com'],
          credential_resources: ['erp.primary'],
          operations: ['read_catalog', 'submit_purchase_order'],
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      requires_reconsent: true,
      widened: {
        domains: ['erp.example.com'],
        credential_resources: ['erp.primary'],
        operations: ['submit_purchase_order'],
      },
    });
  });

  it('reports an ordinary edit when nothing widened', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/connector/change', {
        previous: {
          domains: ['erp.example.com'],
          credential_resources: ['erp.primary'],
          operations: ['read_catalog'],
        },
        next: { domains: [], credential_resources: [], operations: [] },
      }),
    );
    expect(response.body).toEqual({ requires_reconsent: false });
  });

  it('refuses a missing declaration rather than reading it as empty', async () => {
    // An absent `next` read as "declares nothing" would make a widening look
    // like an ordinary edit — the dangerous direction of the same mistake.
    for (const body of [
      { previous: { domains: [], credential_resources: [], operations: [] } },
      { next: { domains: [], credential_resources: [], operations: [] } },
      {},
    ]) {
      const response = await router.handle(request('POST', '/v1/commerce/connector/change', body));
      expect(response.status).toBe(400);
    }
  });

  it('ignores non-string entries rather than counting them as declarations', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/connector/change', {
        previous: { domains: ['erp.example.com'], credential_resources: [], operations: [] },
        next: { domains: ['erp.example.com', 7, null], credential_resources: [], operations: [] },
      }),
    );
    expect(response.body).toEqual({ requires_reconsent: false });
  });
});
