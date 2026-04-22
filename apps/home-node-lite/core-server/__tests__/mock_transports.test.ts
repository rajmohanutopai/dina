/**
 * Task 6.25 — Mock PDS/PLC/AppView transport tests.
 */

import {
  MockAppViewTransport,
  MockPdsTransport,
  MockPlcTransport,
} from '../src/appview/mock_transports';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

describe('MockPdsTransport (task 6.25)', () => {
  it('dispatches to registered handler', async () => {
    const mock = new MockPdsTransport()
      .respond('createSession', { status: 200, body: { did: DID } });
    const result = await mock.fetchFn('createSession', { handle: 'alice' });
    expect(result.status).toBe(200);
    expect((result.body as { did: string }).did).toBe(DID);
  });

  it('records call history', async () => {
    const mock = new MockPdsTransport().respond('createAccount', {
      status: 200,
      body: null,
    });
    await mock.fetchFn('createAccount', { handle: 'x', email: 'y', password: 'z' });
    await mock.fetchFn('createAccount', { handle: 'a' });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.kind).toBe('createAccount');
    expect((mock.calls[0]!.payload as { handle: string }).handle).toBe('x');
  });

  it('records bearer when provided', async () => {
    const mock = new MockPdsTransport().respond('refreshSession', {
      status: 200,
      body: null,
    });
    await mock.fetchFn('refreshSession', {}, 'refresh-token');
    expect(mock.calls[0]!.bearer).toBe('refresh-token');
  });

  it('omits bearer from call when absent', async () => {
    const mock = new MockPdsTransport().respond('createSession', {
      status: 200,
      body: null,
    });
    await mock.fetchFn('createSession', { handle: 'x' });
    expect('bearer' in mock.calls[0]!).toBe(false);
  });

  it('unregistered method → 501 with error', async () => {
    const mock = new MockPdsTransport();
    const result = await mock.fetchFn('createAccount', {});
    expect(result.status).toBe(501);
    expect((result.body as { error: string }).error).toMatch(/no handler/);
  });

  it('defaultHandler catches unregistered methods', async () => {
    const mock = new MockPdsTransport({
      defaultHandler: () => ({ status: 200, body: { ok: true } }),
    });
    const result = await mock.fetchFn('getRecord', {});
    expect(result.status).toBe(200);
  });

  it('handler receives full call + payload + bearer', async () => {
    let receivedCall: { kind: string; payload: unknown; bearer?: string } | null = null;
    const mock = new MockPdsTransport().handle('getRecord', (call) => {
      receivedCall = call;
      return { status: 200, body: null };
    });
    await mock.fetchFn('getRecord', { repo: DID, collection: 'c', rkey: 'r' }, 'b');
    expect(receivedCall!.kind).toBe('getRecord');
    expect((receivedCall!.payload as { repo: string }).repo).toBe(DID);
    expect(receivedCall!.bearer).toBe('b');
  });

  it('handler can return async response', async () => {
    const mock = new MockPdsTransport().handle('createSession', async () => {
      await new Promise((r) => setImmediate(r));
      return { status: 200, body: { async: true } };
    });
    const result = await mock.fetchFn('createSession', {});
    expect((result.body as { async: boolean }).async).toBe(true);
  });

  it('reset clears call history but keeps handlers', async () => {
    const mock = new MockPdsTransport().respond('createAccount', {
      status: 200,
      body: null,
    });
    await mock.fetchFn('createAccount', {});
    expect(mock.calls).toHaveLength(1);
    mock.reset();
    expect(mock.calls).toHaveLength(0);
    // Handler still works.
    const r = await mock.fetchFn('createAccount', {});
    expect(r.status).toBe(200);
  });

  it('chained setup via handle().respond()', async () => {
    const mock = new MockPdsTransport()
      .respond('createAccount', { status: 200, body: { did: DID } })
      .respond('createSession', { status: 200, body: { did: DID } })
      .respond('refreshSession', { status: 200, body: { did: DID } })
      .respond('deleteSession', { status: 200, body: null });
    const a = await mock.fetchFn('createAccount', {});
    const b = await mock.fetchFn('deleteSession', {}, 'x');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  it('accepts handler overrides via constructor', async () => {
    const mock = new MockPdsTransport({
      handlers: {
        createSession: () => ({ status: 401, body: { error: 'nope' } }),
      },
    });
    const r = await mock.fetchFn('createSession', {});
    expect(r.status).toBe(401);
  });
});

describe('MockPlcTransport (task 6.25)', () => {
  const doc = {
    id: DID,
    alsoKnownAs: ['at://alice'],
    verificationMethod: [],
    service: [],
  };

  it('resolves a known DID via fetchFn', async () => {
    const mock = new MockPlcTransport({ docs: { [DID]: doc } });
    const result = await mock.fetchFn(DID);
    expect(result.body).toEqual(doc);
    expect(result.cacheControl).toBeNull();
  });

  it('unknown DID → {body: null, cacheControl: null}', async () => {
    const mock = new MockPlcTransport();
    const result = await mock.fetchFn(DID);
    expect(result.body).toBeNull();
  });

  it('default cache-control threaded through', async () => {
    const mock = new MockPlcTransport({
      docs: { [DID]: doc },
      cacheControl: 'max-age=3600',
    });
    const result = await mock.fetchFn(DID);
    expect(result.cacheControl).toBe('max-age=3600');
  });

  it('setDoc / removeDoc chain', async () => {
    const mock = new MockPlcTransport();
    mock.setDoc(DID, doc);
    expect((await mock.fetchFn(DID)).body).toEqual(doc);
    mock.removeDoc(DID);
    expect((await mock.fetchFn(DID)).body).toBeNull();
  });

  it('plainFetchFn returns raw body or null', async () => {
    const mock = new MockPlcTransport({ docs: { [DID]: doc } });
    expect(await mock.plainFetchFn(DID)).toEqual(doc);
    expect(await mock.plainFetchFn('did:plc:zyxwvutsrqponmlkjihgfedc')).toBeNull();
  });

  it('records call history', async () => {
    const mock = new MockPlcTransport({ docs: { [DID]: doc } });
    await mock.fetchFn(DID);
    await mock.fetchFn(DID);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.did).toBe(DID);
  });

  it('reset clears call history', async () => {
    const mock = new MockPlcTransport({ docs: { [DID]: doc } });
    await mock.fetchFn(DID);
    mock.reset();
    expect(mock.calls).toEqual([]);
  });
});

describe('MockAppViewTransport (task 6.25)', () => {
  it('dispatches per-method', async () => {
    const mock = new MockAppViewTransport()
      .respond('trust.resolve', { status: 200, body: { did: DID } });
    const fetcher = mock.fetcher('trust.resolve');
    const r = await fetcher({ did: DID });
    expect(r.status).toBe(200);
  });

  it('records the method + input', async () => {
    const mock = new MockAppViewTransport().respond('service.search', {
      status: 200,
      body: { services: [] },
    });
    await mock.fetcher('service.search')({ capability: 'eta_query' });
    expect(mock.calls[0]!.method).toBe('service.search');
    expect(mock.calls[0]!.input).toEqual({ capability: 'eta_query' });
  });

  it('unregistered method → 501', async () => {
    const mock = new MockAppViewTransport();
    const r = await mock.fetcher('contact.resolve')({ query: 'alice' });
    expect(r.status).toBe(501);
  });

  it('defaultHandler catches all', async () => {
    const mock = new MockAppViewTransport({
      defaultHandler: () => ({ status: 200, body: { everything: 'ok' } }),
    });
    const r = await mock.fetcher('review.list')({ subject: DID });
    expect(r.status).toBe(200);
    expect((r.body as { everything: string }).everything).toBe('ok');
  });

  it('handler receives method + input', async () => {
    let received: { method: string; input: unknown } | null = null;
    const mock = new MockAppViewTransport().handle('trust.resolve', (call) => {
      received = call;
      return { status: 200, body: null };
    });
    await mock.fetcher('trust.resolve')({ did: DID, context: 'read' });
    expect(received!.method).toBe('trust.resolve');
    expect(received!.input).toEqual({ did: DID, context: 'read' });
  });

  it('separate fetchers share the same mock state', async () => {
    const mock = new MockAppViewTransport()
      .respond('trust.resolve', { status: 200, body: null })
      .respond('service.search', { status: 200, body: null });
    await mock.fetcher('trust.resolve')({});
    await mock.fetcher('service.search')({});
    await mock.fetcher('trust.resolve')({});
    const methods = mock.calls.map((c) => c.method);
    expect(methods).toEqual(['trust.resolve', 'service.search', 'trust.resolve']);
  });

  it('reset clears history only', async () => {
    const mock = new MockAppViewTransport().respond('trust.resolve', {
      status: 200,
      body: null,
    });
    await mock.fetcher('trust.resolve')({});
    mock.reset();
    expect(mock.calls).toEqual([]);
    // Handler still works.
    await mock.fetcher('trust.resolve')({});
    expect(mock.calls).toHaveLength(1);
  });
});

describe('integration: mock transports drive real clients', () => {
  it('MockPdsTransport wires cleanly into SessionManager', async () => {
    const { SessionManager } = await import('../src/appview/session_manager');
    const { SessionTokenStore, InMemoryKeystoreAdapter } = await import(
      '../src/appview/session_token_store'
    );
    const mock = new MockPdsTransport().respond('createSession', {
      status: 200,
      body: {
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'r',
        accessExpiresAtMs: 2_000_000,
        refreshExpiresAtMs: 10_000_000,
      },
    });
    const mgr = new SessionManager({
      pdsClient: mock.fetchFn,
      tokenStore: new SessionTokenStore({ keystore: new InMemoryKeystoreAdapter() }),
    });
    const out = await mgr.createSession({
      identifier: 'alice',
      password: 'hunter2',
    });
    expect(out.ok).toBe(true);
    expect(mock.calls[0]!.kind).toBe('createSession');
  });

  it('MockAppViewTransport wires cleanly into trust.resolve client', async () => {
    const { createTrustResolveClient } = await import(
      '../src/appview/trust_resolve_client'
    );
    const mock = new MockAppViewTransport().respond('trust.resolve', {
      status: 200,
      body: {
        did: DID,
        scores: {
          weightedScore: 0.9,
          confidence: 0.8,
          totalAttestations: 5,
          positive: 4,
          negative: 1,
          verifiedAttestationCount: 2,
        },
        flags: [],
      },
    });
    // The real client wraps the fetch + parses. Our mock.fetcher
    // matches that shape.
    const fetchFn = mock.fetcher('trust.resolve');
    const resolve = createTrustResolveClient({ fetchFn });
    const out = await resolve({ did: DID });
    expect(out.ok).toBe(true);
    expect(mock.calls[0]!.method).toBe('trust.resolve');
  });
});
