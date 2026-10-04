/**
 * Brain under its caller check, booted as a server runs it (plan §3.18;
 * design §4.1 compromise model; notes M2 preconditions "Who an ask is for
 * comes from the verified caller"). Core and the owner's devices are the
 * only signers Brain serves: the A2A gateway's own key, a valid Core caller,
 * opens no Brain route. An owner device's ask is the owner's own; Core's
 * forwarded ask keeps the requester Core names; approve and deny are owner
 * acts.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveDIDKey, getPublicKey, signRequest } from '@dina/core';

import { bootServer, type BootedServer } from '../src/boot';

import type { AskCoordinator } from '@dina/brain';

const key = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, did: deriveDIDKey(getPublicKey(privateKey)) };
};
const CORE = key(61);
const OWNER_DEVICE = key(62);
const GATEWAY = key(63);
const OWNER_DID = 'did:plc:lanetwoowner';

let core: Server;
let dir: string;
let booted: BootedServer;
let asks: { requesterDid: string }[];
let decided: string[];
const savedOwner = process.env.DINA_OWNER_DID;

beforeAll(async () => {
  // Core's answer to "who may call Brain": Core's key and one owner device. The gateway's key is a Core caller, not a Brain one.
  core = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ core: CORE.did, owner_devices: [OWNER_DEVICE.did] }));
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  dir = mkdtempSync(path.join(tmpdir(), 'lane2-brain-'));
  writeFileSync(path.join(dir, 'brain.ed25519'), randomBytes(32));
  process.env.DINA_OWNER_DID = OWNER_DID;
  asks = [];
  decided = [];
  const coordinator = {
    handleAsk: async (input: { requesterDid: string }) => {
      asks.push({ requesterDid: input.requesterDid });
      return { kind: 'fast_path' as const, status: 200 as const, body: { request_id: 'ask-1', status: 'complete' as const, answer: { text: 'ok' } } };
    },
    handleStatus: async () => ({ kind: 'not_found' as const, status: 404 as const, body: { error: 'not found' } }),
    gateway: {
      approve: async (id: string) => {
        decided.push(`approve:${id}`);
        return { ok: true };
      },
      deny: async (id: string) => {
        decided.push(`deny:${id}`);
        return { ok: true };
      },
    },
    registry: { get: async () => ({ approvalId: 'appr-1' }) },
    resumer: {},
    subscribe: () => () => undefined,
  } as unknown as AskCoordinator;
  booted = await bootServer(
    {
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0',
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
      DINA_SERVICE_KEY_DIR: dir,
      DINA_CORE_URL: `http://127.0.0.1:${(core.address() as { port: number }).port}`,
    },
    { askCoordinator: coordinator },
  );
});

afterAll(async () => {
  await booted.app.close();
  await new Promise((resolve) => core.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  if (savedOwner === undefined) delete process.env.DINA_OWNER_DID;
  else process.env.DINA_OWNER_DID = savedOwner;
});

beforeEach(() => {
  asks.length = 0;
  decided.length = 0;
});

function signed(signer: { privateKey: Uint8Array; did: string }, method: string, url: string, body?: string) {
  const [p, query = ''] = url.split('?');
  const headers = signRequest(method, p ?? url, query, new TextEncoder().encode(body ?? ''), signer.privateKey, signer.did);
  return booted.app.inject({
    method: method as 'GET',
    url,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: body }),
  });
}

/** Every (method, path) the booted Brain serves, read from its route tree. */
function brainRoutes(): { method: string; url: string }[] {
  const tree = booted.app.printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  const out: { method: string; url: string }[] = [];
  for (const line of tree.split('\n')) {
    const at = line.search(/[└├]── /);
    if (at < 0) continue;
    const depth = at / 4;
    const rest = line.slice(at + 4);
    const open = rest.lastIndexOf(' (');
    const segment = open < 0 ? rest : rest.slice(0, open);
    stack.length = depth;
    stack.push(segment);
    if (open < 0) continue;
    const full = stack.join('');
    for (const method of rest.slice(open + 2, -1).split(', ')) {
      if (method !== 'HEAD') out.push({ method, url: full.replace(/:[A-Za-z]+/g, 'x') });
    }
  }
  return out;
}

describe('the gateway’s key opens no Brain route (design §4.1 compromise model)', () => {
  // Extra X-8
  it('a request signed with the gateway’s key gets 401 on every Brain route; Core’s own key is served', async () => {
    const routes = brainRoutes().filter((r) => r.url !== '/healthz' && r.url !== '/readyz');
    for (const must of ['/api/v1/chat/a2a-result', '/api/v1/ask', '/api/v1/ask/x/approve', '/api/v1/ask/x/deny']) {
      expect(routes.map((r) => r.url)).toContain(must);
    }
    for (const route of routes) {
      const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : '{"text":"x","question":"q","requesterDid":"did:plc:x"}';
      const res = await signed(GATEWAY, route.method, route.url, body);
      expect([route.method, route.url, res.statusCode]).toEqual([route.method, route.url, 401]);
    }
    expect(asks).toEqual([]);
    expect(decided).toEqual([]);
    // Control: Core's own key is a caller Brain serves.
    const asked = await signed(CORE, 'POST', '/api/v1/ask', '{"question":"q","requesterDid":"did:key:z6MkAgent"}');
    expect(asked.statusCode).toBe(200);
  });
});

describe('who an ask is for comes from the verified caller (notes M2 preconditions)', () => {
  // Plan C232
  it('an owner device’s ask is the owner’s own, whatever its body names', async () => {
    const res = await signed(OWNER_DEVICE, 'POST', '/api/v1/ask', '{"question":"q","requesterDid":"did:plc:somebody-else"}');
    expect(res.statusCode).toBe(200);
    expect(asks).toEqual([{ requesterDid: OWNER_DID }]);
  });

  // Plan C233
  it('Core’s forwarded ask keeps the requester Core names', async () => {
    const res = await signed(CORE, 'POST', '/api/v1/ask', '{"question":"q","requesterDid":"did:key:z6MkPairedAgent"}');
    expect(res.statusCode).toBe(200);
    expect(asks).toEqual([{ requesterDid: 'did:key:z6MkPairedAgent' }]);
  });

  // Plan C234
  it.each(['approve', 'deny'])('%s is an owner-device act: Core gets 403 and the coordinator is untouched', async (verb) => {
    const asCore = await signed(CORE, 'POST', `/api/v1/ask/ask-1/${verb}`, '{}');
    expect(asCore.statusCode).toBe(403);
    expect(decided).toEqual([]);
    const asOwner = await signed(OWNER_DEVICE, 'POST', `/api/v1/ask/ask-1/${verb}`, '{}');
    expect(asOwner.statusCode).toBe(200);
    expect(decided).toEqual([`${verb}:appr-1`]);
  });
});
