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
const KEY = 'gate-key-0123456789abcdef0123456789abcdef';

describe('Core’s per-address budget on a socket', () => {
  beforeEach(() => {
    process.env.DINA_GATE_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.DINA_GATE_KEY;
  });

  it('gives each client the gate names its own bucket, so one cannot starve another', async () => {
    const gate = (client: string) => ({ 'x-dina-client': client, 'x-dina-gate-key': KEY });
    const out = await statuses(true, [...times(61, gate('203.0.113.9')), gate('198.51.100.7'), {}]);
    expect(out[59]).toBe(200);
    expect(out[60]).toBe(429);
    expect(out[61]).toBe(200); // another client
    expect(out[62]).toBe(200); // the front door, on its own bucket
  });

  it('ignores a client name without the gate key: the front door cannot spend an owner’s budget', async () => {
    const forged = {
      'x-dina-client': '203.0.113.9',
      'x-dina-gate-key': 'wrong-key-wrong-key-wrong',
    };
    const out = await statuses(true, [
      ...times(60, forged),
      { 'x-dina-client': '203.0.113.9', 'x-dina-gate-key': KEY },
    ]);
    // The forged calls all landed on the front door's bucket, not the client's.
    expect(out.at(-1)).toBe(200);
  });

  it('gives no pass to a request that merely carries signature headers', async () => {
    const fake = { 'x-did': 'did:key:z6MkFake', 'x-signature': 'ab' };
    expect((await statuses(true, times(61, fake))).at(-1)).toBe(429);
  });

  it('changes nothing over TCP: one address, one bucket', async () => {
    const out = await statuses(false, [
      ...times(60, { 'x-dina-client': 'a', 'x-dina-gate-key': KEY }),
      { 'x-dina-client': 'b', 'x-dina-gate-key': KEY },
    ]);
    expect(out.at(-1)).toBe(429);
  });
});
