/**
 * The Node policy socket on a real TLS server: a forbidden destination
 * receives no connection (by name, by a mixed answer, by a changing answer),
 * and every rule of the PolicySocket contract holds on the wire.
 */

import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { createNodePolicySocket } from '../src/policy_socket';

import type { PolicySocketRequest } from '@dina/net-policy';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

const CERT = readFileSync(path.join(__dirname, 'fixtures', 'localhost.cert.pem'), 'utf8');
const KEY = readFileSync(path.join(__dirname, 'fixtures', 'localhost.key.pem'), 'utf8');

type Handler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  body: Buffer,
) => void;

interface TestServer {
  port: number;
  connections: number;
  seen: {
    host?: string | undefined;
    servername?: string | undefined;
    method?: string | undefined;
    body?: Buffer;
    headers?: Record<string, unknown>;
  }[];
  handler: Handler;
  close(): Promise<void>;
}

async function startServer(tls: https.ServerOptions = {}): Promise<TestServer> {
  const state: TestServer = {
    port: 0,
    connections: 0,
    seen: [],
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end('{"ok":true}');
    },
    close: async () => undefined,
  };
  const server = https.createServer({ cert: CERT, key: KEY, ...tls }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
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

const socketFor = (over: Parameters<typeof createNodePolicySocket>[0] = {}) =>
  createNodePolicySocket({
    resolve: resolveTo('127.0.0.1'),
    isAllowedAddress: loopbackAllowed,
    ca: CERT,
    ...over,
  });

const call = (over: Partial<PolicySocketRequest> = {}): PolicySocketRequest => ({
  method: 'POST',
  url: `https://agent.test:${server.port}/ucp/checkout-sessions`,
  headers: {
    'content-type': 'application/json',
    'ucp-agent': 'profile="https://p.example/.well-known/ucp"',
  },
  body: new TextEncoder().encode('{"line_items":[]}'),
  accept: 'json',
  minTls: 'TLSv1.2',
  readAuthErrorBodies: false,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 5_000,
  ...over,
});

/** A request with no body (a GET, a DELETE). */
const bodiless = (over: Partial<PolicySocketRequest> = {}): PolicySocketRequest => {
  const { body: _body, ...rest } = call(over);
  return rest;
};

describe('a forbidden destination receives no connection', () => {
  it('a name that resolves to loopback is refused with the default classifier', async () => {
    const socket = createNodePolicySocket({ resolve: resolveTo('127.0.0.1'), ca: CERT });
    expect(await socket(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(server.connections).toBe(0);
  });

  it.each([
    ['benchmarking', '198.18.0.1'],
    ['documentation', '203.0.113.9'],
    ['6to4 wrapping loopback', '2002:7f00:1::1'],
    ['NAT64 wrapping a private address', '64:ff9b::a00:1'],
  ])('a %s answer (a gap in the old filter) is refused', async (_n, address) => {
    const socket = createNodePolicySocket({ resolve: resolveTo(address), ca: CERT });
    expect(await socket(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(server.connections).toBe(0);
  });

  it('one private address among public ones refuses the name', async () => {
    const socket = createNodePolicySocket({
      resolve: resolveTo('203.0.114.7', '10.0.0.1'),
      ca: CERT,
    });
    expect(await socket(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
  });

  it('resolves once and pins the socket to that answer', async () => {
    let calls = 0;
    const socket = socketFor({
      resolve: async (name) => {
        if (name === 'ipv4only.arpa') return [];
        calls += 1;
        return calls === 1 ? ['127.0.0.1'] : ['10.0.0.1'];
      },
    });
    expect(await socket(call())).toMatchObject({ ok: true, connectedAddress: '127.0.0.1' });
    expect(calls).toBe(1);
  });

  it('tries the next vetted address only when a connection never opened', async () => {
    // Nothing listens on the IPv6 loopback at this port: that address refuses
    // (or, with IPv6 off, cannot be reached); the IPv4 answer then serves.
    const socket = socketFor({
      resolve: resolveTo('::1', '127.0.0.1'),
      isAllowedAddress: (a) => a === '::1' || a === '127.0.0.1',
    });
    expect(await socket(call())).toMatchObject({ ok: true, connectedAddress: '127.0.0.1' });
    expect(server.connections).toBe(1);
  });

  it('bounds resolution by the deadline', async () => {
    const socket = socketFor({ resolve: () => new Promise(() => undefined) });
    expect(await socket(call({ timeoutMs: 50 }))).toEqual({
      ok: false,
      error: 'dns_failed',
      sent: false,
    });
  });

  it('refuses a non-https URL or userinfo before resolving', async () => {
    let resolved = false;
    const socket = socketFor({ resolve: async () => ((resolved = true), ['127.0.0.1']) });
    expect(await socket(call({ url: `http://agent.test:${server.port}/` }))).toEqual({
      ok: false,
      error: 'io_error',
      sent: false,
    });
    expect(await socket(call({ url: `https://u:p@agent.test:${server.port}/` }))).toEqual({
      ok: false,
      error: 'io_error',
      sent: false,
    });
    expect(resolved).toBe(false);
  });
});

describe('an allowed destination', () => {
  it('sends the exact body bytes with the name as SNI and Host, and the socket owns its headers', async () => {
    const out = await socketFor()(
      call({
        headers: { 'content-type': 'application/json', host: 'evil.example', accept: 'text/html' },
      }),
    );
    expect(out).toMatchObject({ ok: true, status: 200, connectedAddress: '127.0.0.1' });
    const seen = server.seen[0];
    expect(seen?.servername).toBe('agent.test');
    expect(seen?.host).toBe(`agent.test:${server.port}`);
    expect(seen?.headers).toMatchObject({
      accept: 'application/json',
      'accept-encoding': 'identity',
      'content-length': '17',
    });
    expect(seen?.body?.toString()).toBe('{"line_items":[]}');
    expect(out.ok && new TextDecoder().decode(out.bodyBytes)).toBe('{"ok":true}');
  });

  it.each(['PUT', 'DELETE', 'GET'] as const)('speaks %s', async (method) => {
    expect(
      await socketFor()(
        method === 'PUT'
          ? call({ method, body: new TextEncoder().encode('{}') })
          : bodiless({ method }),
      ),
    ).toMatchObject({ ok: true });
    expect(server.seen[0]?.method).toBe(method);
  });

  it('returns every response header, names lower-cased, in order', async () => {
    server.handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Signature-Input', 'sig1=("@status")');
      res.setHeader('X-Trace', ['a', 'b']);
      res.end('{}');
    };
    const out = await socketFor()(call());
    expect(
      out.ok &&
        out.rawHeaders.filter(
          ([n]) =>
            !['date', 'connection', 'transfer-encoding', 'keep-alive', 'content-length'].includes(
              n,
            ),
        ),
    ).toEqual([
      ['content-type', 'application/json'],
      ['signature-input', 'sig1=("@status")'],
      ['x-trace', 'a'],
      ['x-trace', 'b'],
    ]);
  });

  it('refuses headers past the hard cap', async () => {
    server.handler = (_req, res) => {
      for (let i = 0; i < 130; i++) res.setHeader(`x-h${i}`, 'v');
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    };
    expect(await socketFor()(call())).toEqual({ ok: false, error: 'too_large', sent: true });
  });

  it('never follows a redirect, but a 304 answering If-None-Match is a result', async () => {
    server.handler = (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' });
        res.end();
        return;
      }
      res.writeHead(301, { location: 'https://elsewhere.test/' });
      res.end();
    };
    expect(await socketFor()(bodiless({ method: 'GET' }))).toEqual({
      ok: false,
      error: 'redirect_refused',
      sent: true,
    });
    expect(await socketFor()(bodiless({ method: 'GET', ifNoneMatch: '"v1"' }))).toMatchObject({
      ok: true,
      status: 304,
      bodyBytes: new Uint8Array(0),
    });
  });

  it('refuses a compressed body and an unexpected media type', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{}'));
    };
    expect(await socketFor()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>');
    };
    expect(await socketFor()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
  });

  it('accepts SSE only for json-or-sse (an MCP endpoint)', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    };
    expect(await socketFor()(call())).toMatchObject({ ok: false, error: 'bad_content_type' });
    expect(await socketFor()(call({ accept: 'json-or-sse' }))).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it('discards 401/403 bodies unless asked, keeping WWW-Authenticate', async () => {
    server.handler = (_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
      });
      res.end('{"code":"identity_required"}');
    };
    const dropped = await socketFor()(call());
    expect(dropped).toMatchObject({ ok: true, status: 401, bodyBytes: new Uint8Array(0) });
    expect(dropped.ok && dropped.rawHeaders).toContainEqual([
      'www-authenticate',
      'Bearer error="invalid_token"',
    ]);
    const read = await socketFor()(call({ readAuthErrorBodies: true }));
    expect(read.ok && new TextDecoder().decode(read.bodyBytes)).toBe(
      '{"code":"identity_required"}',
    );
  });

  it('a status-only request never reads the body', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(Buffer.alloc(10_000));
    };
    expect(await socketFor()(call({ accept: 'status', maxResponseBytes: 0 }))).toMatchObject({
      ok: true,
      status: 200,
      bodyBytes: new Uint8Array(0),
    });
  });

  it('stops reading at the byte cap', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`"${'x'.repeat(5000)}"`);
    };
    expect(await socketFor()(call({ maxResponseBytes: 1000 }))).toEqual({
      ok: false,
      error: 'too_large',
      sent: true,
    });
  });

  it('times out a silent server and says the request may have been sent', async () => {
    server.handler = () => undefined;
    expect(await socketFor()(call({ timeoutMs: 300 }))).toEqual({
      ok: false,
      error: 'timeout',
      sent: true,
    });
  });
});

describe('TLS and connection failures report that nothing was sent', () => {
  it('refuses a certificate that does not name the host', async () => {
    expect(await socketFor()(call({ url: `https://unlisted.test:${server.port}/` }))).toEqual({
      ok: false,
      error: 'tls_failed',
      sent: false,
    });
    expect(server.seen).toHaveLength(0);
  });

  it('refuses a certificate no trusted CA issued', async () => {
    const socket = createNodePolicySocket({
      resolve: resolveTo('127.0.0.1'),
      isAllowedAddress: loopbackAllowed,
    });
    expect(await socket(call())).toEqual({ ok: false, error: 'tls_failed', sent: false });
  });

  it('a 1.3 floor refuses a server that offers only TLS 1.2; a 1.2 floor connects', async () => {
    const old = await startServer({ maxVersion: 'TLSv1.2' });
    try {
      const at = (minTls: 'TLSv1.2' | 'TLSv1.3') =>
        socketFor()(call({ url: `https://agent.test:${old.port}/`, minTls }));
      expect(await at('TLSv1.3')).toEqual({ ok: false, error: 'tls_failed', sent: false });
      expect(await at('TLSv1.2')).toMatchObject({ ok: true, status: 200 });
    } finally {
      await old.close();
    }
  });

  it('reports a refused connection', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await socketFor()(call({ url: `https://agent.test:${port}/` }))).toEqual({
      ok: false,
      error: 'connect_failed',
      sent: false,
    });
  });

  it('a header with CR or LF is refused before anything is sent', async () => {
    expect(
      await socketFor()(call({ headers: { authorization: 'Bearer a\r\nX-Injected: 1' } })),
    ).toEqual({
      ok: false,
      error: 'io_error',
      sent: false,
    });
    expect(server.seen).toHaveLength(0);
  });

  it('reports a name that does not resolve', async () => {
    const socket = createNodePolicySocket({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await socket(call())).toEqual({ ok: false, error: 'dns_failed', sent: false });
    expect(await createNodePolicySocket({ resolve: resolveTo() })(call())).toEqual({
      ok: false,
      error: 'dns_failed',
      sent: false,
    });
  });
});

describe('review round (U6), the same rules as the phone', () => {
  it.each([
    ['a non-ASCII header value', { headers: { 'x-a': 'café' } }],
    ['a GET with a body', { method: 'GET' as const }],
  ])('refuses %s before any lookup', async (_n, over) => {
    let resolved = false;
    const socket = socketFor({ resolve: async () => ((resolved = true), ['127.0.0.1']) });
    expect(await socket(call(over))).toEqual({ ok: false, error: 'io_error', sent: false });
    expect(resolved).toBe(false);
  });

  it('judges an answer under the network NAT64 prefix (RFC 7050) by the IPv4 inside', async () => {
    const socket = createNodePolicySocket({
      resolve: async (name) =>
        name === 'ipv4only.arpa' ? ['2a00:1450:64:1::c000:aa'] : ['2a00:1450:64:1::a00:1'],
      ca: CERT,
    });
    expect(await socket(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
  });

  it('refuses a transfer coding other than chunked', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'gzip, chunked',
      });
      res.end('{}');
    };
    expect(await socketFor()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
  });

  it('checks the media type for an empty body too, as A2A always has; a 204 has none', async () => {
    server.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end();
    };
    expect(await socketFor()(call())).toEqual({ ok: false, error: 'bad_content_type', sent: true });
    server.handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    expect(await socketFor()(call())).toMatchObject({ ok: true, status: 204 });
  });
});
