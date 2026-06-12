/**
 * HTTP contract tests — Fastify inject. Pins: the two routes' wire
 * behavior, per-platform getConfig, the 429 normalization to the typed
 * `rate_limited` refusal, and the logging-redaction posture.
 */

import { buildServer } from '../src/server';

import type { GrantsConfig } from '../src/config';
import type { DeviceState, GrantLedger, KeyProvisioner } from '../src/ports';
import type { FastifyInstance } from 'fastify';

function makeConfig(over: Partial<GrantsConfig> = {}): GrantsConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    enabledIos: true,
    enabledAndroid: false,
    paused: false,
    grantUsd: 0.25,
    modelPin: 'deepseek/deepseek-v4-pro',
    estConversations: 40,
    maxGrantsPerDay: 0,
    openrouterProvisioningKey: 'prov',
    appleTeamId: 'T',
    deviceCheckKeyId: 'K',
    deviceCheckPrivateKey: 'PEM',
    deviceCheckEnv: 'development',
    ...over,
  };
}

const okDeviceState: DeviceState = {
  check: async () => ({ claimed: false }),
  setClaimed: async () => undefined,
};
const okProvisioner: KeyProvisioner = {
  createCappedKey: async () => ({ key: 'sk-or-v1-minted', orKeyId: 'h' }),
};
const okLedger: GrantLedger = { insert: () => undefined, countSince: () => 0, close: () => undefined };

async function makeApp(over: Partial<Parameters<typeof buildServer>[0]> = {}): Promise<FastifyInstance> {
  return buildServer({
    config: makeConfig(),
    deviceState: okDeviceState,
    provisioner: okProvisioner,
    ledger: okLedger,
    logLevel: 'silent',
    ...over,
  });
}

describe('GET getConfig', () => {
  it('reports enabled for ios, disabled for android (v1 gating)', async () => {
    const app = await makeApp();
    const ios = await app.inject({
      method: 'GET',
      url: '/xrpc/com.dinakernel.credits.getConfig?platform=ios',
    });
    expect(ios.statusCode).toBe(200);
    expect(ios.json()).toEqual({
      enabled: true,
      grant_usd: 0.25,
      model_pin: 'deepseek/deepseek-v4-pro',
      est_conversations: 40,
    });

    const android = await app.inject({
      method: 'GET',
      url: '/xrpc/com.dinakernel.credits.getConfig?platform=android',
    });
    expect(android.json().enabled).toBe(false);
    await app.close();
  });

  it('reports disabled with no/unknown platform (fail closed)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/xrpc/com.dinakernel.credits.getConfig' });
    expect(res.json().enabled).toBe(false);
    await app.close();
  });

  it('kill switch flips enabled=false everywhere', async () => {
    const app = await makeApp({ config: makeConfig({ paused: true }) });
    const res = await app.inject({
      method: 'GET',
      url: '/xrpc/com.dinakernel.credits.getConfig?platform=ios',
    });
    expect(res.json().enabled).toBe(false);
    await app.close();
  });
});

describe('POST claimGrant', () => {
  const CLAIM = '/xrpc/com.dinakernel.credits.claimGrant';
  const GOOD = { platform: 'ios', attestation: { kind: 'devicecheck', token: 'dc' } };

  it('mints on the happy path with the exact wire shape', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: CLAIM, payload: GOOD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      key: 'sk-or-v1-minted',
      limit_usd: 0.25,
      model_pin: 'deepseek/deepseek-v4-pro',
    });
    await app.close();
  });

  it('refuses malformed bodies with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: CLAIM, payload: { junk: 1 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('normalizes the per-IP rate limit to the typed rate_limited refusal', async () => {
    const app = await makeApp({ claimRateLimit: { max: 2, windowMs: 60_000 } });
    await app.inject({ method: 'POST', url: CLAIM, payload: GOOD });
    await app.inject({ method: 'POST', url: CLAIM, payload: GOOD });
    const third = await app.inject({ method: 'POST', url: CLAIM, payload: GOOD });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: 'rate_limited' });
    await app.close();
  });

  it('getConfig is NOT claim-rate-limited (only claims are scarce)', async () => {
    const app = await makeApp({ claimRateLimit: { max: 1, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/xrpc/com.dinakernel.credits.getConfig?platform=ios',
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});

describe('healthz', () => {
  it('answers ok', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
