/**
 * CoreRouter tests — transport-agnostic routing + auth + dispatch.
 */

import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { createInProcessDispatch } from '../../src/server/in_process_dispatch';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../src/auth/middleware';
import { registerService, resetCallerTypeState } from '../../src/auth/caller_type';
import { signRequest } from '../../src/auth/canonical';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const SEED = TEST_ED25519_SEED;
const PUB = getPublicKey(SEED);
const DID = deriveDIDKey(PUB);

function emptyReq(overrides: Partial<CoreRequest> = {}): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(0),
    params: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((d) => (d === DID ? PUB : null));
  registerService(DID, 'brain');
});

describe('CoreRouter — registration', () => {
  it('requires paths to start with /', () => {
    const r = new CoreRouter();
    expect(() => r.get('v1/foo', async () => ({ status: 200 }))).toThrow(/start with '\/'/);
  });

  it('rejects duplicate method+path', () => {
    const r = new CoreRouter();
    r.get('/v1/x', async () => ({ status: 200 }));
    expect(() => r.get('/v1/x', async () => ({ status: 200 }))).toThrow(/duplicate/);
  });

  it('allows same path with different methods', () => {
    const r = new CoreRouter();
    r.get('/v1/x', async () => ({ status: 200 }));
    r.post('/v1/x', async () => ({ status: 201 }));
    expect(r.size()).toBe(2);
  });
});

describe('CoreRouter — path matching', () => {
  it('matches literal paths', async () => {
    const r = new CoreRouter();
    r.get('/v1/ping', async () => ({ status: 200, body: { ok: true } }), { auth: 'public' });
    const resp = await r.handle(emptyReq({ method: 'GET', path: '/v1/ping' }));
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ ok: true });
  });

  it('returns 401 for unsigned requests (auth runs before match)', async () => {
    // Intentional: keeps 401 vs 404 uniform so an unauthenticated probe
    // can't map the routing table by response code. A signed caller sees
    // the actual route-existence answer.
    const r = new CoreRouter();
    r.get('/v1/x', async () => ({ status: 200 }), { auth: 'public' });
    const resp = await r.handle(emptyReq({ method: 'GET', path: '/nope' }));
    expect(resp.status).toBe(401);
  });

  it('extracts :param placeholders', async () => {
    const r = new CoreRouter();
    r.post(
      '/v1/tasks/:id/done',
      async (req) => ({
        status: 200,
        body: { id: req.params.id },
      }),
      { auth: 'public' },
    );
    const resp = await r.handle(emptyReq({ method: 'POST', path: '/v1/tasks/abc-42/done' }));
    expect(resp.body).toEqual({ id: 'abc-42' });
  });

  it('URL-decodes path params', async () => {
    const r = new CoreRouter();
    r.get(
      '/v1/item/:key',
      async (req) => ({
        status: 200,
        body: { key: req.params.key },
      }),
      { auth: 'public' },
    );
    const resp = await r.handle(
      emptyReq({
        method: 'GET',
        path: '/v1/item/hello%20world',
      }),
    );
    expect(resp.body).toEqual({ key: 'hello world' });
  });

  it('method mismatch on a public route still requires auth (consistent 401 surface)', async () => {
    const r = new CoreRouter();
    r.get('/v1/x', async () => ({ status: 200 }), { auth: 'public' });
    // POST /v1/x — the GET handler is public but the POST isn't, and
    // there's no POST registration, so auth runs first. Unsigned → 401.
    const resp = await r.handle(emptyReq({ method: 'POST', path: '/v1/x' }));
    expect(resp.status).toBe(401);
  });
});

describe('CoreRouter — auth pipeline', () => {
  it('rejects signed routes when headers missing', async () => {
    const r = new CoreRouter();
    r.get('/v1/protected', async () => ({ status: 200 }));
    const resp = await r.handle(emptyReq({ method: 'GET', path: '/v1/protected' }));
    expect(resp.status).toBe(401);
    expect((resp.body as { rejected_at: string }).rejected_at).toBe('headers');
  });

  it('allows signed routes with valid Ed25519 headers (authorised path)', async () => {
    const r = new CoreRouter();
    // /v1/workflow/ is in the authz allowlist for caller type 'brain'
    // (see auth/authz.ts); DID is registered as a brain service in beforeEach.
    r.get('/v1/workflow/tasks', async () => ({ status: 200, body: { ok: true } }));
    const headers = signRequest('GET', '/v1/workflow/tasks', '', new Uint8Array(0), SEED, DID);
    const resp = await r.handle(
      emptyReq({
        method: 'GET',
        path: '/v1/workflow/tasks',
        headers: {
          'x-did': headers['X-DID'],
          'x-timestamp': headers['X-Timestamp'],
          'x-nonce': headers['X-Nonce'],
          'x-signature': headers['X-Signature'],
        },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it('returns 403 when signed but not authorised for the path', async () => {
    const r = new CoreRouter();
    // /v1/some-random-path isn't in any authz rule — a registered brain
    // caller still gets rejected by the authz matrix.
    r.get('/v1/some-random-path', async () => ({ status: 200 }));
    const headers = signRequest('GET', '/v1/some-random-path', '', new Uint8Array(0), SEED, DID);
    const resp = await r.handle(
      emptyReq({
        method: 'GET',
        path: '/v1/some-random-path',
        headers: {
          'x-did': headers['X-DID'],
          'x-timestamp': headers['X-Timestamp'],
          'x-nonce': headers['X-Nonce'],
          'x-signature': headers['X-Signature'],
        },
      }),
    );
    expect(resp.status).toBe(403);
  });

  it('public routes skip auth entirely', async () => {
    const r = new CoreRouter();
    r.get('/healthz', async () => ({ status: 200, body: { ok: true } }), { auth: 'public' });
    const resp = await r.handle(emptyReq({ method: 'GET', path: '/healthz' }));
    expect(resp.status).toBe(200);
  });
});

describe('CoreRouter — handler errors', () => {
  it('surfaces thrown errors as structured 500', async () => {
    const r = new CoreRouter();
    r.get(
      '/v1/boom',
      async () => {
        throw new Error('kaboom');
      },
      { auth: 'public' },
    );
    const resp = await r.handle(emptyReq({ method: 'GET', path: '/v1/boom' }));
    expect(resp.status).toBe(500);
    expect((resp.body as { detail: string }).detail).toBe('kaboom');
  });
});

describe('createInProcessDispatch', () => {
  it('parses query strings + JSON body before dispatch', async () => {
    const r = new CoreRouter();
    let captured: CoreRequest | null = null;
    r.post(
      '/v1/echo',
      async (req) => {
        captured = req;
        return { status: 200, body: { seen: true } };
      },
      { auth: 'public' },
    );
    const dispatch = createInProcessDispatch({ router: r });
    const body = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
    const resp = await dispatch(
      'POST',
      '/v1/echo?foo=bar&baz=qux',
      {
        'content-type': 'application/json',
      },
      body,
    );
    expect(resp.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.query).toEqual({ foo: 'bar', baz: 'qux' });
    expect(captured!.body).toEqual({ hello: 'world' });
    expect(captured!.rawBody).toEqual(body);
  });

  it('hands through non-JSON bodies as Uint8Array', async () => {
    const r = new CoreRouter();
    let seen: unknown = null;
    r.post(
      '/v1/bin',
      async (req) => {
        seen = req.body;
        return { status: 200 };
      },
      { auth: 'public' },
    );
    const dispatch = createInProcessDispatch({ router: r });
    const body = new Uint8Array([1, 2, 3, 4]);
    await dispatch('POST', '/v1/bin', { 'content-type': 'application/octet-stream' }, body);
    expect(seen).toEqual(body);
  });

  it('sets body=undefined for empty bodies', async () => {
    const r = new CoreRouter();
    let seen: unknown = 'unchanged';
    r.get(
      '/v1/get',
      async (req) => {
        seen = req.body;
        return { status: 200 };
      },
      { auth: 'public' },
    );
    const dispatch = createInProcessDispatch({ router: r });
    await dispatch('GET', '/v1/get', {}, new Uint8Array(0));
    expect(seen).toBeUndefined();
  });

  it('lower-cases header keys for portable access', async () => {
    const r = new CoreRouter();
    let headers: Record<string, string> = {};
    r.get(
      '/v1/h',
      async (req) => {
        headers = req.headers;
        return { status: 200 };
      },
      { auth: 'public' },
    );
    const dispatch = createInProcessDispatch({ router: r });
    await dispatch('GET', '/v1/h', { 'X-Custom': 'abc', 'X-DID': 'did:plc:x' }, new Uint8Array(0));
    expect(headers['x-custom']).toBe('abc');
    expect(headers['x-did']).toBe('did:plc:x');
  });

  it('round-trips a signed request end-to-end via dispatch', async () => {
    const r = new CoreRouter();
    r.post('/v1/workflow/tasks', async (req) => ({
      status: 200,
      body: { echoed: req.body },
    }));
    const dispatch = createInProcessDispatch({ router: r });
    const bodyStr = JSON.stringify({ task: 'run' });
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const headers = signRequest('POST', '/v1/workflow/tasks', '', bodyBytes, SEED, DID);
    const resp = await dispatch(
      'POST',
      '/v1/workflow/tasks',
      {
        'content-type': 'application/json',
        'x-did': headers['X-DID'],
        'x-timestamp': headers['X-Timestamp'],
        'x-nonce': headers['X-Nonce'],
        'x-signature': headers['X-Signature'],
      },
      bodyBytes,
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { echoed: unknown }).echoed).toEqual({ task: 'run' });
  });
});
