/**
 * Task 3.39 — end-to-end integration with real in-process HTTP + WS servers.
 *
 * The per-unit test files (`net-node.test.ts`, `retry.test.ts`,
 * `websocket.test.ts`) cover the adapter's internal wiring via injected
 * fakes — that's the right shape for unit testing. This file closes
 * the last coverage gap by running against **real** Node `http` and
 * `ws` servers, so wire-level details that fakes can't catch are
 * exercised:
 *
 *   - The signer's canonical string actually arrives on the wire in
 *     the `X-Signature` + `X-Timestamp` + `X-Nonce` + `X-DID` headers.
 *   - The HTTP body is delivered byte-for-byte to the server (not
 *     accidentally JSON-stringified by `fetch`).
 *   - Response body is returned as plain `Uint8Array`, length matches
 *     the server's Content-Length.
 *   - WebSocket connection succeeds against a real `ws.WebSocketServer`
 *     with `perMessageDeflate: false` — catches the RSV1 compression
 *     regression that CLAUDE.md calls out.
 *   - Bidirectional text frames round-trip correctly.
 *
 * Uses ephemeral ports (`:0`) to avoid collisions in CI.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  NodeHttpClient,
  createCanonicalRequestSigner,
  createNodeWebSocket,
  type WebSocketClient,
} from '../src';

// ---------------------------------------------------------------------------
// HTTP integration
// ---------------------------------------------------------------------------

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function collectBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Uint8Array.from(Buffer.concat(chunks));
}

describe('net-node — HTTP integration with real server', () => {
  let server: Server;
  let url: string;
  let received: { method?: string; path?: string; headers?: Record<string, string>; body?: Uint8Array } = {};

  beforeEach(async () => {
    received = {};
    const result = await startHttpServer(async (req, res) => {
      received.method = req.method;
      received.path = req.url;
      received.headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v ?? '')]),
      );
      received.body = await collectBody(req);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Echo-Path', req.url ?? '');
      res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    });
    server = result.server;
    url = result.url;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('POST with body + headers lands on the server byte-identical', async () => {
    const client = new NodeHttpClient({ timeoutMs: 5000 });
    const body = new TextEncoder().encode('{"ping":true}');
    const res = await client.request(`${url}/echo?x=1`, {
      method: 'POST',
      headers: { 'X-Trace-Id': 'abc123', 'Content-Type': 'application/json' },
      body,
    });

    expect(res.status).toBe(200);
    expect(received.method).toBe('POST');
    expect(received.path).toBe('/echo?x=1');
    expect(received.headers?.['x-trace-id']).toBe('abc123');
    expect(received.headers?.['content-type']).toBe('application/json');
    expect(received.body).toEqual(body);
    // Response body as plain Uint8Array.
    expect(res.body.constructor.name).toBe('Uint8Array');
    expect(Array.from(res.body)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    // Response headers are lowercased per port contract.
    expect(res.headers['x-echo-path']).toBe('/echo?x=1');
  });

  it('signed request: X-DID / X-Timestamp / X-Nonce / X-Signature headers arrive on the wire', async () => {
    const client = new NodeHttpClient();
    const signPriv = new Uint8Array(32).fill(7);
    // Stub signer produces a deterministic 64-byte fingerprint over the
    // canonical string. The goal here isn't Ed25519 correctness (that's
    // covered in net-node.test.ts) — it's to prove the signer's header
    // output makes it onto the real wire untouched.
    const signer = createCanonicalRequestSigner({
      did: 'did:plc:test',
      privateKey: signPriv,
      sign: (_priv, msg) => {
        const out = new Uint8Array(64);
        for (let i = 0; i < msg.length; i++) out[i % 64] ^= msg[i] ?? 0;
        return out;
      },
      nonce: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      now: () => 1700000000000,
    });

    const body = new TextEncoder().encode('hello');
    const signed = await signer({
      method: 'POST',
      path: '/ingest',
      query: '',
      body,
    });

    await client.request(`${url}/ingest`, {
      method: 'POST',
      headers: {
        'X-DID': signed.did,
        'X-Timestamp': signed.timestamp,
        'X-Nonce': signed.nonce,
        'X-Signature': signed.signature,
      },
      body,
    });

    expect(received.headers?.['x-did']).toBe('did:plc:test');
    // Timestamp is RFC3339 (per Dina's canonical-signing contract) not raw ms.
    expect(received.headers?.['x-timestamp']).toBe('2023-11-14T22:13:20.000Z');
    expect(received.headers?.['x-nonce']).toBe('0102030405060708090a0b0c0d0e0f10');
    expect(received.headers?.['x-signature']).toMatch(/^[0-9a-f]{128}$/);
  });
});

// ---------------------------------------------------------------------------
// WebSocket integration
// ---------------------------------------------------------------------------

describe('net-node — WebSocket integration with real ws.WebSocketServer', () => {
  let wss: WebSocketServer;
  let url: string;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      // Explicit perMessageDeflate: false on the server too, so we're
      // testing that the client's default matches.
      wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
      wss.on('listening', resolve);
    });
    const addr = wss.address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      wss.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('connects, exchanges a text frame, and closes cleanly', async () => {
    // Server echoes whatever it receives, prefixed with "echo:".
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        socket.send(`echo:${data.toString()}`);
      });
    });

    const client = (await createNodeWebSocket(url)) as WebSocketClient;
    expect(client).not.toBeNull();

    const received: string[] = [];
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      client.onclose = ({ code, reason }) => resolve({ code, reason });
    });

    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = (err) => reject(err);
    });
    expect(client.readyState).toBe(1); // OPEN

    const messagePromise = new Promise<string>((resolve) => {
      client.onmessage = ({ data }) => {
        received.push(data);
        resolve(data);
      };
    });

    client.send('ping');
    await expect(messagePromise).resolves.toBe('echo:ping');

    client.close();
    const { code } = await closePromise;
    // Node `ws` sends 1005 (no status) when close() is called without a code.
    expect([1000, 1005]).toContain(code);
  });

  it("client Upgrade request does NOT advertise permessage-deflate (CLAUDE.md RSV1 parity)", async () => {
    // The client's handshake must not include
    // `Sec-WebSocket-Extensions: permessage-deflate`, or Go's
    // `coder/websocket` server will close with 1002 protocol error
    // when a compressed frame (RSV1=1) arrives. We intercept the
    // `ws` server's `headers` event to inspect the client's Upgrade
    // request — if the client ever regresses to default compression,
    // this assertion fires.
    let clientRequestedDeflate = false;
    wss.on('headers', (_headers, req) => {
      const ext = req.headers['sec-websocket-extensions'];
      if (ext && String(ext).includes('permessage-deflate')) {
        clientRequestedDeflate = true;
      }
    });
    wss.on('connection', (socket) => socket.close());

    const client = (await createNodeWebSocket(url)) as WebSocketClient;
    await new Promise<void>((resolve) => {
      client.onclose = () => resolve();
      client.onerror = () => resolve();
    });

    expect(clientRequestedDeflate).toBe(false);
  });
});
