/**
 * Core holds a `SendMessage` that did not ask to return at once for up to
 * A2A_SEND_WAIT_MS (A2A `returnImmediately`), so the gateway's forward of
 * that one route waits longer than Core does, whatever timeout is set for
 * every other call. Any other forward still gives up at the set timeout.
 */

import { createServer, type Server } from 'node:http';

import { A2A_CORE_ANSWER_HEADER, ingressRouteOf } from '@dina/a2a';
import { deriveDIDKey, getPublicKey } from '@dina/core';

import { createCoreLink } from '../src/core_link';

import type { GatewayEnvelope } from '@dina/core';

let core: Server;
let base: string;
/** How long Core takes to answer. */
let delayMs = 0;

beforeAll(async () => {
  core = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', [A2A_CORE_ANSWER_HEADER]: '1' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
});
afterAll(async () => {
  core.closeAllConnections();
  await new Promise((resolve) => core.close(resolve));
});

const seed = new Uint8Array(32).fill(51);
const envelope: GatewayEnvelope = { request: { method: 'POST', path: '/a2a/v1', query: '', body: '{}' }, client_auth: {} };

describe('the SendMessage forward waits longer than Core’s wait', () => {
  it('outlasts the timeout set for other calls', async () => {
    delayMs = 400;
    const link = createCoreLink({ baseUrl: base, key: { seed, did: deriveDIDKey(getPublicKey(seed)) }, timeoutMs: 150 });
    const sent = await link.forward(ingressRouteOf('SendMessage'), envelope);
    expect(sent.ok).toBe(true);
    // Every other forward gives up at the timeout set.
    expect(await link.forward(ingressRouteOf('ListTasks'), envelope)).toEqual({ ok: false, status: 'unreachable' });
    expect(await link.forward(ingressRouteOf('SendStreamingMessage'), envelope)).toEqual({ ok: false, status: 'unreachable' });
  });
});
