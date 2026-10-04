/**
 * Lane 1 host transport gaps (design §6.6, §5.3, §10): every kind of
 * forbidden DNS answer gets no connection under the production address
 * rule; a refused credential's answer is never read; a server that drips its
 * body is cut at the deadline; and the transport prints nothing of what it
 * carries.
 */

import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { format } from 'node:util';
import { gzipSync } from 'node:zlib';

import { A2A_FETCH_LIMITS, type A2AHttpRequest } from '@dina/core';

import { createA2AHostTransport } from '../src/a2a_host_transport';

import type { AddressInfo } from 'node:net';

const FIXTURES = path.join(__dirname, 'fixtures', 'a2a_tls');
const CERT = readFileSync(path.join(FIXTURES, 'localhost.cert.pem'), 'utf8');
const KEY = readFileSync(path.join(FIXTURES, 'localhost.key.pem'), 'utf8');

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

let server: https.Server;
let port = 0;
let connections = 0;
let handler: Handler;
const timers: ReturnType<typeof setInterval>[] = [];

beforeEach(async () => {
  connections = 0;
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => handler(req, res));
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const t of timers.splice(0)) clearInterval(t);
  jest.restoreAllMocks();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

const call = (over: Partial<A2AHttpRequest> = {}): A2AHttpRequest => ({
  method: 'POST',
  url: `https://agent.test:${port}/rpc`,
  headers: { 'A2A-Version': '1.0' },
  body: '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"t"}}',
  ...A2A_FETCH_LIMITS.rpc,
  ...over,
});

/** The production rule: no `isAllowedAddress`, so `isBlockedAddress` decides. */
const productionTransport = (...answers: string[]) =>
  createA2AHostTransport({ resolve: async () => answers, ca: CERT });

/** Loopback allowed for the test server alone, as the existing transport tests do. */
const loopbackTransport = () =>
  createA2AHostTransport({ resolve: async () => ['127.0.0.1'], isAllowedAddress: (a) => a === '127.0.0.1', ca: CERT });

/**
 * The call that opens a socket. The transport reaches `https.request` on the
 * module object Node shares, so a spy here sees every request it starts,
 * whatever address it was headed for.
 */
const openSockets = () => jest.spyOn(jest.requireActual<typeof https>('node:https'), 'request');

describe('a forbidden DNS answer gets no connection (design §6.6)', () => {
  // Plan B225 (control: the spy sees the request an allowed address opens)
  it('opens a request for an allowed address, so the spy below sees every socket the transport starts', async () => {
    const opened = openSockets();
    expect(await loopbackTransport()(call())).toMatchObject({ ok: true, status: 200 });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(connections).toBe(1);
  });

  // Plan B225
  it.each([
    ['the cloud metadata address', '169.254.169.254'],
    ['loopback mapped into IPv6', '::ffff:127.0.0.1'],
    ['loopback mapped into IPv6, written in hex', '::ffff:7f00:1'],
    ['IPv6 loopback', '::1'],
    ['0.0.0.0', '0.0.0.0'],
    ['the IPv6 unspecified address', '::'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['RFC 1918 10/8', '10.0.0.1'],
    ['RFC 1918 172.16/12', '172.16.5.4'],
    ['RFC 1918 192.168/16', '192.168.1.1'],
    ['multicast', '224.0.0.1'],
    ['an answer that is no address', 'not-an-address'],
  ])('refuses %s before any socket opens', async (_name, address) => {
    const opened = openSockets();
    expect(await productionTransport(address)(call())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(opened).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });

  // Plan B225
  it('refuses an empty answer before any socket opens', async () => {
    const opened = openSockets();
    expect(await productionTransport()(call())).toEqual({ ok: false, error: 'dns_failed', sent: false });
    expect(opened).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });
});

describe('a refused credential (design §5.3 as built)', () => {
  // Plan B235
  it.each([401, 403])('returns the status of a %i and never reads its body, whatever it is', async (status) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from(`REMOTE-REFUSAL-TEXT ${'x'.repeat(512 * 1024)}`)));
    };
    expect(await loopbackTransport()(call({ maxResponseBytes: 1024 }))).toEqual({
      ok: true,
      status,
      body: '',
      connectedAddress: '127.0.0.1',
    });
  });
});

describe('the deadline covers the whole exchange (design §6.6 timeouts)', () => {
  // Plan B236
  it('cuts a server that drips its body past the deadline, and says the request may have been sent', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":"');
      timers.push(setInterval(() => res.write('x'), 50));
    };
    const started = Date.now();
    expect(await loopbackTransport()(call({ timeoutMs: 400 }))).toEqual({ ok: false, error: 'timeout', sent: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('the transport prints nothing it carries (design §10 metadata-only logs, §12)', () => {
  // Plan X-4
  it('writes no request text, credential, or remote answer to the console or the process streams', async () => {
    const printed: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        // format() prints objects whole, as the console would, so a leak inside one shows.
        printed.push(format(...args));
      });
    }
    const keep = (chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(keep as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(keep as never);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"note":"REMOTE-ANSWER-TEXT"}}');
    };
    const secrets = { 'A2A-Version': '1.0', 'X-Api-Key': 'KEY-SECRET-2207' };
    const body = '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"parts":[{"text":"OUTGOING-TEXT-31"}]}}}';
    const ok = await loopbackTransport()(call({ headers: secrets, body }));
    expect(ok).toMatchObject({ ok: true, status: 200 });
    // A failing call too: errors are reported as codes, never printed.
    const refused = await loopbackTransport()(call({ headers: secrets, body, url: `https://unlisted.test:${port}/rpc` }));
    expect(refused).toEqual({ ok: false, error: 'tls_failed', sent: false });
    const all = printed.join('\n');
    for (const text of ['KEY-SECRET-2207', 'OUTGOING-TEXT-31', 'REMOTE-ANSWER-TEXT']) {
      expect(all).not.toContain(text);
    }
  });
});
