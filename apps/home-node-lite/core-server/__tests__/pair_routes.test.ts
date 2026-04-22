/**
 * Tasks 4.63 + 4.67 — Fastify integration tests for pairing routes.
 *
 * Exercises the full path through the Fastify stack: body parsing,
 * error envelope, wire-shape, and the registry bindings. Uses
 * `app.inject()` so there's no real port bind — tests run in ~80 ms.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { PairingCodeRegistry } from '../src/pair/pairing_codes';
import { DeviceTokenRegistry } from '../src/pair/device_tokens';
import { registerPairRoutes } from '../src/pair/routes';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

function scriptedRandom(scripts: number[][]): (n: number) => Uint8Array {
  let i = 0;
  return (n) => {
    const next = scripts[i++];
    if (next === undefined) throw new Error(`scriptedRandom exhausted at call ${i}`);
    if (next.length !== n) {
      throw new Error(`scriptedRandom length ${next.length} != requested ${n}`);
    }
    return new Uint8Array(next);
  };
}

function seed(len: number, byte: number): number[] {
  return Array.from({ length: len }, () => byte);
}

const NODE_DID = 'did:plc:homenode-abc';

async function buildApp(opts: {
  codeSeeds?: number[][];
  tokenSeeds?: number[][];
  codeTtlMs?: number;
  nowMsFn?: () => number;
} = {}) {
  const pairingCodes = new PairingCodeRegistry({
    randomBytesFn: opts.codeSeeds ? scriptedRandom(opts.codeSeeds) : undefined,
    ttlMs: opts.codeTtlMs,
    nowMsFn: opts.nowMsFn,
  });
  const deviceTokens = new DeviceTokenRegistry({
    randomBytesFn: opts.tokenSeeds ? scriptedRandom(opts.tokenSeeds) : undefined,
    nowMsFn: opts.nowMsFn,
  });
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  registerPairRoutes(app, { pairingCodes, deviceTokens, nodeDid: NODE_DID });
  return { app, pairingCodes, deviceTokens };
}

describe('POST /v1/pair/initiate (task 4.63)', () => {
  it('returns 200 with {code, expires_in: 300}', async () => {
    const { app } = await buildApp({ codeSeeds: [seed(32, 0xaa)] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/initiate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: string; expires_in: number };
    expect(body.code).toHaveLength(8);
    expect(body.expires_in).toBe(300); // default TTL = 5 min
    await app.close();
  });

  it('honours a custom TTL in the registry', async () => {
    const { app } = await buildApp({
      codeSeeds: [seed(32, 0xbb)],
      codeTtlMs: 60_000,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/initiate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.json().expires_in).toBe(60);
    await app.close();
  });

  it('returns 429 when the registry is at the pending cap', async () => {
    // Fill the cap by calling generate 100 times with unique seeds,
    // then initiate → should 429.
    const seeds: number[][] = [];
    for (let i = 0; i < 101; i++) {
      const b: number[] = [];
      for (let j = 0; j < 32; j++) b.push((i * 53 + j * 7) & 0xff);
      seeds.push(b);
    }
    const { app, pairingCodes } = await buildApp({ codeSeeds: seeds });
    for (let i = 0; i < 100; i++) pairingCodes.generate();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/initiate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'too many pending pairing codes' });
    await app.close();
  });

  it('initiate emits a code that appears in pairingCodes.isLive', async () => {
    const { app, pairingCodes } = await buildApp({ codeSeeds: [seed(32, 0x42)] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/initiate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const { code } = res.json() as { code: string };
    expect(pairingCodes.isLive(code)).toBe(true);
    await app.close();
  });
});

describe('POST /v1/pair/complete (task 4.63)', () => {
  it('completes a live code → 200 with {device_id, client_token, node_did}', async () => {
    const { app, deviceTokens } = await buildApp({
      codeSeeds: [seed(32, 0x11)],
      tokenSeeds: [seed(32, 0x22)],
    });
    const initRes = await app.inject({
      method: 'POST',
      url: '/v1/pair/initiate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const { code } = initRes.json() as { code: string };

    const compRes = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'phone' },
    });
    expect(compRes.statusCode).toBe(200);
    const body = compRes.json() as {
      device_id: string;
      client_token: string;
      node_did: string;
    };
    expect(body.device_id).toMatch(/^dev-\d+$/);
    expect(body.client_token).toHaveLength(64); // 32 bytes hex
    expect(body.node_did).toBe(NODE_DID);

    // The token round-trips through verify() on the same registry.
    const record = deviceTokens.verify(body.client_token);
    expect(record?.deviceId).toBe(body.device_id);
    expect(record?.role).toBe('user');
    await app.close();
  });

  it('accepts role=agent', async () => {
    const { app, deviceTokens } = await buildApp({
      codeSeeds: [seed(32, 0x31)],
      tokenSeeds: [seed(32, 0x32)],
    });
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/v1/pair/initiate',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })
    ).json() as { code: string };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'openclaw', role: 'agent' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { device_id: string };
    expect(deviceTokens.get(body.device_id)?.role).toBe('agent');
    await app.close();
  });

  it('rejects missing code with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { device_name: 'phone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'code is required' });
    await app.close();
  });

  it('rejects missing device_name with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'ABCDEFGH' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'device_name is required' });
    await app.close();
  });

  it('rejects unknown role with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'ABCDEFGH', device_name: 'phone', role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'role must be "user" or "agent"' });
    await app.close();
  });

  it('returns 401 for an unknown code', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'NOSUCHCD', device_name: 'phone' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid or expired pairing code' });
    await app.close();
  });

  it('returns 401 for an expired code', async () => {
    let nowMs = 1_700_000_000_000;
    const { app } = await buildApp({
      codeSeeds: [seed(32, 0x55)],
      codeTtlMs: 1000,
      nowMsFn: () => nowMs,
    });
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/v1/pair/initiate',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })
    ).json() as { code: string };
    nowMs += 2000; // now past TTL
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'phone' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('second complete with the same code returns 401 (invalid — already consumed)', async () => {
    const { app } = await buildApp({
      codeSeeds: [seed(32, 0x77)],
      tokenSeeds: [seed(32, 0x78)],
    });
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/v1/pair/initiate',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })
    ).json() as { code: string };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'phone' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'phone-copy' },
    });
    // complete() auto-deletes on success; second attempt sees `invalid_code`.
    expect(second.statusCode).toBe(401);
    await app.close();
  });

  it('does not issue a token when the code is invalid', async () => {
    const { app, deviceTokens } = await buildApp({ tokenSeeds: [seed(32, 0xa1)] });
    await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'NOSUCHCD', device_name: 'phone' },
    });
    expect(deviceTokens.size()).toBe(0);
    await app.close();
  });
});

describe('GET /v1/pair/devices (task 4.67)', () => {
  it('returns empty devices list when none are paired', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/pair/devices' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ devices: [] });
    await app.close();
  });

  it('lists paired devices with full metadata (includes revoked)', async () => {
    const nowMs = 1_700_000_000_000;
    const { app, deviceTokens } = await buildApp({
      nowMsFn: () => nowMs,
      tokenSeeds: [seed(32, 0x01), seed(32, 0x02), seed(32, 0x03)],
    });
    const a = deviceTokens.issue({ deviceName: 'phone' });
    const b = deviceTokens.issue({ deviceName: 'laptop', role: 'user' });
    const c = deviceTokens.issue({ deviceName: 'agent-bot', role: 'agent' });
    deviceTokens.revoke(b.deviceId);

    const res = await app.inject({ method: 'GET', url: '/v1/pair/devices' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      devices: Array<{
        device_id: string;
        name: string;
        role: string;
        created_at: number;
        last_seen: number;
        revoked: boolean;
      }>;
    };
    expect(body.devices.map((d) => d.device_id)).toEqual([a.deviceId, b.deviceId, c.deviceId]);
    const revokedRow = body.devices.find((d) => d.device_id === b.deviceId)!;
    expect(revokedRow.revoked).toBe(true);
    const agentRow = body.devices.find((d) => d.device_id === c.deviceId)!;
    expect(agentRow.role).toBe('agent');
    expect(agentRow.name).toBe('agent-bot');
    expect(typeof agentRow.created_at).toBe('number');
    expect(typeof agentRow.last_seen).toBe('number');
    await app.close();
  });

  it('does NOT leak the token_hash field to the wire', async () => {
    const { app, deviceTokens } = await buildApp({ tokenSeeds: [seed(32, 0xf1)] });
    deviceTokens.issue({ deviceName: 'phone' });
    const res = await app.inject({ method: 'GET', url: '/v1/pair/devices' });
    const body = res.json() as { devices: Array<Record<string, unknown>> };
    expect(body.devices[0]).toBeDefined();
    expect(Object.keys(body.devices[0]!).sort()).toEqual(
      ['created_at', 'device_id', 'last_seen', 'name', 'revoked', 'role'].sort(),
    );
    await app.close();
  });
});

describe('End-to-end pair → list', () => {
  it('initiate → complete → list returns the new device', async () => {
    const { app } = await buildApp({
      codeSeeds: [seed(32, 0xd1)],
      tokenSeeds: [seed(32, 0xd2)],
    });
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/v1/pair/initiate',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })
    ).json() as { code: string };
    const complete = await app.inject({
      method: 'POST',
      url: '/v1/pair/complete',
      headers: { 'content-type': 'application/json' },
      payload: { code, device_name: 'phone' },
    });
    const { device_id } = complete.json() as { device_id: string };

    const list = await app.inject({ method: 'GET', url: '/v1/pair/devices' });
    const body = list.json() as { devices: Array<{ device_id: string }> };
    expect(body.devices.map((d) => d.device_id)).toEqual([device_id]);
    await app.close();
  });
});

describe('DELETE /v1/pair/devices/:deviceId (task 4.66)', () => {
  it('revokes a live device → 204 No Content + flips revoked flag', async () => {
    const { app, deviceTokens } = await buildApp({ tokenSeeds: [seed(32, 0x01)] });
    const { deviceId } = deviceTokens.issue({ deviceName: 'phone' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/pair/devices/${deviceId}`,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(deviceTokens.get(deviceId)!.revoked).toBe(true);
    await app.close();
  });

  it('double-revoke (idempotent) returns 204 the second time', async () => {
    const { app, deviceTokens } = await buildApp({ tokenSeeds: [seed(32, 0x02)] });
    const { deviceId } = deviceTokens.issue({ deviceName: 'phone' });
    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/pair/devices/${deviceId}`,
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/pair/devices/${deviceId}`,
    });
    expect(second.statusCode).toBe(204);
    await app.close();
  });

  it('unknown device → 404', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/pair/devices/ghost',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'device not found' });
    await app.close();
  });

  it('revoked device still appears in /v1/pair/devices with revoked=true', async () => {
    const { app, deviceTokens } = await buildApp({
      tokenSeeds: [seed(32, 0x03), seed(32, 0x04)],
    });
    const kept = deviceTokens.issue({ deviceName: 'laptop' });
    const revoked = deviceTokens.issue({ deviceName: 'phone' });
    await app.inject({
      method: 'DELETE',
      url: `/v1/pair/devices/${revoked.deviceId}`,
    });
    const list = await app.inject({ method: 'GET', url: '/v1/pair/devices' });
    const body = list.json() as {
      devices: Array<{ device_id: string; revoked: boolean }>;
    };
    const entries = Object.fromEntries(
      body.devices.map((d) => [d.device_id, d.revoked]),
    );
    expect(entries[kept.deviceId]).toBe(false);
    expect(entries[revoked.deviceId]).toBe(true);
    await app.close();
  });
});

describe('registerPairRoutes validation', () => {
  it('throws when nodeDid is empty', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    const pairingCodes = new PairingCodeRegistry();
    const deviceTokens = new DeviceTokenRegistry();
    expect(() =>
      registerPairRoutes(app, { pairingCodes, deviceTokens, nodeDid: '' }),
    ).toThrow(/nodeDid is required/);
    await app.close();
  });
});
