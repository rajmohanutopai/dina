/**
 * Core's calls to Brain under Brain's caller check (notes M2 preconditions:
 * "Core signs all five of its Brain calls (the ask bridge, service search,
 * the Tier 1 runner, the A2A result notice, the service result) through one
 * signed fetch ... so Brain's signature never goes to AppView"). Each call
 * site, given the signed fetch, sends a request Brain's check accepts; the
 * booted server hands the ask bridge and service search that fetch; the
 * plane's three calls name it in the source; the AppView client beside them
 * carries no signature header.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  NonceCache,
  checkRequestSignature,
  deriveDIDKey,
  getCoreServiceDid,
  getPublicKey,
  signRequest,
  type WorkflowTask,
} from '@dina/core';
import { registerDevice as pairDevice } from '@dina/core/devices';
import {
  getSessionRegistry,
  registerDevice as registerCallerDevice,
  resetCallerTypeState,
  resetMiddlewareState,
} from '@dina/core/runtime';

import { createAgentFacades } from '../src/agent/facades';
import { makeHttpAskHandler } from '../src/agent/http_ask_handler';
import { bootServer } from '../src/boot';
import { createSignedBrainFetch } from '../src/brain_link';
import { makeHttpTier1Runner } from '../src/workflow/http_tier1_runner';

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

const CORE_KEY = new Uint8Array(32).fill(23);
const CORE_DID = deriveDIDKey(getPublicKey(CORE_KEY));

let server: Server;
let base: string;
let seen: Seen[];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.search.slice(1), headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname === '/api/v1/internal/service/search') res.end('{"matches":[],"capability_candidates":[]}');
      else if (url.pathname === '/api/v1/capability/run') res.end('{"result":{"eta_minutes":1}}');
      else if (url.pathname.startsWith('/xrpc/')) res.end('{"results":[]}');
      else res.end('{"status":"complete","request_id":"r-1"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  seen = [];
});

/** Brain's check, as Brain runs it: Dina's canonical signature by the DID Core named to it. */
function brainAccepts(request: Seen, coreDid: string = CORE_DID): boolean {
  const check = checkRequestSignature(
    {
      method: request.method,
      path: request.path,
      query: request.query,
      body: new TextEncoder().encode(request.body),
      did: request.headers['x-did'],
      timestamp: request.headers['x-timestamp'],
      nonce: request.headers['x-nonce'],
      signature: request.headers['x-signature'],
    },
    { nonces: new NonceCache() },
  );
  return check.ok && request.headers['x-did'] === coreDid;
}

describe('Core’s Brain calls carry Core’s signature (notes M2 preconditions)', () => {
  const signed = createSignedBrainFetch({ did: CORE_DID, privateKey: CORE_KEY });

  // Extra X-9 (the ask bridge, service search, the Tier 1 runner)
  it('given the signed fetch, the ask bridge, service search and the Tier 1 runner each send a request Brain’s check accepts', async () => {
    await makeHttpAskHandler({ brainUrl: base, fetchImpl: signed }).handleAsk({ question: 'When is the next bus?', requesterDid: 'did:plc:owner' });
    const facades = createAgentFacades({ brainUrl: base, brainFetch: signed, appViewUrl: base });
    await facades.findService?.({ agentDid: 'did:key:z6MkAgent', sessionId: '', body: { capability: 'eta_query' } });
    const task = { id: 'svc-exec-1', payload: '{}' } as unknown as WorkflowTask;
    await makeHttpTier1Runner({ brainUrl: base, logger: pino({ level: 'silent' }) as never, fetchImpl: signed })('eta_query', { route_id: '1' }, task);
    const brainBound = seen.filter((r) => r.path.startsWith('/api/v1/'));
    expect(brainBound.map((r) => r.path).sort()).toEqual(['/api/v1/ask', '/api/v1/capability/run', '/api/v1/internal/service/search']);
    for (const request of brainBound) expect([request.path, brainAccepts(request)]).toEqual([request.path, true]);
  });

  // Extra X-9 (AppView)
  it('the AppView client beside them carries no signature header', async () => {
    const facades = createAgentFacades({ brainUrl: base, brainFetch: signed, appViewUrl: base });
    await facades.peerlensSearch?.({ agentDid: 'did:key:z6MkAgent', sessionId: '', body: { q: 'plumber' } });
    const appView = seen.filter((r) => r.path.startsWith('/xrpc/'));
    expect(appView.length).toBeGreaterThan(0);
    for (const request of appView) {
      for (const header of ['x-did', 'x-timestamp', 'x-nonce', 'x-signature']) expect(request.headers[header]).toBeUndefined();
    }
  });

  // Extra X-9 (the A2A result notice, the service result, the plane's Tier 1 runner)
  it('the A2A result notice, the service result and the Tier 1 runner go to Brain through the signed fetch boot hands the workflow plane', () => {
    const plane = readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'wire_workflow_plane.ts'), 'utf8');
    const boot = readFileSync(path.join(__dirname, '..', 'src', 'boot.ts'), 'utf8');
    for (const route of ['/api/v1/chat/a2a-result', '/api/v1/chat/service-result']) {
      const at = plane.indexOf(`\${brainUrl}${route}`);
      expect(at).toBeGreaterThan(0);
      // The call that names the route is the signed one.
      expect(plane.slice(Math.max(0, at - 40), at)).toMatch(/brainFetch\(\s*`$/);
    }
    // No Brain URL is fetched any other way in the plane.
    expect(plane).not.toMatch(/[^A-Za-z]fetch\(\s*`\$\{brainUrl\}/);
    // The plane's Tier 1 runner gets the same signed fetch.
    expect(plane).toMatch(/makeHttpTier1Runner\(\{\s*brainUrl,\s*logger,\s*fetchImpl:\s*brainFetch\s*\}\)/);
    // Boot hands the plane the signed fetch it built from Core's service key.
    expect(boot).toMatch(/brainFetch = createSignedBrainFetch\(/);
    const wire = boot.slice(boot.indexOf('wiredWorkflow = wireWorkflowPlane({'));
    expect(wire.slice(0, wire.indexOf('});'))).toMatch(/(^|[\s{,])brainFetch\s*,/);
  });

  // Extra X-9 (as boot wires them)
  it('in the booted server, the ask bridge and service search reach Brain signed by the DID Core names to Brain', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(path.join(tmpdir(), 'lane2-brain-boot-'));
    const quiet = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    for (const spy of quiet) spy.mockImplementation(() => undefined);
    Object.assign(process.env, {
      DINA_VAULT_DIR: dir,
      DINA_CORE_HOST: '127.0.0.1',
      DINA_CORE_PORT: '0',
      DINA_LOG_LEVEL: 'silent',
      DINA_MSGBOX_ENABLED: 'false',
      DINA_BRAIN_URL: base,
    });
    const booted = await bootServer();
    try {
      const coreDid = getCoreServiceDid();
      expect(coreDid).toMatch(/^did:key:z6Mk/);
      // A paired CLI asks a question; a paired coding agent, in a session, searches services.
      const cliSeed = new Uint8Array(32).fill(31);
      const cliDid = deriveDIDKey(getPublicKey(cliSeed));
      pairDevice('Owner CLI', cliDid.slice('did:key:'.length), 'cli');
      registerCallerDevice(cliDid, 'Owner CLI');
      const agentSeed = new Uint8Array(32).fill(32);
      const agentDid = deriveDIDKey(getPublicKey(agentSeed));
      pairDevice('Coding agent', agentDid.slice('did:key:'.length), 'agent', 'coding');
      registerCallerDevice(agentDid, 'Coding agent');
      const session = getSessionRegistry().start({ agentDid, hostSessionId: 'lane2-brain-calls' });
      const post = (url: string, body: unknown, seed: Uint8Array, did: string) => {
        const raw = JSON.stringify(body);
        const headers = signRequest('POST', url, '', new TextEncoder().encode(raw), seed, did);
        return booted.app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: raw });
      };
      const asked = await post('/api/v1/ask', { question: 'When is the next bus?' }, cliSeed, cliDid);
      expect(asked.statusCode).toBeLessThan(300);
      const searched = await post('/v1/agent/service/search', { session_id: session.sessionId, capability: 'eta_query' }, agentSeed, agentDid);
      expect(searched.statusCode).toBeLessThan(300);
      const end = Date.now() + 5_000;
      const paths = () => seen.map((r) => r.path);
      while (!(paths().includes('/api/v1/ask') && paths().includes('/api/v1/internal/service/search'))) {
        if (Date.now() > end) throw new Error(`Brain saw only ${JSON.stringify(paths())}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const brainBound = seen.filter((r) => r.path === '/api/v1/ask' || r.path === '/api/v1/internal/service/search');
      for (const request of brainBound) expect([request.path, brainAccepts(request, coreDid ?? '')]).toEqual([request.path, true]);
      // Control: the same request, checked against another DID, is refused.
      expect(brainAccepts(brainBound[0] as Seen, CORE_DID)).toBe(false);
    } finally {
      await booted.app.close();
      rmSync(dir, { recursive: true, force: true });
      for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
      for (const [k, v] of Object.entries(originalEnv)) if (typeof v === 'string') process.env[k] = v;
      resetMiddlewareState();
      resetCallerTypeState();
      for (const spy of quiet) spy.mockRestore();
    }
  }, 60_000);
});
