/**
 * Claim pipeline — every gate, every refusal, and the two deliberate
 * ordering tradeoffs (provision-before-bits; never-block-on-ledger).
 */

import { processClaim } from '../src/claim';

import type { ClaimDeps } from '../src/claim';
import type { GrantsConfig } from '../src/config';
import type { DeviceState, GrantLedger, KeyProvisioner } from '../src/ports';

function makeConfig(over: Partial<GrantsConfig> = {}): GrantsConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    enabledIos: true,
    enabledAndroid: false,
    paused: false,
    devAllowAndroidClaim: false,
    grantUsd: 0.25,
    modelPin: 'deepseek/deepseek-v4-pro',
    estConversations: 40,
    maxGrantsPerDay: 100,
    openrouterProvisioningKey: 'prov-key',
    appleTeamId: 'TEAM',
    deviceCheckKeyId: 'KEY',
    deviceCheckPrivateKey: 'PEM',
    deviceCheckEnv: 'development',
    androidPackageName: 'com.dinakernel.mobile',
    googleServiceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
    googleServiceAccountPrivateKey: 'PEM',
    ...over,
  };
}

class FakeDeviceState implements DeviceState {
  claimed = false;
  invalid = false;
  unavailable = false;
  setClaimedCalls = 0;
  failSetClaimed = false;
  async check(): Promise<'invalid' | 'unavailable' | { claimed: boolean }> {
    if (this.unavailable) return 'unavailable';
    if (this.invalid) return 'invalid';
    return { claimed: this.claimed };
  }
  async setClaimed(): Promise<void> {
    this.setClaimedCalls += 1;
    if (this.failSetClaimed) throw new Error('apple down');
    this.claimed = true;
  }
}

class FakeProvisioner implements KeyProvisioner {
  calls: { limitUsd: number; label: string }[] = [];
  fail = false;
  async createCappedKey(args: { limitUsd: number; label: string }) {
    this.calls.push(args);
    if (this.fail) throw new Error('openrouter down');
    return { key: 'sk-or-v1-minted', orKeyId: 'orkey-1' };
  }
}

class FakeLedger implements GrantLedger {
  rows: { grantId: string; orKeyId: string; platform: string; grantedAt: number }[] = [];
  countSinceValue = 0;
  failInsert = false;
  insert(row: { grantId: string; orKeyId: string; platform: string; grantedAt: number }): void {
    if (this.failInsert) throw new Error('disk full');
    this.rows.push(row);
  }
  lastCountSinceArg: number | null = null;
  countSince(sinceMs: number): number {
    this.lastCountSinceArg = sinceMs;
    return this.countSinceValue;
  }
  close(): void {
    return undefined;
  }
}

function makeDeps(over: Partial<ClaimDeps> = {}): ClaimDeps & {
  deviceState: FakeDeviceState;
  provisioner: FakeProvisioner;
  ledger: FakeLedger;
} {
  // One shared fake stands in for BOTH platforms' backends, so a test
  // pokes `deps.deviceState` regardless of the request's platform.
  const deviceState = new FakeDeviceState();
  return {
    config: makeConfig(),
    deviceStates: { ios: deviceState, android: deviceState },
    provisioner: new FakeProvisioner(),
    ledger: new FakeLedger(),
    now: () => 1_750_000_000_000,
    deviceState,
    ...over,
  } as ClaimDeps & {
    deviceState: FakeDeviceState;
    provisioner: FakeProvisioner;
    ledger: FakeLedger;
  };
}

const GOOD_BODY = {
  platform: 'ios',
  attestation: { kind: 'devicecheck', token: 'dc-token' },
};

describe('processClaim — happy path', () => {
  it('mints a key, sets the bit, writes the ledger, returns the wire shape', async () => {
    const deps = makeDeps();
    const out = await processClaim(deps, GOOD_BODY);

    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      key: 'sk-or-v1-minted',
      limit_usd: 0.25,
      model_pin: 'deepseek/deepseek-v4-pro',
    });
    expect(deps.deviceState.setClaimedCalls).toBe(1);
    expect(deps.ledger.rows).toHaveLength(1);
    expect(deps.ledger.rows[0].platform).toBe('ios');
    // Anonymous-claim invariant: the provisioner label carries the
    // grant id only — nothing identity- or device-bearing.
    expect(deps.provisioner.calls[0].label).toMatch(/^grant-[0-9a-f-]{36}$/);
    expect(deps.provisioner.calls[0].limitUsd).toBe(0.25);
  });
});

describe('processClaim — gate order and refusals', () => {
  it('400 bad_request on malformed body (never throws)', async () => {
    const out = await processClaim(makeDeps(), { nonsense: true });
    expect(out).toEqual({ status: 400, body: { error: 'bad_request' } });
  });

  it('platform_disabled for android while android is off — BEFORE attestation runs', async () => {
    const deps = makeDeps();
    const out = await processClaim(deps, {
      platform: 'android',
      attestation: { kind: 'play_integrity', token: 't' },
    });
    expect(out).toEqual({ status: 403, body: { error: 'platform_disabled' } });
    expect(deps.deviceState.setClaimedCalls).toBe(0);
  });

  it('grants_paused when the kill switch is on', async () => {
    const deps = makeDeps({ config: makeConfig({ paused: true }) });
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 503, body: { error: 'grants_paused' } });
  });

  it('grants_paused when the daily ceiling is reached (automatic pause)', async () => {
    const deps = makeDeps();
    deps.ledger.countSinceValue = 100; // == maxGrantsPerDay
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 503, body: { error: 'grants_paused' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('daily ceiling of 0 means unlimited', async () => {
    const deps = makeDeps({ config: makeConfig({ maxGrantsPerDay: 0 }) });
    deps.ledger.countSinceValue = 1_000_000;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out.status).toBe(200);
  });

  it('attestation_failed for unsupported kinds on ios (app_attest is a target, not v1)', async () => {
    const out = await processClaim(makeDeps(), {
      platform: 'ios',
      attestation: { kind: 'app_attest', key_id: 'k', assertion: 'a', client_data: 'c' },
    });
    expect(out).toEqual({ status: 403, body: { error: 'attestation_failed' } });
  });

  it('attestation backend outage → TRANSIENT 503 attestation_unavailable (never bricks the device)', async () => {
    const deps = makeDeps();
    deps.deviceState.unavailable = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 503, body: { error: 'attestation_unavailable' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('the daily ceiling queries the trailing 24h window, not lifetime totals', async () => {
    const deps = makeDeps();
    await processClaim(deps, GOOD_BODY);
    expect(deps.ledger.lastCountSinceArg).toBe(1_750_000_000_000 - 24 * 60 * 60 * 1000);
  });

  it('attestation_failed for an invalid device token', async () => {
    const deps = makeDeps();
    deps.deviceState.invalid = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 403, body: { error: 'attestation_failed' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('already_claimed when the device bit is set — and does NOT provision', async () => {
    const deps = makeDeps();
    deps.deviceState.claimed = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 409, body: { error: 'already_claimed' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });
});

describe('processClaim — dev-only Android claim gate (GRANTS_DEV_ALLOW_ANDROID)', () => {
  const ANDROID_BODY = {
    platform: 'android',
    attestation: { kind: 'devicecheck', token: 'fake-android' },
  };

  it('mints for an android devicecheck claim when the dev flag AND android are on', async () => {
    const deps = makeDeps({
      config: makeConfig({ enabledAndroid: true, devAllowAndroidClaim: true }),
    });
    const out = await processClaim(deps, ANDROID_BODY);
    expect(out.status).toBe(200);
    expect(deps.ledger.rows[0].platform).toBe('android');
  });

  it('still refuses an android claim when the dev flag is OFF (production path intact)', async () => {
    // Android enabled but the dev gate closed: the attestation check
    // rejects the non-iOS claim exactly as before this flag existed.
    const deps = makeDeps({
      config: makeConfig({ enabledAndroid: true, devAllowAndroidClaim: false }),
    });
    const out = await processClaim(deps, ANDROID_BODY);
    expect(out).toEqual({ status: 403, body: { error: 'attestation_failed' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('the dev flag does not open a non-devicecheck android kind (play_integrity still refused)', async () => {
    const deps = makeDeps({
      config: makeConfig({ enabledAndroid: true, devAllowAndroidClaim: true }),
    });
    const out = await processClaim(deps, {
      platform: 'android',
      attestation: { kind: 'play_integrity', token: 't' },
    });
    expect(out).toEqual({ status: 403, body: { error: 'attestation_failed' } });
  });
});

describe('processClaim — real Android (Play Integrity)', () => {
  const ANDROID_PI = {
    platform: 'android',
    attestation: { kind: 'play_integrity', token: 'pi-token' },
  };

  it('mints for a play_integrity claim when android is enabled (no dev flag)', async () => {
    const deps = makeDeps({ config: makeConfig({ enabledAndroid: true }) });
    const out = await processClaim(deps, ANDROID_PI);
    expect(out.status).toBe(200);
    expect(deps.ledger.rows[0].platform).toBe('android');
    // Device Recall bit gets written on a fresh grant.
    expect(deps.deviceState.setClaimedCalls).toBe(1);
  });

  it('refuses a devicecheck token on real android — only play_integrity is accepted', async () => {
    const deps = makeDeps({ config: makeConfig({ enabledAndroid: true }) });
    const out = await processClaim(deps, {
      platform: 'android',
      attestation: { kind: 'devicecheck', token: 'x' },
    });
    expect(out).toEqual({ status: 403, body: { error: 'attestation_failed' } });
  });

  it('already_claimed when the Device Recall bit is set — and does NOT provision', async () => {
    const deps = makeDeps({ config: makeConfig({ enabledAndroid: true }) });
    deps.deviceState.claimed = true;
    const out = await processClaim(deps, ANDROID_PI);
    expect(out).toEqual({ status: 409, body: { error: 'already_claimed' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('a play_integrity claim while android is OFF is platform_disabled (before attestation)', async () => {
    const deps = makeDeps(); // enabledAndroid defaults false
    const out = await processClaim(deps, ANDROID_PI);
    expect(out).toEqual({ status: 403, body: { error: 'platform_disabled' } });
    expect(deps.deviceState.setClaimedCalls).toBe(0);
  });

  it('a transient Play Integrity outage → 503 attestation_unavailable (device retries)', async () => {
    const deps = makeDeps({ config: makeConfig({ enabledAndroid: true }) });
    deps.deviceState.unavailable = true;
    const out = await processClaim(deps, ANDROID_PI);
    expect(out).toEqual({ status: 503, body: { error: 'attestation_unavailable' } });
    expect(deps.provisioner.calls).toHaveLength(0);
  });

  it('an enabled platform with no backend wired → transient, never a hard refusal', async () => {
    const deps = makeDeps({ config: makeConfig({ enabledAndroid: true }) });
    // Simulate a boot misconfig: android enabled but no backend in the map.
    (deps as unknown as { deviceStates: Record<string, unknown> }).deviceStates = {};
    const out = await processClaim(deps, ANDROID_PI);
    expect(out).toEqual({ status: 503, body: { error: 'attestation_unavailable' } });
  });
});

describe('processClaim — failure-ordering tradeoffs (spec §pipeline)', () => {
  it('provisioning failure → 503, and the device bit is NOT burned', async () => {
    const deps = makeDeps();
    deps.provisioner.fail = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out).toEqual({ status: 503, body: { error: 'provisioning_unavailable' } });
    // The device can claim again later — its once-only was not spent.
    expect(deps.deviceState.setClaimedCalls).toBe(0);
  });

  it('bit-set failure AFTER provisioning still returns the key (bounded double-grant, logged)', async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      log: { info: () => undefined, warn: () => undefined, error: (m) => errors.push(m) },
    });
    deps.deviceState.failSetClaimed = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out.status).toBe(200);
    expect(errors.some((m) => m.includes('double-grant'))).toBe(true);
  });

  it('ledger failure never blocks a granted user', async () => {
    const deps = makeDeps();
    deps.ledger.failInsert = true;
    const out = await processClaim(deps, GOOD_BODY);
    expect(out.status).toBe(200);
  });
});

describe('processClaim — privacy', () => {
  it('log lines never contain the token or the minted key', async () => {
    const lines: string[] = [];
    const collect = (m: string, f?: Record<string, unknown>): void => {
      lines.push(m + JSON.stringify(f ?? {}));
    };
    const deps = makeDeps({ log: { info: collect, warn: collect, error: collect } });
    await processClaim(deps, GOOD_BODY);
    const all = lines.join('\n');
    expect(all).not.toContain('dc-token');
    expect(all).not.toContain('sk-or-v1-minted');
  });
});
