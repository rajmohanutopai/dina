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
import { WorkflowConflictError } from '../../src';

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
    const r = await t.sendServiceQuery({
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

  // ─── Staging inbox (task 1.29h / 1.32 preamble) ───────────────────────

  it('stagingIngest sends snake_case wire body + returns camelCase result', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ id: 'stg-new', duplicate: false, status: 'received' }, 201),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingIngest({
      source: 'chat',
      sourceId: 'msg-1',
      producerId: 'did:plc:brain',
      data: { body: 'remember this' },
      expiresAt: 1_800_000_000,
    });
    expect(r).toEqual({ itemId: 'stg-new', duplicate: false, status: 'received' });
    expect(calls[0]?.url).toBe('http://core/v1/staging/ingest');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      source: 'chat',
      source_id: 'msg-1',
      producer_id: 'did:plc:brain',
      data: { body: 'remember this' },
      expires_at: 1_800_000_000,
    });
  });

  it('stagingClaim encodes limit via sorted query + POST with empty body', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ items: [{ id: 'stg-0' }, { id: 'stg-1' }], count: 2 }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingClaim(5);
    expect(r.count).toBe(2);
    expect(r.items).toHaveLength(2);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://core/v1/staging/claim?limit=5');
    // No body → no content-type header + undefined request.body.
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.headers['content-type']).toBeUndefined();
  });

  it('stagingResolve sends `persona` and `persona_open` for single-persona resolve', async () => {
    const { client, calls } = makeStubClient(() => ok({ id: 'stg-a', status: 'stored' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingResolve({
      itemId: 'stg-a',
      persona: 'health',
      data: { text: 'sample' },
      personaOpen: true,
    });
    expect(r.itemId).toBe('stg-a');
    expect(r.personas).toBeUndefined();
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      id: 'stg-a',
      persona: 'health',
      data: { text: 'sample' },
      persona_open: true,
    });
    // `personas` key must NOT appear when single-persona is passed —
    // otherwise the server takes the array branch + fanout logic kicks in.
    expect(sent).not.toHaveProperty('personas');
  });

  it('stagingResolve sends `personas` (array) for GAP-MULTI-01 fan-out', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ id: 'stg-b', status: 'stored', personas: ['health', 'family'] }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingResolve({
      itemId: 'stg-b',
      persona: ['health', 'family'],
      data: { text: 'vaccination' },
      personaAccess: { health: true, family: true },
    });
    expect(r.personas).toEqual(['health', 'family']);
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      id: 'stg-b',
      personas: ['health', 'family'],
      data: { text: 'vaccination' },
      persona_access: { health: true, family: true },
    });
    expect(sent).not.toHaveProperty('persona');
  });

  it('stagingFail translates retry_count → retryCount', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ id: 'stg-c', retry_count: 3 }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingFail('stg-c', 'vault locked');
    expect(r).toEqual({ itemId: 'stg-c', retryCount: 3 });
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ id: 'stg-c', reason: 'vault locked' });
  });

  it('stagingExtendLease translates extended_by → extendedBySeconds', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ id: 'stg-d', extended_by: 600 }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.stagingExtendLease('stg-d', 600);
    expect(r).toEqual({ itemId: 'stg-d', extendedBySeconds: 600 });
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ id: 'stg-d', seconds: 600 });
  });

  // ─── D2D messaging (task 1.29h / 1.32 preamble) ───────────────────────

  it('msgSend sends snake_case wire body + returns ok:true on 2xx', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.msgSend({
      recipientDID: 'did:plc:peer',
      messageType: 'service.query',
      body: { query_id: 'q-1', capability: 'eta_query' },
    });
    expect(r.ok).toBe(true);
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      recipient_did: 'did:plc:peer',
      type: 'service.query',
      body: { query_id: 'q-1', capability: 'eta_query' },
    });
  });

  it('msgSend surfaces 503 (no D2D sender wired) as thrown error', async () => {
    const { client } = makeStubClient(() =>
      ok({ error: 'D2D sender not wired' }, 503),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(
      t.msgSend({ recipientDID: 'did:plc:x', messageType: 'ping', body: {} }),
    ).rejects.toThrow(/msgSend.*503.*D2D sender not wired/);
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

  // ─── Scratchpad (task 1.32 preamble) ──────────────────────────────────

  it('scratchpadCheckpoint POSTs camelCase body + echoes taskId/step', async () => {
    const { client, calls } = makeStubClient(() => ok({ status: 'ok', taskId: 'nudge-1' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.scratchpadCheckpoint('nudge-1', 2, { draft: 'hi Sancho' });
    expect(r).toEqual({ taskId: 'nudge-1', step: 2 });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://core/v1/scratchpad');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ taskId: 'nudge-1', step: 2, context: { draft: 'hi Sancho' } });
  });

  it('scratchpadResume returns entry shape on 200 with row', async () => {
    const entry = {
      taskId: 'r-1',
      step: 3,
      context: { progress: 'mid' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    };
    const { client, calls } = makeStubClient(() => ok(entry));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const got = await t.scratchpadResume('r-1');
    expect(got).toEqual(entry);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url).toBe('http://core/v1/scratchpad/r-1');
  });

  it('scratchpadResume returns null on 200 with JSON null body (missing row)', async () => {
    const { client } = makeStubClient(() => ok(null));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const got = await t.scratchpadResume('never-written');
    expect(got).toBeNull();
  });

  it('scratchpadResume URL-encodes taskId path segment', async () => {
    const { client, calls } = makeStubClient(() => ok(null));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.scratchpadResume('foo/bar baz');
    expect(calls[0]!.url).toBe('http://core/v1/scratchpad/foo%2Fbar%20baz');
  });

  it('scratchpadClear issues DELETE + echoes taskId', async () => {
    const { client, calls } = makeStubClient(() => ok({ status: 'ok' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.scratchpadClear('cleanup-task');
    expect(r).toEqual({ taskId: 'cleanup-task' });
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('http://core/v1/scratchpad/cleanup-task');
  });

  it('scratchpadCheckpoint surfaces 413 (body too large) as thrown error', async () => {
    const { client } = makeStubClient(() =>
      ok({ error: 'body exceeds 262144 bytes' }, 413),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.scratchpadCheckpoint('big', 1, {})).rejects.toThrow(
      /scratchpadCheckpoint.*413.*body exceeds/,
    );
  });

  // ─── Service respond (task 1.32 slice A) ──────────────────────────────

  it('sendServiceRespond POSTs {task_id, response_body} + surfaces {status, taskId, alreadyProcessed}', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ status: 'sent', task_id: 'svc-task-1' }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.sendServiceRespond('svc-task-1', {
      status: 'success',
      result: { eta_minutes: 12 },
    });
    expect(r).toEqual({ status: 'sent', taskId: 'svc-task-1', alreadyProcessed: false });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://core/v1/service/respond');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      task_id: 'svc-task-1',
      response_body: { status: 'success', result: { eta_minutes: 12 } },
    });
  });

  it('sendServiceRespond returns alreadyProcessed:true on Core retry-path response', async () => {
    const { client } = makeStubClient(() =>
      ok({ already_processed: true, status: 'completed' }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.sendServiceRespond('svc-already', { status: 'success' });
    expect(r.alreadyProcessed).toBe(true);
    expect(r.status).toBe('completed');
    // Server didn't echo task_id — transport falls back to the caller's arg.
    expect(r.taskId).toBe('svc-already');
  });

  // ─── Workflow events (task 1.32 slice B) ──────────────────────────────

  it('listWorkflowEvents encodes only explicit filters (no empty query when opts omitted)', async () => {
    const { client, calls } = makeStubClient(() => ok({ events: [], count: 0 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.listWorkflowEvents();
    // No filters → no query string (not even a trailing `?`).
    expect(calls[0]!.url).toBe('http://core/v1/workflow/events');
  });

  it('listWorkflowEvents serialises since + limit + needs_delivery deterministically', async () => {
    const { client, calls } = makeStubClient(() => ok({ events: [], count: 0 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.listWorkflowEvents({ since: 10, limit: 50, needsDeliveryOnly: true });
    // Sorted keys — proves the canonical-signing path gets a
    // deterministic query string.
    expect(calls[0]!.url).toBe('http://core/v1/workflow/events?limit=50&needs_delivery=true&since=10');
  });

  it('listWorkflowEvents needsDeliveryOnly:false omits the flag (route treats absence as "full stream")', async () => {
    const { client, calls } = makeStubClient(() => ok({ events: [], count: 0 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.listWorkflowEvents({ needsDeliveryOnly: false });
    expect(calls[0]!.url).toBe('http://core/v1/workflow/events');
  });

  it('listWorkflowEvents returns [] when server body has no events field', async () => {
    const { client } = makeStubClient(() => ok({}));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    expect(await t.listWorkflowEvents()).toEqual([]);
  });

  it('acknowledgeWorkflowEvent returns true on 200, false on 404 (idempotent retry)', async () => {
    let status = 200;
    const { client, calls } = makeStubClient(() =>
      ok(status === 200 ? { ok: true } : { error: 'event not found' }, status),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    expect(await t.acknowledgeWorkflowEvent(42)).toBe(true);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://core/v1/workflow/events/42/ack');

    status = 404;
    expect(await t.acknowledgeWorkflowEvent(9999)).toBe(false);
  });

  it('failWorkflowEventDelivery sends next_delivery_at + error in body when provided', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true, next_delivery_at: 1 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.failWorkflowEventDelivery(7, {
      nextDeliveryAt: 1_700_000_999_000,
      error: 'thread unavailable',
    });
    expect(calls[0]!.url).toBe('http://core/v1/workflow/events/7/fail');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      next_delivery_at: 1_700_000_999_000,
      error: 'thread unavailable',
    });
  });

  it('failWorkflowEventDelivery sends empty body when opts omitted (server defaults apply)', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true, next_delivery_at: 1 }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.failWorkflowEventDelivery(7);
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({});
  });

  it('failWorkflowEventDelivery returns false on 404 (unknown event)', async () => {
    const { client } = makeStubClient(() => ok({ error: 'event not found' }, 404));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    expect(await t.failWorkflowEventDelivery(9999)).toBe(false);
  });

  // ─── Workflow tasks — reads + create (task 1.32 slice C) ──────────────

  it('listWorkflowTasks encodes kind + state + limit on the wire', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ tasks: [{ id: 'a' }, { id: 'b' }], count: 2 }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const tasks = await t.listWorkflowTasks({
      kind: 'service_query',
      state: 'queued',
      limit: 25,
    });
    expect(tasks.map((x) => (x as { id: string }).id)).toEqual(['a', 'b']);
    expect(calls[0]!.init.method).toBe('GET');
    // Sorted keys → deterministic canonical query for signing.
    expect(calls[0]!.url).toBe(
      'http://core/v1/workflow/tasks?kind=service_query&limit=25&state=queued',
    );
  });

  it('listWorkflowTasks returns [] when server emits no tasks field', async () => {
    const { client } = makeStubClient(() => ok({}));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    expect(await t.listWorkflowTasks({ kind: 'x', state: 'queued' })).toEqual([]);
  });

  it('getWorkflowTask returns task on 200, null on 404', async () => {
    let status = 200;
    let body: unknown = {
      task: {
        id: 'wf-1',
        kind: 'service_query',
        status: 'pending_approval',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        created_at: 1,
        updated_at: 1,
      },
    };
    const { client, calls } = makeStubClient(() => ok(body, status));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const got = await t.getWorkflowTask('wf-1');
    expect(got).not.toBeNull();
    expect(got!.status).toBe('pending_approval');
    expect(calls[0]!.url).toBe('http://core/v1/workflow/tasks/wf-1');

    status = 404;
    body = { error: 'task not found' };
    expect(await t.getWorkflowTask('wf-unknown')).toBeNull();
  });

  it('createWorkflowTask returns {task, deduped:false} on 201 fresh create', async () => {
    const freshTask = {
      id: 'wf-new',
      kind: 'service_query',
      status: 'created',
      priority: 'normal',
      description: 'fresh',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1,
      updated_at: 1,
    };
    const { client, calls } = makeStubClient(() => ok({ task: freshTask }, 201));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const res = await t.createWorkflowTask({
      id: 'wf-new',
      kind: 'service_query',
      description: 'fresh',
      payload: '{}',
      correlationId: 'corr-1',
    });
    expect(res.deduped).toBe(false);
    expect(res.task.id).toBe('wf-new');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      id: 'wf-new',
      kind: 'service_query',
      description: 'fresh',
      payload: '{}',
      correlation_id: 'corr-1',
    });
  });

  it('createWorkflowTask returns deduped:true on 200 idempotency match', async () => {
    const existingTask = {
      id: 'wf-existing',
      kind: 'service_query',
      status: 'queued',
      priority: 'normal',
      description: '',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1,
      updated_at: 1,
    };
    const { client } = makeStubClient(() => ok({ task: existingTask, deduped: true }, 200));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const res = await t.createWorkflowTask({
      id: 'wf-new',
      kind: 'service_query',
      description: 'retry',
      payload: '{}',
      idempotencyKey: 'idem-1',
    });
    expect(res.deduped).toBe(true);
    expect(res.task.id).toBe('wf-existing');
  });

  it('createWorkflowTask throws typed WorkflowConflictError on 409', async () => {
    const { client } = makeStubClient(() =>
      ok({ error: 'duplicate task id: wf-1', code: 'duplicate_id' }, 409),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    let caught: unknown;
    try {
      await t.createWorkflowTask({
        id: 'wf-1',
        kind: 'service_query',
        description: 'dup',
        payload: '{}',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowConflictError);
    expect((caught as { code?: string })?.code).toBe('duplicate_id');
  });

  it('createWorkflowTask narrows unknown 409 code to duplicate_id', async () => {
    const { client } = makeStubClient(() =>
      ok({ error: 'ambiguous', code: 'not_a_real_code' }, 409),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(
      t.createWorkflowTask({
        id: 'wf-1',
        kind: 'service_query',
        description: 'dup',
        payload: '{}',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_id' });
  });

  // ─── Workflow task state transitions (task 1.32 slice D) ──────────────

  it('approveWorkflowTask posts with empty body + returns task', async () => {
    const approved = {
      id: 'wf-1',
      kind: 'approval',
      status: 'queued',
      priority: 'normal',
      description: '',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1,
      updated_at: 2,
    };
    const { client, calls } = makeStubClient(() => ok({ task: approved }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.approveWorkflowTask('wf-1');
    expect(r.status).toBe('queued');
    expect(calls[0]!.url).toBe('http://core/v1/workflow/tasks/wf-1/approve');
    // Empty object body.
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({});
  });

  it('cancelWorkflowTask with reason sends {reason} in body', async () => {
    const cancelled = {
      id: 'wf-2',
      kind: 'service_query',
      status: 'cancelled',
      priority: 'normal',
      description: '',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1,
      updated_at: 2,
    };
    const { client, calls } = makeStubClient(() => ok({ task: cancelled }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.cancelWorkflowTask('wf-2', 'user requested');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ reason: 'user requested' });
  });

  it('completeWorkflowTask serialises result + result_summary snake_case', async () => {
    const completed = {
      id: 'wf-3',
      kind: 'service_query',
      status: 'completed',
      priority: 'normal',
      description: '',
      payload: '{}',
      result: '{"eta":12}',
      result_summary: '12 min',
      policy: '{}',
      created_at: 1,
      updated_at: 2,
    };
    const { client, calls } = makeStubClient(() => ok({ task: completed }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.completeWorkflowTask('wf-3', '{"eta":12}', '12 min', 'did:plc:agent');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({
      result: '{"eta":12}',
      result_summary: '12 min',
      agent_did: 'did:plc:agent',
    });
  });

  it('failWorkflowTask omits agent_did when empty string (default)', async () => {
    const failed = {
      id: 'wf-4',
      kind: 'service_query',
      status: 'failed',
      priority: 'normal',
      description: '',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      error: 'upstream',
      created_at: 1,
      updated_at: 2,
    };
    const { client, calls } = makeStubClient(() => ok({ task: failed }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.failWorkflowTask('wf-4', 'upstream');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ error: 'upstream' });
  });

  it('workflow state transition surfaces 404 (missing task) as thrown error', async () => {
    const { client } = makeStubClient(() => ok({ error: 'task not found' }, 404));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.approveWorkflowTask('missing')).rejects.toThrow(
      /approveWorkflowTask.*404.*task not found/,
    );
  });

  // ─── Memory + contacts (task 1.32 slice E) ────────────────────────────

  it('memoryTouch POSTs snake_case body + parses status/canonical', async () => {
    const { client, calls } = makeStubClient(() =>
      ok({ status: 'ok', canonical: 'dentist' }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.memoryTouch({
      persona: 'personal',
      topic: 'Dentist',
      kind: 'entity',
      sampleItemId: 'item-42',
    });
    expect(r.status).toBe('ok');
    expect(r.canonical).toBe('dentist');
    expect(calls[0]!.url).toBe('http://core/v1/memory/topic/touch');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    // camelCase → snake_case translation on `sample_item_id`.
    expect(sent).toEqual({
      persona: 'personal',
      topic: 'Dentist',
      kind: 'entity',
      sample_item_id: 'item-42',
    });
  });

  it('memoryTouch omits sample_item_id when empty string (server default applies)', async () => {
    const { client, calls } = makeStubClient(() => ok({ status: 'ok' }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.memoryTouch({
      persona: 'personal',
      topic: 't',
      kind: 'entity',
      sampleItemId: '',
    });
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ persona: 'personal', topic: 't', kind: 'entity' });
  });

  it('memoryTouch defaults status to "ok" when server body omits it', async () => {
    const { client } = makeStubClient(() => ok({}));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.memoryTouch({ persona: 'personal', topic: 't', kind: 'entity' });
    expect(r.status).toBe('ok');
    expect(r.canonical).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });

  it('memoryTouch surfaces skipped status + reason from server', async () => {
    const { client } = makeStubClient(() =>
      ok({ status: 'skipped', reason: 'persona locked' }),
    );
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    const r = await t.memoryTouch({ persona: 'financial', topic: 'x', kind: 'theme' });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('persona locked');
  });

  it('updateContact PUTs to /v1/contacts/:did with snake_case preferred_for', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.updateContact('did:plc:drcarl', { preferredFor: ['dental'] });
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.url).toBe('http://core/v1/contacts/did%3Aplc%3Adrcarl');
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ preferred_for: ['dental'] });
  });

  it('updateContact preferredFor=[] sends [] (clear semantics preserved)', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.updateContact('did:plc:drcarl', { preferredFor: [] });
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({ preferred_for: [] });
  });

  it('updateContact preferredFor=undefined omits field entirely (don\'t-touch)', async () => {
    const { client, calls } = makeStubClient(() => ok({ ok: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await t.updateContact('did:plc:drcarl', {});
    const sent = JSON.parse(new TextDecoder().decode(calls[0]!.init.body!));
    expect(sent).toEqual({});
  });

  it('updateContact propagates 404 as thrown error (unknown contact)', async () => {
    const { client } = makeStubClient(() => ok({ error: 'contact not found' }, 404));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(
      t.updateContact('did:plc:unknown', { preferredFor: ['dental'] }),
    ).rejects.toThrow(/updateContact.*404.*contact not found/);
  });

  it('updateContact rejects empty/whitespace DID client-side', async () => {
    const { client } = makeStubClient(() => ok({ ok: true }));
    const stub = makeStubSigner();
    const t = new HttpCoreTransport({
      baseUrl: 'http://core',
      httpClient: client,
      signer: stub.signer,
    });
    await expect(t.updateContact('', { preferredFor: [] })).rejects.toThrow(
      /did is required/,
    );
    await expect(t.updateContact('   ', { preferredFor: [] })).rejects.toThrow(
      /did is required/,
    );
  });
});
