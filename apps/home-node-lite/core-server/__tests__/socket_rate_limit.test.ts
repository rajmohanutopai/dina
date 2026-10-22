/**
 * HOSTED_DINA §7: on a Unix socket every caller has one address, so Core's
 * per-address budget would be one bucket for the dot, the owner's browser and
 * every stranger. There a signed request skips it (Core's per-DID limit, after
 * the signature is checked, governs it); unsigned ones keep it. Over TCP
 * nothing changes. Tested at the production default (60 per minute).
 */

import { pino } from 'pino';

import { createServer } from '../src/server';

import type { CoreServerConfig } from '../src/config';

function config(onSocket: boolean): CoreServerConfig {
  return {
    network: {
      host: '127.0.0.1',
      port: 0,
      ...(onSocket ? { socketPath: '/tmp/cell/core.sock' } : {}),
    },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  } as CoreServerConfig;
}

async function statuses(
  onSocket: boolean,
  headerSets: Record<string, string>[],
): Promise<number[]> {
  const app = await createServer({ config: config(onSocket), logger: pino({ level: 'silent' }) });
  app.post('/v1/pair/complete', async () => ({ ok: true }));
  const out: number[] = [];
  for (const headers of headerSets) {
    out.push((await app.inject({ method: 'POST', url: '/v1/pair/complete', headers })).statusCode);
  }
  await app.close();
  return out;
}

const times = (n: number, h: Record<string, string>) => Array.from({ length: n }, () => h);

describe('Core’s per-address budget on a socket', () => {
  it('gives each client the gate names its own bucket, so one cannot starve another', async () => {
    const out = await statuses(true, [
      ...times(61, { 'x-dina-client': '203.0.113.9' }),
      { 'x-dina-client': '198.51.100.7' },
      {},
    ]);
    expect(out[59]).toBe(200);
    expect(out[60]).toBe(429);
    expect(out[61]).toBe(200); // another client
    expect(out[62]).toBe(200); // the front door / the gate itself
  });

  it('gives no pass to a request that merely carries signature headers', async () => {
    const fake = {
      'x-dina-client': '203.0.113.9',
      'x-did': 'did:key:z6MkFake',
      'x-signature': 'ab',
    };
    expect((await statuses(true, times(61, fake))).at(-1)).toBe(429);
  });

  it('changes nothing over TCP: one address, one bucket', async () => {
    const out = await statuses(false, [
      ...times(60, { 'x-dina-client': 'a' }),
      { 'x-dina-client': 'b' },
    ]);
    expect(out.at(-1)).toBe(429);
  });
});
