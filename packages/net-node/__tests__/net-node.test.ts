/**
 * `@dina/net-node` smoke — HTTP client + signed-request builder.
 *
 * HTTP client tests use a mock `fetch` via `fetchFn` injection
 * (no real network). Signed-request-builder tests use a deterministic
 * signer + pinned clock/nonce so the emitted headers are reproducible.
 */

import {
  NodeHttpClient,
  createCanonicalRequestSigner,
  type HttpRequestInit,
  type HttpResponse,
} from '../src';

// ---------------------------------------------------------------------------
// NodeHttpClient tests
// ---------------------------------------------------------------------------

/** Build a mock `fetch` that resolves with the given status/headers/body. */
function mockFetch(responder: (url: string, init?: RequestInit) => {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const res = responder(url, init);
    // Cast through BodyInit — Uint8Array is an accepted Response body at
    // runtime (undici / browser both handle it) but TS's DOM lib types
    // Uint8Array<ArrayBufferLike> vs Uint8Array<ArrayBuffer> narrowly.
    return new Response(res.body as unknown as BodyInit, {
      status: res.status,
      headers: res.headers,
    });
  };
}

describe('NodeHttpClient (task 3.35)', () => {
  it('round-trips status + headers + body via injected fetch', async () => {
    const client = new NodeHttpClient({
      fetchFn: mockFetch(() => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"ok":true}'),
      })),
    });
    const res = await client.request('http://core:8100/healthz', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
  });

  it('passes body bytes through unchanged', async () => {
    let capturedBody: unknown = null;
    const client = new NodeHttpClient({
      fetchFn: mockFetch((_url, init) => {
        capturedBody = init?.body;
        return {
          status: 201,
          headers: {},
          body: new Uint8Array(),
        };
      }),
    });
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await client.request('http://core/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    expect(capturedBody).toBe(body);
  });

  it('normalises response headers to lowercase', async () => {
    const client = new NodeHttpClient({
      fetchFn: mockFetch(() => ({
        status: 200,
        // Response auto-lowercases in the Headers constructor, but
        // we explicitly use mixed case here to confirm our wrapper
        // doesn't accidentally preserve.
        headers: { 'X-Custom-Header': 'value', 'Content-Type': 'text/plain' },
        body: new Uint8Array(),
      })),
    });
    const res = await client.request('http://core/test', {
      method: 'GET',
      headers: {},
    });
    expect(res.headers['x-custom-header']).toBe('value');
    expect(res.headers['content-type']).toBe('text/plain');
    // No mixed-case keys leaked through.
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it('returns body as a plain Uint8Array (not Buffer subclass)', async () => {
    const client = new NodeHttpClient({
      fetchFn: mockFetch(() => ({
        status: 200,
        headers: {},
        body: new Uint8Array([42]),
      })),
    });
    const res = await client.request('http://core', { method: 'GET', headers: {} });
    // Adapter contract advertises Uint8Array, not Buffer.
    expect(res.body.constructor.name).toBe('Uint8Array');
  });

  it('aborts when timeoutMs elapses', async () => {
    // Mock fetch that never resolves — timeout must reject.
    const neverFetch: typeof globalThis.fetch = async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const client = new NodeHttpClient({ fetchFn: neverFetch, timeoutMs: 30 });
    await expect(
      client.request('http://core/slow', { method: 'GET', headers: {} }),
    ).rejects.toThrow();
  });

  it('throws at construction when no fetch is available', () => {
    // Stand-in for a runtime without fetch — inject undefined via cast.
    expect(
      () => new NodeHttpClient({ fetchFn: undefined as unknown as typeof globalThis.fetch }),
    ).toThrow(/global fetch is not available/);
  });
});

// ---------------------------------------------------------------------------
// createCanonicalRequestSigner tests
// ---------------------------------------------------------------------------

describe('createCanonicalRequestSigner (task 3.35)', () => {
  // Deterministic fixtures so the emitted headers are reproducible.
  const PRIVATE_KEY = new Uint8Array(32).fill(0xaa);
  const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const FIXED_NONCE_BYTES = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  ]);

  /** Stub signer: deterministic 64-byte fingerprint of the ENTIRE
   *  message + key. Folds every byte of the message into the 64-byte
   *  output via rolling XOR-plus-add — catches changes anywhere in
   *  the canonical string (including the body-hash hex past byte 64).
   *  Not crypto — just a witness that the signer saw the full input. */
  const stubSign = async (privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> => {
    const out = new Uint8Array(64);
    const keyByte = privateKey[0] ?? 0;
    for (let j = 0; j < message.length; j++) {
      const i = j % 64;
      out[i] = ((out[i] ?? 0) + ((message[j] ?? 0) ^ keyByte)) & 0xff;
    }
    return out;
  };

  it('produces the 4 signing headers with correct DID + timestamp + nonce', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:testkey',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const headers = await signer({
      method: 'POST',
      path: '/v1/vault/store',
      query: '',
      body: new Uint8Array([1, 2, 3]),
    });

    expect(headers.did).toBe('did:plc:testkey');
    expect(headers.timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(headers.nonce).toBe('0102030405060708090a0b0c0d0e0f10');
    // 64-byte stub signature → 128 hex chars.
    expect(headers.signature).toHaveLength(128);
  });

  it('signature is deterministic given fixed inputs', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const req = { method: 'GET', path: '/v1/healthz', query: '', body: new Uint8Array() };
    const a = await signer(req);
    const b = await signer(req);
    expect(a.signature).toBe(b.signature);
    expect(a.timestamp).toBe(b.timestamp);
    expect(a.nonce).toBe(b.nonce);
  });

  it('different paths produce different signatures (canonical inputs include path)', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const a = await signer({ method: 'GET', path: '/v1/a', query: '', body: new Uint8Array() });
    const b = await signer({ method: 'GET', path: '/v1/b', query: '', body: new Uint8Array() });
    expect(a.signature).not.toBe(b.signature);
  });

  it('different bodies produce different signatures (body hash is in canonical)', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const a = await signer({
      method: 'POST',
      path: '/v1/store',
      query: '',
      body: new TextEncoder().encode('v1'),
    });
    const b = await signer({
      method: 'POST',
      path: '/v1/store',
      query: '',
      body: new TextEncoder().encode('v2'),
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it('different queries produce different signatures', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const a = await signer({
      method: 'GET',
      path: '/v1/list',
      query: 'limit=10',
      body: new Uint8Array(),
    });
    const b = await signer({
      method: 'GET',
      path: '/v1/list',
      query: 'limit=20',
      body: new Uint8Array(),
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it('timestamp advances with the clock', async () => {
    let t = FIXED_NOW;
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => t,
    });
    const req = { method: 'GET', path: '/v1/now', query: '', body: new Uint8Array() };
    const a = await signer(req);
    t += 60_000;
    const b = await signer(req);
    expect(a.timestamp).not.toBe(b.timestamp);
    expect(b.timestamp > a.timestamp).toBe(true);
  });

  it('default nonce source produces 32 hex chars (16 random bytes)', async () => {
    // No `nonce` override — exercises the defaultNonce path that
    // dynamic-imports `node:crypto.randomBytes`.
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      now: () => FIXED_NOW,
    });
    const headers = await signer({
      method: 'GET',
      path: '/v1/x',
      query: '',
      body: new Uint8Array(),
    });
    expect(headers.nonce).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(headers.nonce)).toBe(true);
  });

  it('default now advances with real wall-clock time', async () => {
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: stubSign,
      nonce: () => FIXED_NONCE_BYTES,
      // `now` not overridden → defaults to Date.now
    });
    const req = { method: 'GET', path: '/v1/x', query: '', body: new Uint8Array() };
    const before = Date.now();
    const headers = await signer(req);
    const after = Date.now();
    const ts = new Date(headers.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('accepts sync signers (not just async)', async () => {
    // Shape of `sign` is `Promise<Uint8Array> | Uint8Array` — a sync
    // signer must work too. Matches RFC 8032 Ed25519 deterministic sync.
    const syncSign = (privateKey: Uint8Array, message: Uint8Array): Uint8Array => {
      const out = new Uint8Array(64);
      out[0] = (privateKey[0] ?? 0) ^ (message[0] ?? 0);
      return out;
    };
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:a',
      privateKey: PRIVATE_KEY,
      sign: syncSign,
      nonce: () => FIXED_NONCE_BYTES,
      now: () => FIXED_NOW,
    });
    const headers = await signer({
      method: 'GET',
      path: '/v1/sync',
      query: '',
      body: new Uint8Array([1]),
    });
    expect(headers.signature).toHaveLength(128);
  });
});

// ---------------------------------------------------------------------------
// Integration: NodeHttpClient + signed-request → fake Core round-trip
// ---------------------------------------------------------------------------

describe('NodeHttpClient × signed-request integration', () => {
  it('the 4 signing headers land on the outgoing request', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const client = new NodeHttpClient({
      fetchFn: async (input, init) => {
        captured = {
          url: typeof input === 'string' ? input : input.toString(),
          init,
        };
        // Use 200 rather than 204 — Response constructor rejects
        // non-null bodies on 204 / 205 / 304. Our wrapper never
        // cares about the precise status here, only the headers.
        return new Response(new Uint8Array(), { status: 200 });
      },
    });

    const signer = createCanonicalRequestSigner({
      did: 'did:plc:test',
      privateKey: new Uint8Array(32).fill(1),
      sign: async () => new Uint8Array(64),
      nonce: () => new Uint8Array(16),
      now: () => 0,
    });
    const auth = await signer({
      method: 'GET',
      path: '/healthz',
      query: '',
      body: new Uint8Array(),
    });

    const init: HttpRequestInit = {
      method: 'GET',
      headers: {
        'x-did': auth.did,
        'x-timestamp': auth.timestamp,
        'x-nonce': auth.nonce,
        'x-signature': auth.signature,
      },
    };
    const res: HttpResponse = await client.request('http://core:8100/healthz', init);
    expect(res.status).toBe(200);

    // Verify the signer's headers made it into the fetch call unchanged.
    const outgoing = (captured!.init?.headers ?? {}) as Record<string, string>;
    expect(outgoing['x-did']).toBe('did:plc:test');
    expect(outgoing['x-nonce']).toHaveLength(32);
    expect(outgoing['x-signature']).toHaveLength(128);
  });
});
