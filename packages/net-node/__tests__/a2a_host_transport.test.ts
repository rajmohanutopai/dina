/**
 * The A2A host transport (design §6.6): a forbidden destination receives no
 * connection at all — by name, by literal, by a mixed answer, and by a DNS
 * answer that changes between lookups — and every other rule of the policy
 * holds on a real TLS socket.
 */

import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { A2A_FETCH_LIMITS, type A2AHttpRequest } from '@dina/core';

import { createA2AHostTransport } from '../src/a2a_host_transport';

import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

const FIXTURES = path.join(__dirname, 'fixtures', 'a2a_tls');
const CERT = readFileSync(path.join(FIXTURES, 'localhost.cert.pem'), 'utf8');
const KEY = readFileSync(path.join(FIXTURES, 'localhost.key.pem'), 'utf8');

type Handler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  body: string,
) => void;

interface TestServer {
  port: number;
  connections: number;
  seen: {
    host?: string;
    servername?: string;
    method?: string;
    body?: string;
    headers?: Record<string, unknown>;
  }[];
  handler: Handler;
  close(): Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const state: TestServer = {
    port: 0,
    connections: 0,
    seen: [],
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    close: async () => undefined,
  };
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.seen.push({
        host: req.headers.host,
        servername: (req.socket as TLSSocket).servername || undefined,
        method: req.method,
        body,
        headers: req.headers,
      });
      state.handler(req, res, body);
    });
  });
  server.on('connection', () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

const loopbackAllowed = (a: string): boolean => a === '127.0.0.1';
const resolveTo =
  (...answers: string[]) =>
  async (): Promise<string[]> =>
    answers;

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.close();
});

const call = (over: Partial<A2AHttpRequest> = {}): A2AHttpRequest => ({
  method: 'POST',
  url: `https://agent.test:${server.port}/rpc`,
  headers: { 'A2A-Version': '1.0' },
  body: '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"t"}}',
  ...A2A_FETCH_LIMITS.rpc,
  ...over,
});

describe('a forbidden destination receives no connection', () => {
  it('by name: a name that resolves to loopback is refused before connecting', async () => {
    const transport = createA2AHostTransport({ resolve: resolveTo('127.0.0.1'), ca: CERT });
    expect(await transport(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(server.connections).toBe(0);
  });

  it('by literal: a literal address never reaches resolution', async () => {
    let resolved = 0;
    const transport = createA2AHostTransport({
      resolve: async () => {
        resolved += 1;
        return ['127.0.0.1'];
      },
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
    for (const url of [
      `https://127.0.0.1:${server.port}/rpc`,
      `https://[::1]:${server.port}/rpc`,
      `https://0x7f.0.0.1:${server.port}/rpc`,
      `https://2130706433:${server.port}/rpc`,
    ]) {
      expect(await transport(call({ url }))).toEqual({
        ok: false,
        error: 'url_refused',
        sent: false,
      });
    }
    expect(resolved).toBe(0);
    expect(server.connections).toBe(0);
  });

  it('by a mixed answer: one private address among public ones refuses the name', async () => {
    const transport = createA2AHostTransport({
      resolve: resolveTo('203.0.113.7', '127.0.0.1'),
      ca: CERT,
    });
    expect(await transport(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(server.connections).toBe(0);
  });

  it('by a changing DNS answer: the name is resolved once and the socket pinned to that answer', async () => {
    // The vetted first answer is the test server; a second lookup would say a
    // forbidden address. The socket must use the first and never ask again.
    const answers = [['127.0.0.1'], ['10.0.0.1']];
    let lookups = 0;
    const transport = createA2AHostTransport({
      resolve: async () => answers[Math.min(lookups++, 1)] as string[],
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
    const out = await transport(call());
    expect(out).toMatchObject({ ok: true, connectedAddress: '127.0.0.1' });
    expect(lookups).toBe(1);
    expect(server.connections).toBe(1);
  });

  it('tries the next vetted address when one cannot be reached, and only before anything was sent', async () => {
    // Nothing listens on the IPv6 loopback at this port: that address refuses
    // (or, with IPv6 off, cannot be reached); the IPv4 answer then serves.
    const transport = createA2AHostTransport({
      resolve: resolveTo('::1', '127.0.0.1'),
      isAllowedAddress: (a) => a === '::1' || a === '127.0.0.1',
      ca: CERT,
    });
    expect(await transport(call())).toMatchObject({ ok: true, connectedAddress: '127.0.0.1' });
    expect(server.connections).toBe(1);
  });

  it('an address the host cannot route to settles as a failure; the process never sees an uncaught error', async () => {
    // RFC 6666's discard prefix: where the host has no IPv6 route the connect
    // fails at once (the case that used to throw past the request and crash
    // the process); where it has one, nothing answers and the deadline ends it.
    const uncaught: unknown[] = [];
    const trap = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', trap);
    try {
      const transport = createA2AHostTransport({ resolve: resolveTo('100::1'), isAllowedAddress: () => true, ca: CERT });
      const out = await transport(call({ timeoutMs: 1_500 }));
      expect(out).toEqual({ ok: false, error: expect.stringMatching(/^(connect_failed|timeout)$/), sent: false });
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', trap);
    }
  });

  it.each([
    ['http', `http://agent.test/rpc`],
    ['credentials', `https://user:pw@agent.test/rpc`],
    ['a fragment', `https://agent.test/rpc#x`],
  ])('refuses a URL with %s before resolving', async (_name, url) => {
    const transport = createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
    expect(await transport(call({ url }))).toEqual({
      ok: false,
      error: 'url_refused',
      sent: false,
    });
    expect(server.connections).toBe(0);
  });
});

describe('an allowed destination', () => {
  const transport = () =>
    createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });

  it('POSTs JSON to the vetted address with the original name as SNI and Host', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    };
    const out = await transport()(call());
    expect(out).toEqual({
      ok: true,
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{}}',
      connectedAddress: '127.0.0.1',
    });
    expect(server.seen).toHaveLength(1);
    const seen = server.seen[0];
    expect(seen?.servername).toBe('agent.test');
    expect(seen?.host).toBe(`agent.test:${server.port}`);
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe(call().body);
    expect(seen?.headers?.['content-type']).toBe('application/json');
    expect(seen?.headers?.['a2a-version']).toBe('1.0');
    expect(seen?.headers?.['accept-encoding']).toBe('identity');
  });

  it('GETs a card with no body', async () => {
    const out = await transport()(
      call({
        method: 'GET',
        url: `https://agent.test:${server.port}/.well-known/agent-card.json`,
        body: undefined,
      }),
    );
    expect(out.ok).toBe(true);
    expect(server.seen[0]?.method).toBe('GET');
    expect(server.seen[0]?.headers?.['content-type']).toBeUndefined();
  });

  it('returns a non-2xx JSON answer as it is (JSON-RPC errors may ride one)', async () => {
    server.handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":1}');
    };
    expect(await transport()(call())).toMatchObject({ ok: true, status: 400, body: '{"error":1}' });
  });

  it('never follows a redirect', async () => {
    server.handler = (_req, res) => {
      res.writeHead(302, {
        location: 'https://169.254.169.254/latest/meta-data',
        'content-type': 'application/json',
      });
      res.end('{}');
    };
    expect(await transport()(call())).toEqual({ ok: false, error: 'redirect_refused', sent: true });
    expect(server.seen).toHaveLength(1);
  });

  it.each([
    ['HTML', { 'content-type': 'text/html' }, '<html></html>'],
    ['no content type', {}, '{}'],
  ])('refuses a %s answer', async (_name, headers, body) => {
    server.handler = (_req, res) => {
      res.writeHead(200, headers);
      res.end(body);
    };
    expect(await transport()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
  });

  it('refuses a compressed answer it did not ask for', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{"a":1}'));
    };
    expect(await transport()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
  });

  it('stops reading at the byte cap', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`"${'x'.repeat(4096)}"`);
    };
    expect(await transport()(call({ maxResponseBytes: 1024 }))).toEqual({
      ok: false,
      error: 'too_large',
      sent: true,
    });
  });

  it('refuses a body that is not UTF-8', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.from([0x22, 0xff, 0xfe, 0x22]));
    };
    expect(await transport()(call())).toEqual({ ok: false, error: 'bad_encoding', sent: true });
  });

  it('times out a silent server, and says the request may have been sent', async () => {
    server.handler = () => undefined; // accepts, never answers
    expect(await transport()(call({ timeoutMs: 300 }))).toEqual({
      ok: false,
      error: 'timeout',
      sent: true,
    });
  });
});

describe('TLS and connection failures report that nothing was sent', () => {
  it('refuses a certificate that does not name the host', async () => {
    const transport = createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
    const out = await transport(call({ url: `https://unlisted.test:${server.port}/rpc` }));
    expect(out).toEqual({ ok: false, error: 'tls_failed', sent: false });
    expect(server.seen).toHaveLength(0);
  });

  it('refuses a certificate no trusted CA issued', async () => {
    const transport = createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
    });
    expect(await transport(call())).toEqual({ ok: false, error: 'tls_failed', sent: false });
    expect(server.seen).toHaveLength(0);
  });

  it('reports a refused connection', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const transport = createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
    expect(await transport(call({ url: `https://agent.test:${port}/rpc` }))).toEqual({
      ok: false,
      error: 'connect_failed',
      sent: false,
    });
  });

  it('a header Node refuses (CR/LF in a value, as a remote token could carry) settles as a failure; nothing is sent', async () => {
    const transport = createA2AHostTransport({ resolve: resolveTo('127.0.0.1'), isAllowedAddress: loopbackAllowed, ca: CERT });
    const answer = await transport(call({ headers: { 'A2A-Version': '1.0', authorization: 'Bearer a\r\nX-Injected: 1' } }));
    expect(answer).toEqual({ ok: false, error: 'io_error', sent: false });
    expect(server.seen).toHaveLength(0);
  });

  it('reports a name that does not resolve', async () => {
    const transport = createA2AHostTransport({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
      ca: CERT,
    });
    expect(await transport(call())).toEqual({ ok: false, error: 'dns_failed', sent: false });
    const empty = createA2AHostTransport({ resolve: resolveTo(), ca: CERT });
    expect(await empty(call())).toEqual({ ok: false, error: 'dns_failed', sent: false });
  });
});

describe('a webhook push (status only)', () => {
  const allowed = () =>
    createA2AHostTransport({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
      ca: CERT,
    });
  const push = (over: Partial<A2AHttpRequest> = {}): A2AHttpRequest =>
    call({
      url: `https://agent.test:${server.port}/hook`,
      headers: { authorization: 'Bearer hook-secret' },
      body: '{"statusUpdate":{}}',
      contentType: 'application/a2a+json',
      response: 'status',
      ...A2A_FETCH_LIMITS.webhook,
      ...over,
    });

  it('POSTs the A2A media type and returns the status, never the body', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>whatever the receiver says</html>');
    };
    const result = await allowed()(push());
    expect(result).toEqual({ ok: true, status: 200, body: '', connectedAddress: '127.0.0.1' });
    expect(server.seen[0]?.headers?.['content-type']).toBe('application/a2a+json');
    expect(server.seen[0]?.headers?.authorization).toBe('Bearer hook-secret');
    expect(server.seen[0]?.body).toBe('{"statusUpdate":{}}');
  });

  it('a compressed or oversized answer does not matter: the body is not read', async () => {
    server.handler = (_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(1024 * 1024, 120)));
    };
    expect(await allowed()(push())).toEqual({
      ok: true,
      status: 202,
      body: '',
      connectedAddress: '127.0.0.1',
    });
  });

  it('a redirect still fails: a push is never sent on', async () => {
    server.handler = (_req, res) => {
      res.writeHead(307, { location: 'https://elsewhere.test/hook' });
      res.end();
    };
    expect(await allowed()(push())).toEqual({ ok: false, error: 'redirect_refused', sent: true });
    expect(server.seen).toHaveLength(1);
  });

  it('a webhook that resolves to a private address gets no connection', async () => {
    const transport = createA2AHostTransport({ resolve: resolveTo('10.1.2.3'), ca: CERT });
    expect(await transport(push())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(server.connections).toBe(0);
  });
});
