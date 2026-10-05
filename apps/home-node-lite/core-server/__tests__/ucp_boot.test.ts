/**
 * UCP at boot (docs/UCP_IMPLEMENTATION_PLAN.md §3.1, §3.5; test plan T-U1-26):
 * every node derives its UCP identity at boot, whatever its A2A configuration,
 * and holds it in memory only; the profile publisher's schedule starts only
 * when UCP is enabled and the node has a did:plc (its PDS), and close stops
 * it and leaves neither the identity nor the policy socket behind.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getUcpIdentity,
  getUcpSearchRuntime,
  getWorkflowService,
  ucpFetch,
  UcpPublisher,
} from '@dina/core';
import { kvList } from '@dina/core/kv';
import { resetCallerTypeState, resetMiddlewareState } from '@dina/core/runtime';

import { bootServer } from '../src/boot';

const PDS_IDENTITY = {
  did: 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa',
  handle: 'node.example',
  password: 'pw',
  email: 'n@example.org',
  pdsUrl: 'https://pds.example',
};

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'ucp-boot-'));
  process.env['DINA_VAULT_DIR'] = dir;
  process.env['DINA_CORE_HOST'] = '127.0.0.1';
  process.env['DINA_CORE_PORT'] = '0';
  process.env['DINA_LOG_LEVEL'] = 'silent';
  process.env['DINA_MSGBOX_ENABLED'] = 'false';
  // No A2A configuration at all: the UCP identity must not depend on it.
  delete process.env['DINA_A2A_PUBLIC_URL'];
  delete process.env['DINA_A2A_GATEWAY_DID'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  for (const [k, v] of Object.entries(originalEnv)) {
    if (typeof v === 'string') process.env[k] = v;
  }
  resetMiddlewareState();
  resetCallerTypeState();
  jest.restoreAllMocks();
});

it('derives the UCP identity at boot with UCP off and no A2A configuration, and drops it and the socket at close', async () => {
  const publish = jest.spyOn(UcpPublisher.prototype, 'publish');
  const booted = await bootServer();
  let label = '';
  try {
    const identity = getUcpIdentity();
    expect(identity).not.toBeNull();
    label = identity?.label ?? '';
    expect(label).toMatch(/^[a-z2-7]{26}$/);
    // No publisher has named the generation in use (UCP is off): nothing would be signed.
    expect(identity?.signingKey()).toBeNull();
    expect(identity?.keyAt(0).jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    // UCP is off: nothing is published.
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await booted.app.close();
  }
  expect(getUcpIdentity()).toBeNull();
  // And the policy socket is gone: only an uninstalled socket answers `unavailable`
  // (an installed one would fail this name in DNS instead).
  const after = await ucpFetch({
    method: 'GET',
    url: 'https://merchant.example/.well-known/ucp',
    headers: {},
    accept: 'json',
    minTls: 'TLSv1.2',
    readAuthErrorBodies: false,
    maxResponseBytes: 65_536,
    timeoutMs: 1_000,
  });
  expect(after).toEqual({ ok: false, error: 'unavailable', sent: false });
}, 60_000);

it('the same seed gives the same identity on the next boot', async () => {
  const first = await bootServer();
  const label = getUcpIdentity()?.label;
  const kid = getUcpIdentity()?.keyAt(0).jwk.kid;
  await first.app.close();
  const second = await bootServer();
  try {
    expect(getUcpIdentity()?.label).toBe(label);
    expect(getUcpIdentity()?.keyAt(0).jwk.kid).toBe(kid);
  } finally {
    await second.app.close();
  }
}, 60_000);

it('UCP on without a did:plc: no publisher, so no search either', async () => {
  process.env['DINA_UCP_ENABLED'] = 'true';
  const publish = jest.spyOn(UcpPublisher.prototype, 'publish');
  const booted = await bootServer();
  try {
    await new Promise((r) => setTimeout(r, 50));
    expect(publish).not.toHaveBeenCalled();
    expect(getUcpSearchRuntime()).toBeNull();
  } finally {
    await booted.app.close();
  }
}, 60_000);

describe('with a PDS (a did:plc)', () => {
  const withPdsIdentity = () => {
    writeFileSync(
      join(dir, 'pds_identity.json'),
      JSON.stringify({ ...PDS_IDENTITY, dinaUpdateApplied: true }),
    );
    process.env['DINA_PDS_PROVISION'] = '1';
    process.env['DINA_PDS_HANDLE'] = PDS_IDENTITY.handle;
    process.env['DINA_PDS_URL'] = PDS_IDENTITY.pdsUrl;
    process.env['DINA_PLC_URL'] = 'https://plc.example';
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }),
      );
  };

  it('UCP off: no publisher runs', async () => {
    withPdsIdentity();
    const publish = jest.spyOn(UcpPublisher.prototype, 'publish');
    const booted = await bootServer();
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(publish).not.toHaveBeenCalled();
      // Nor does merchant search: its routes answer ucp_unavailable.
      expect(getUcpSearchRuntime()).toBeNull();
    } finally {
      await booted.app.close();
    }
  }, 60_000);

  it('UCP on: the schedule publishes once at boot under the node’s did:plc and the configured host, and close stops it', async () => {
    withPdsIdentity();
    process.env['DINA_UCP_ENABLED'] = 'true';
    process.env['DINA_UCP_PROFILE_HOST'] = 'ucp.test.example';
    const seen: { did: string; host: string }[] = [];
    const publish = jest
      .spyOn(UcpPublisher.prototype, 'publish')
      .mockImplementation(async function (this: UcpPublisher) {
        const self = this as unknown as { did: string; profileHost: string };
        seen.push({ did: self.did, host: self.profileHost });
        // The publisher's own record is written, as a real run writes it.
        await this.state();
        return 'unreachable';
      });
    // The schedule's timers: after an unreachable host it sets its first retry (1 minute);
    // close must clear it. Timers are recorded only once the boot publish has run.
    const retries: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms);
      if (ms === 60_000 && publish.mock.calls.length > 0) retries.push(handle);
      return handle;
    }) as typeof setTimeout);
    const realClearTimeout = globalThis.clearTimeout;
    jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      handle?: Parameters<typeof clearTimeout>[0],
    ) => {
      cleared.add(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout);
    const booted = await bootServer();
    try {
      for (let i = 0; i < 50 && publish.mock.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(publish).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ did: PDS_IDENTITY.did, host: 'ucp.test.example' }]);
      // Merchant search runs beside the publisher, on the live workflow service: the one
      // the workflow plane installed after the boot's first, where the owner's cards live.
      const live = getWorkflowService();
      expect(live).not.toBeNull();
      expect(getUcpSearchRuntime()?.workflow).toBe(live);
      // The identity is held in memory only: no stored key-value row, read through the
      // open (decrypted) store, names the label or the key; the publisher's record is there.
      const identity = getUcpIdentity();
      if (identity === null) throw new Error('no identity');
      const rows = await kvList();
      expect(rows.map((r) => r.key)).toContain('ucp:publisher');
      for (const row of rows) {
        expect(row.value).not.toContain(identity.label);
        expect(row.value).not.toContain(identity.keyAt(0).jwk.x);
      }
      for (let i = 0; i < 50 && retries.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(retries.length).toBeGreaterThan(0);
    } finally {
      await booted.app.close();
    }
    for (const handle of retries) expect(cleared.has(handle)).toBe(true);
    expect(getUcpIdentity()).toBeNull();
    expect(getUcpSearchRuntime()).toBeNull();
  }, 60_000);
});
