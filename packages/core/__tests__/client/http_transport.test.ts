/**
 * HttpCoreTransport smoke — proves the transport correctly
 *   - attaches the 4 signing headers returned by the injected signer,
 *   - round-trips request bodies as JSON bytes,
 *   - maps 200/201/404 per the CoreClient contract,
 *   - propagates non-2xx as thrown errors with context,
 *   - speaks the same wire format as InProcessTransport (snake_case on
 *     service routes, base64 on /did/sign, comma-joined personas on
 *     /memory/toc).
 *
 * No real HTTP hop — a mock `HttpClient` records every call the
 * transport makes and returns canned responses. Task 1.31 scaffold.
 */

import {
  HttpCoreTransport,
  type HttpClient,
  type HttpRequestInit,
  type HttpResponse,
  type CanonicalRequestSigner,
} from '../../src/client/http-transport';

interface RecordedCall {
  url: string;
  init: HttpRequestInit;
}

function makeStubClient(responder: (call: RecordedCall) => HttpResponse): {
  client: HttpClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: HttpClient = {
    async request(url, init) {
      const call = { url, init };
      calls.push(call);
      return responder(call);
    },
  };
  return { client, calls };
}

type SignerArgs = { method: string; path: string; query: string; body: Uint8Array };

/** Deterministic signer — returns fixed headers + captures last inputs. */
function makeStubSigner(): {
  signer: CanonicalRequestSigner;
  lastArgs: SignerArgs | null;
} {
  const state: { signer: CanonicalRequestSigner; lastArgs: SignerArgs | null } = {
    lastArgs: null,
    signer: async (args) => {
      state.lastArgs = args;
      return {
        did: 'did:plc:brain-test',
        timestamp: '2026-04-21T12:00:00Z',
        nonce: 'aa'.repeat(8),
        signature: `sig-${args.method}-${args.path}`,
      };
    },
  };
  return state;
}

/** Build a 200 OK HttpResponse from a JSON value. */
function ok(body: unknown, status = 200): HttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(text),
  };
}

describe('HttpCoreTransport (task 1.31)', () => {
  it('healthz round-trips + signs with 4 headers', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ status: 'ok', did: 'did:key:core', version: '0.0.0' }),
    );
    const stub = makeStubSigner();
    const signer = stub.signer;

    const t = new HttpCoreTransport({ baseUrl: 'http://core:8100', httpClient: client, signer });
    const h = await t.healthz();

    expect(h.status).toBe('ok');
    expect(h.version).toBe('0.0.0');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://core:8100/healthz');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers['x-did']).toBe('did:plc:brain-test');
    expect(calls[0]?.init.headers['x-nonce']).toHaveLength(16);
    expect(calls[0]?.init.headers['x-signature']).toBe('sig-GET-/healthz');
    // GET has no body → no content-type header set.
    expect(calls[0]?.init.headers['content-type']).toBeUndefined();
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('strips trailing slash from baseUrl', async () => {
    const { client, calls } = makeStubClient(() => ok({ status: 'ok', did: 'd', version: 'v' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core:8100/',
      httpClient: client,
      signer: stub.signer,
    });
    await t.healthz();
    expect(calls[0]?.url).toBe('http://core:8100/healthz');
  });

  it('vaultStore sends persona + item merged into a JSON body', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ id: 'item-new', storedAt: '2026-04-21T00:00:00Z' }, 201),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.vaultStore('personal', { type: 'note', content: { text: 'hi' } });

    expect(r.id).toBe('item-new');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ persona: 'personal', type: 'note', content: { text: 'hi' } });
    // The signer got the raw body bytes with matching length.
    expect(stub.lastArgs?.body.byteLength).toBe(calls[0]!.init.body!.byteLength);
  });

  it('vaultList serialises query params deterministically (sorted keys)', async () => {
    const { client, calls } = makeStubClient(() => ok({ items: [], count: 0, total: 0 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.vaultList('personal', { limit: 50, offset: 10, type: 'note' });

    // Keys sorted alphabetically: limit, offset, persona, type.
    expect(calls[0]?.url).toBe('http://core/v1/vault/list?limit=50&offset=10&persona=personal&type=note');
    // Signer sees the same query string (no leading ?) — keeps canonical
    // string construction deterministic.
    expect(stub.lastArgs?.query).toBe('limit=50&offset=10&persona=personal&type=note');
  });

  it('vaultDelete URL-encodes path params + passes persona as query', async () => {
    const { client, calls } = makeStubClient(() => ok({ deleted: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.vaultDelete('personal', 'a/b c');

    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://core/v1/vault/items/a%2Fb%20c?persona=personal');
  });

  it('didSign base64-encodes the payload bytes', async () => {
    const { client, calls } = makeStubClient(() => ok({ signature: 'deadbeef', did: 'did:key:c' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await t.didSign(payload);
    expect(r.signature).toBe('deadbeef');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent.payload).toBe('AQIDBAU='); // base64([1,2,3,4,5])
  });

  it('serviceConfig returns null on 404 (not throw)', async () => {
    const { client } = makeStubClient(() => ok({ error: 'service_config: not set' }, 404));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.serviceConfig()).resolves.toBeNull();
  });

  it('serviceQuery maps camelCase → snake_case on the wire + echoes taskId', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ task_id: 'sq-q-abc-xy', query_id: 'q-abc' }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.serviceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-abc',
      params: { route_id: '42' },
      ttlSeconds: 60,
      serviceName: 'SF Transit',
      schemaHash: 'a1b2c3d4',
    });
    expect(r.taskId).toBe('sq-q-abc-xy');
    expect(r.queryId).toBe('q-abc');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      to_did: 'did:plc:busdriver',
      capability: 'eta_query',
      query_id: 'q-abc',
      params: { route_id: '42' },
      ttl_seconds: 60,
      service_name: 'SF Transit',
      schema_hash: 'a1b2c3d4',
    });
    // Optional fields omitted (not `origin_channel`).
    expect(Object.keys(sent)).not.toContain('origin_channel');
  });

  it('memoryToC encodes persona filter as comma-joined string', async () => {
    const { client, calls } = makeStubClient(() => ok({ entries: [], limit: 25 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.memoryToC({ personas: ['personal', 'work'], limit: 25 });
    expect(calls[0]?.url).toBe('http://core/v1/memory/toc?limit=25&persona=personal%2Cwork');
  });

  it('throws on non-2xx with status + Core error message in the thrown message', async () => {
    const { client } = makeStubClient(() => ok({ error: 'simulated outage' }, 500));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.healthz()).rejects.toThrow(/healthz failed 500 — simulated outage/);
  });

  it('throws with status only when body is empty (no error field)', async () => {
    const emptyResponse: HttpResponse = {
      status: 502,
      headers: {},
      body: new Uint8Array(),
    };
    const { client } = makeStubClient(() => emptyResponse);
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.healthz()).rejects.toThrow(/healthz failed 502 — no error field/);
  });
});
