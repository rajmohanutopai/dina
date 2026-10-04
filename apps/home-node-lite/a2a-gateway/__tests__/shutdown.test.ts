/**
 * Closing the gateway ends every stream and completes (boot.ts; design §7.5:
 * a client whose stream ends recovers with GetTask). The server waits for
 * every open connection before it closes, so the streams must end first.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { A2A_CORE_ANSWER_HEADER, A2A_CREDENTIAL_GEN_HEADER, A2A_EVENT_SEQ_HEADER, A2A_STREAM_CLIENT_HEADER } from '@dina/a2a';

import { bootGateway } from '../src/boot';
import { ensureServiceKey } from '../src/keygen';

let core: Server;
let dir: string;

beforeAll(async () => {
  // Core at the network edge: it answers a subscription with a working task.
  core = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', [A2A_CORE_ANSWER_HEADER]: '1', [A2A_EVENT_SEQ_HEADER]: '0', [A2A_CREDENTIAL_GEN_HEADER]: '0', [A2A_STREAM_CLIENT_HEADER]: 'c'.repeat(32) });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { task: { id: 't-1', status: { state: 'TASK_STATE_WORKING' } } } }));
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  dir = mkdtempSync(path.join(tmpdir(), 'gw-close-'));
});

afterAll(async () => {
  core.closeAllConnections();
  await new Promise((resolve) => core.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** A port free right now (the gateway's config takes no port 0). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const within = <T,>(p: Promise<T>, ms = 3_000) =>
  Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

it('closing the gateway while a stream is open ends the stream, and the close completes', async () => {
  const keyDir = path.join(dir, 'keys');
  await ensureServiceKey(keyDir, 'gateway.ed25519');
  const port = await freePort();
  const booted = await bootGateway({
    DINA_A2A_GATEWAY_KEY_DIR: keyDir,
    DINA_A2A_GATEWAY_PORT: String(port),
    DINA_CORE_URL: `http://127.0.0.1:${(core.address() as { port: number }).port}`,
    DINA_LOG_LEVEL: 'silent',
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer dina_a2a_${'Q'.repeat(43)}`, 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0","id":1,"method":"SubscribeToTask","params":{"id":"t-1"}}',
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read(); // the stream is open
    const closing = booted.app.close().then(() => 'closed' as const);
    const ended = (async () => {
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) return 'ended' as const;
      }
    })().catch(() => 'ended' as const);
    expect(await within(ended)).toBe('ended');
    expect(await within(closing)).toBe('closed');
  } finally {
    booted.app.server.closeAllConnections();
  }
}, 15_000);
