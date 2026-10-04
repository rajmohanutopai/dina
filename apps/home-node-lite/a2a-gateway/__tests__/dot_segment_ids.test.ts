/**
 * A task id of '.' or '..' is a dot segment: an HTTP client folds it away,
 * so a forward built from it would reach another Core route. No task has
 * such an id, so the gateway answers as Core does for an unknown task and
 * forwards nothing. Requests are written byte for byte, as a client that
 * does not tidy its path sends them.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

import { pino } from 'pino';

import { deriveDIDKey, getPublicKey } from '@dina/core';

import { createCoreLink } from '../src/core_link';
import { EdgeLimiter } from '../src/edge_limit';
import { buildGatewayServer } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { FastifyInstance } from 'fastify';

let core: Server;
let gateway: FastifyInstance;
let port: number;
const reached: string[] = [];

beforeAll(async () => {
  // Core at the network edge: it records every path a forward reaches.
  core = createServer((req, res) => {
    reached.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-dina-a2a-answer': '1' });
      res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Task not found"}}');
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  const seed = new Uint8Array(randomBytes(32));
  gateway = buildGatewayServer({
    core: createCoreLink({
      baseUrl: `http://127.0.0.1:${(core.address() as { port: number }).port}`,
      key: { seed, did: deriveDIDKey(getPublicKey(seed)) },
      timeoutMs: 2_000,
    }),
    limiter: new EdgeLimiter(1_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub: new StreamHub({ maxStreams: 4, bufferMs: 1_000, bufferEvents: 4, bufferTasks: 4, bufferBytes: 1 << 20 }),
    streams: { perIp: 20, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
  });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  port = (gateway.server.address() as { port: number }).port;
});

afterAll(async () => {
  await gateway.close();
  await new Promise((resolve) => core.close(resolve));
});

beforeEach(() => {
  reached.length = 0;
});

function raw(request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let out = '';
    socket.on('data', (d: Buffer) => (out += d.toString()));
    socket.on('end', () => resolve(out));
  });
}

const restGet = (path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nA2A-Version: 1.0\r\nConnection: close\r\n\r\n`;
const rpc = (body: string) =>
  `POST /a2a/v1 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nA2A-Version: 1.0\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

it.each(['/a2a/rest/tasks/..', '/a2a/rest/tasks/.', '/a2a/rest/tasks/%2e%2e', '/a2a/rest/tasks/%2E', '/a2a/rest/tasks/../cancel'])(
  'REST %s: no route, 404 at the gateway, and nothing reaches Core',
  async (path) => {
    const answer = await raw(restGet(path));
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
    expect(reached).toEqual([]);
  },
);

it.each(['..', '.'])('JSON-RPC GetTask with id %p: task not found (-32001), and nothing reaches Core', async (id) => {
  const answer = await raw(rpc(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id } })));
  const body = JSON.parse(answer.slice(answer.indexOf('\r\n\r\n') + 4)) as { id: number; error: { code: number } };
  expect([body.id, body.error.code]).toEqual([7, -32001]);
  expect(reached).toEqual([]);
});

it('an id with dots that is not a dot segment still reaches its own route', async () => {
  await raw(restGet('/a2a/rest/tasks/t.1..x'));
  await raw(rpc(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'GetTask', params: { id: '...' } })));
  expect(reached).toEqual(['/v1/a2a/ingress/tasks/t.1..x/get', '/v1/a2a/ingress/tasks/.../get']);
});
