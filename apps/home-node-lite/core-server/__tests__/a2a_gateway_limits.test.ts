/**
 * A2A Lane 2 (design §4.1): every gateway call reaches Core from one
 * address, so Core's per-address budget skips the gateway's routes when
 * Lane 2 is configured, and only those, and only for a call that names the
 * gateway's DID: any other caller of those routes keeps the budget. Tested
 * at the production default (60 per minute).
 */

import { pino } from 'pino';

import { createServer } from '../src/server';

import type { CoreServerConfig } from '../src/config';

const GATEWAY_DID = 'did:key:z6MkGateway';

function config(lane2: boolean): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
    ...(lane2 ? { a2a: { publicOrigin: 'https://dina.example.org', gatewayDid: GATEWAY_DID } } : {}),
  } as CoreServerConfig;
}

async function hits(
  lane2: boolean,
  method: 'GET' | 'POST',
  url: string,
  n: number,
  did: string | null = GATEWAY_DID,
): Promise<number[]> {
  const app = await createServer({ config: config(lane2), logger: pino({ level: 'silent' }) });
  app.post('/v1/a2a/ingress/message', async () => ({ ok: true }));
  app.post('/v1/a2a/ingress/tasks/:extId/get', async () => ({ ok: true }));
  app.post('/v1/a2a/ingress/push-configs/:extId/create', async () => ({ ok: true }));
  app.post('/v1/a2a/ingress/events/claim', async () => ({ ok: true }));
  app.post('/v1/a2a/ingress/elsewhere', async () => ({ ok: true }));
  app.get('/v1/a2a/card', async () => ({ ok: true }));
  app.post('/v1/workflow/tasks/claim', async () => ({ ok: true }));
  const statuses: number[] = [];
  const headers = did === null ? {} : { 'x-did': did };
  for (let i = 0; i < n; i += 1) statuses.push((await app.inject({ method, url, headers })).statusCode);
  await app.close();
  return statuses;
}

describe('Core’s per-address budget and the gateway', () => {
  it.each([
    ['POST', '/v1/a2a/ingress/message'],
    ['POST', '/v1/a2a/ingress/tasks/t-1/get?A2A-Version=1.0'],
    ['POST', '/v1/a2a/ingress/push-configs/t/create'],
    ['POST', '/v1/a2a/ingress/events/claim'],
    ['GET', '/v1/a2a/card'],
  ] as const)('with Lane 2 on, %s %s passes more than 60 calls a minute', async (method, url) => {
    expect((await hits(true, method, url, 75)).every((s) => s === 200)).toBe(true);
  });

  it('with Lane 2 off, the same routes are counted', async () => {
    expect((await hits(false, 'POST', '/v1/a2a/ingress/message', 61)).at(-1)).toBe(429);
  });

  // Cold audit C3-9: the path alone exempts no one
  it.each([
    ['names another DID', 'did:key:z6MkSomeoneElse'],
    ['names no DID', null],
  ])('with Lane 2 on, a call to the gateway’s route that %s stays counted', async (_name, did) => {
    expect((await hits(true, 'POST', '/v1/a2a/ingress/message', 61, did)).at(-1)).toBe(429);
    expect((await hits(true, 'GET', '/v1/a2a/card', 61, did)).at(-1)).toBe(429);
  });

  it('with Lane 2 on, a route the gateway does not serve stays counted', async () => {
    expect((await hits(true, 'POST', '/v1/a2a/ingress/elsewhere', 61)).at(-1)).toBe(429);
    expect((await hits(true, 'POST', '/v1/workflow/tasks/claim', 61)).at(-1)).toBe(429);
  });
});
