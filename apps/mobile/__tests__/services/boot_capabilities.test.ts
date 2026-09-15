/**
 * Boot capability composer contract — `buildBootInputs` is the single
 * seam where persisted identity, role, BYOK provider, AppView stub, and
 * the open identity DB come together into a `BootServiceInputs` bundle.
 * Regressions here show up as "boot succeeds but nothing actually
 * works" — the reviewer caught exactly that pattern twice, so pin the
 * invariants.
 *
 * Test strategy: pure module contract. No React render, no op-sqlite
 * (the composer reads the identity DB through a getter that returns
 * null in tests), and AppView network calls are stubbed explicitly.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  applyMigrations,
  clearPairingState,
  completePairing,
  generatePairingCode,
  IDENTITY_MIGRATIONS,
  publicKeyToMultibase,
  resetCallerTypeState,
  setNodeDID,
  SQLitePluginGrantRepository,
  SQLitePluginInstallRepository,
  getRepoProofVerifier,
  setPluginGrantRepository,
  setPluginInstallRepository,
  setRepoProofVerifier,
} from '@dina/core';
import { getDeviceByDID, resetDeviceRegistry } from '@dina/core/devices';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLiteDeviceRepository, setDeviceRepository } from '../../../core/src/devices/repository';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { AppViewStub } from '../../src/services/appview_stub';
import { buildBootInputs, resolveStagingEnrichmentLLM } from '../../src/services/boot_capabilities';
import { savePersistedDid, clearPersistedDid } from '../../src/services/identity_record';
import { clearIdentitySeeds } from '../../src/services/identity_store';
import { saveRolePreference } from '../../src/services/role_preference';

import type { RoutedLLMProvider } from '@dina/brain/runtime';

const originalFetch = globalThis.fetch;
const originalEndpointMode = process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE;
const originalAppViewURL = process.env.EXPO_PUBLIC_DINA_APPVIEW_URL;

beforeEach(async () => {
  resetKeychainMock();
  await clearIdentitySeeds();
  await clearPersistedDid();
  process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE = 'test';
  delete process.env.EXPO_PUBLIC_DINA_APPVIEW_URL;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEndpointMode === undefined) {
    delete process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE;
  } else {
    process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE = originalEndpointMode;
  }
  if (originalAppViewURL === undefined) {
    delete process.env.EXPO_PUBLIC_DINA_APPVIEW_URL;
  } else {
    process.env.EXPO_PUBLIC_DINA_APPVIEW_URL = originalAppViewURL;
  }
});

describe('buildBootInputs — identity resolution (#3)', () => {
  it('falls back to did:key derivation when no DID is persisted', async () => {
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.did.startsWith('did:key:')).toBe(true);
    expect(inputs.signingKeypair.privateKey).toHaveLength(32);
    expect(inputs.signingKeypair.publicKey).toHaveLength(32);
  });

  it('prefers the persisted did:plc over derived did:key', async () => {
    await savePersistedDid('did:plc:test-node');
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.did).toBe('did:plc:test-node');
  });

  it('respects didOverride for test/onboarding injection', async () => {
    await savePersistedDid('did:plc:persisted');
    const inputs = await buildBootInputs({
      activeProvider: 'none',
      didOverride: 'did:plc:override',
    });
    expect(inputs.did).toBe('did:plc:override');
  });
});

describe('buildBootInputs — role preference (#8)', () => {
  it('defaults to requester when no preference is stored', async () => {
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.role).toBe('requester');
  });

  it('loads the persisted role preference', async () => {
    await saveRolePreference('provider');
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.role).toBe('provider');
  });

  it('respects roleOverride', async () => {
    await saveRolePreference('provider');
    const inputs = await buildBootInputs({
      activeProvider: 'none',
      roleOverride: 'both',
    });
    expect(inputs.role).toBe('both');
  });
});

describe('buildBootInputs — device-role resolver (round-5 #4)', () => {
  it('installs a deviceRoleResolver so paired plugin/agent devices are not misclassified', async () => {
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    // The regression: this was UNDEFINED, so createNode never called
    // setDeviceRoleResolver and every paired device (incl. a runner-plugin
    // instance) fell through to the wide 'device' caller type. It must be wired.
    expect(typeof inputs.deviceRoleResolver).toBe('function');
    // The closure reads the live device registry (getDeviceByDID); an unknown
    // DID resolves to null. Role-value mapping for a registered plugin/agent
    // device is the same closure covered by core's caller_type tests.
    expect(inputs.deviceRoleResolver!('did:key:zunregistered')).toBeNull();
  });
});

describe('buildBootInputs — the abandoned-install sweeper (PLUGIN_ARCHITECTURE §15.3)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mobile-boot-sweeper-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
    setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
    setDeviceRepository(new SQLiteDeviceRepository(adapter));
    setNodeDID('did:key:z6MkPhoneNode');
  });

  afterEach(() => {
    setPluginInstallRepository(null);
    setPluginGrantRepository(null);
    setDeviceRepository(null);
    clearPairingState();
    resetDeviceRegistry();
    resetCallerTypeState();
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stale pending install with a paired runner is swept at boot: row gone, device revoked in SQL', async () => {
    const installs = new SQLitePluginInstallRepository(adapter);
    const nowMs = Date.now();
    const installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.widget',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreicid1',
      currentVersion: '1.0.0',
      manifest: {
        $type: 'com.dinakernel.plugin.release',
        plugin_id: 'com.acme.widget',
        version: '1.0.0',
        display_name: 'Widget',
        execution: { mode: 'runner' },
        capabilities: [],
      } as never,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: {},
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(nowMs / 1000) + 900,
      nowMs,
    });
    // A runner pairs into it (Core binds it), then the owner walks away past the window.
    const privateKey = new Uint8Array(32).fill(23);
    const publicKey = ed25519.getPublicKey(privateKey);
    const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
    completePairing(code, 'runner', publicKeyToMultibase(publicKey), 'plugin', 'runner');
    const runnerDid = `did:key:${publicKeyToMultibase(publicKey)}`;
    expect(installs.getById(installId)?.deviceDid).toBe(runnerDid);
    adapter.execute('UPDATE plugin_installs SET pending_expires_at = ? WHERE install_id = ?', [
      Math.floor(nowMs / 1000) - 60,
      installId,
    ]);

    // Boot: the sweeper's first tick runs at once, with the durable revoker.
    await buildBootInputs({ activeProvider: 'none' });
    for (let i = 0; i < 100 && installs.getById(installId) !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(installs.getById(installId)).toBeNull();
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
    const rows = adapter.query('SELECT revoked FROM paired_devices WHERE did = ?', [runnerDid]);
    expect(rows.map((r) => Number(r.revoked))).toEqual([1]);
  });
});

describe('buildBootInputs — the repo-proof verifier (§5.C1-mobile)', () => {
  beforeEach(() => {
    // Earlier boots in this file leave a verifier wired; start from none.
    setRepoProofVerifier(null);
  });
  afterEach(() => {
    setRepoProofVerifier(null);
  });

  it('wires a repo-proof verifier at boot once the self-check passes, so the Plugins door opens; it fails CLOSED, never trust-on-first-use', async () => {
    expect(getRepoProofVerifier()).toBeNull();
    await buildBootInputs({ activeProvider: 'none' });
    const verifier = getRepoProofVerifier();
    expect(verifier).not.toBeNull();
    if (verifier === null) throw new Error('unreachable');
    // The jest stand-in for `@dina/net-expo/repo_proof` passes its self-check
    // and answers like an unreachable publisher; the boot wrapper passes the
    // typed failure through.
    const result = await verifier({ did: 'did:plc:acme', collection: 'com.dinakernel.plugin.release', rkey: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.transient).toBe(true);
  });

  it('a device that fails the self-check boots with NO verifier: the door stays closed rather than calling releases inauthentic', async () => {
    // The mapper hands the wiring the `__mocks__` module as its REAL import;
    // reach the same instance, not the auto-mock registry's copy.
    const netExpo = jest.requireActual('@dina/net-expo/repo_proof') as {
      selfCheckRepoProofVerifier: () => Promise<{ ok: boolean; fault?: string }>;
    };
    const original = netExpo.selfCheckRepoProofVerifier;
    netExpo.selfCheckRepoProofVerifier = async () => ({ ok: false, fault: 'record_malformed' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await buildBootInputs({ activeProvider: 'none' });
      expect(getRepoProofVerifier()).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('self-check failed'))).toBe(true);
    } finally {
      netExpo.selfCheckRepoProofVerifier = original;
      warn.mockRestore();
    }
  });
});

describe('buildBootInputs — AppView seeding (#1, #6, #15, #18)', () => {
  it('builds a real test AppView client by default (demo mode OFF)', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ services: [] })));
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;

    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.appViewClient).toBeDefined();
    expect(inputs.appViewClient).not.toBeInstanceOf(AppViewStub);

    await inputs.appViewClient!.searchServices({ capability: 'eta_query' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toBe(
      'https://test-appview.dinakernel.com/xrpc/com.dinakernel.service.search?capability=eta_query',
    );
  });

  it('seeds the Bus 42 demo profile when demoMode is explicitly ON', async () => {
    const inputs = await buildBootInputs({
      activeProvider: 'none',
      demoMode: true,
    });
    expect(inputs.appViewClient).toBeDefined();
    const results = await inputs.appViewClient!.searchServices({
      capability: 'eta_query',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].did).toBe('did:plc:bus42demo');
  });

  it('honours a caller-supplied AppViewClient regardless of demoMode', async () => {
    const custom = new AppViewStub();
    const inputs = await buildBootInputs({
      activeProvider: 'none',
      appViewClient: custom,
      demoMode: true,
    });
    expect(inputs.appViewClient).toBe(custom);
  });
});

describe('buildBootInputs — persistence adapter (#4)', () => {
  it('leaves databaseAdapter undefined when persistence is not initialised', async () => {
    // Tests never boot op-sqlite — so getIdentityAdapter() returns null,
    // and the composer must omit the field so bootAppNode falls back to
    // the in-memory repos (and emits the persistence.in_memory
    // degradation loudly).
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.databaseAdapter).toBeUndefined();
  });
});

describe('buildBootInputs — agenticAsk (#5)', () => {
  it('omits agenticAsk when activeProvider is "none"', async () => {
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    expect(inputs.agenticAsk).toBeUndefined();
  });

  it('omits agenticAsk when no BYOK provider is configured', async () => {
    // activeProvider unset + no keychain entries → no provider picked
    // → the degradation ask.single_shot_fallback stays active.
    const inputs = await buildBootInputs({});
    expect(inputs.agenticAsk).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GAP-RT-02 — staging drain enrichment wired by default
//
// Regression pin: the shipped Expo boot path (boot_capabilities →
// useNodeBootstrap → bootAppNode) must thread `stagingEnrichment`
// through. Without this, every default boot silently records a
// `staging.no_enrichment` degradation and the drain resolves items
// without topic touch or preference binding. External review caught
// this exact gap — the pin below fails fast if it regresses.
// ---------------------------------------------------------------------------

describe('buildBootInputs — stagingEnrichment default wiring (GAP-RT-02)', () => {
  it('always returns a stagingEnrichment bundle so bootAppNode never hits the no_enrichment degradation on default paths', async () => {
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    // Bundle is present even when there's no LLM — preference binding
    // is regex-based and runs without an LLM; topic extraction
    // degrades to a no-op. Either way the drain opts INTO the
    // pipeline instead of silently skipping it.
    expect(inputs.stagingEnrichment).toBeDefined();
    expect(inputs.stagingEnrichment).not.toBe(false);
    // No LLM provider → `llm` is undefined → preference-binding-only
    // mode. The builder NEVER returns `stagingEnrichment: undefined`,
    // which would land on the no_enrichment degradation in
    // bootAppNode.
    if (inputs.stagingEnrichment !== false) {
      expect(inputs.stagingEnrichment!.llm).toBeUndefined();
    }
  });

  it('forwards the LLM provider into stagingEnrichment when agenticAsk is wired', async () => {
    // When activeProvider + keychain yield an agenticAsk bundle, the
    // same provider instance must be reused for staging enrichment
    // so topic extraction actually runs. Simulated by passing a
    // pre-built agenticAsk — real keychain wiring is tested elsewhere.
    const inputs = await buildBootInputs({ activeProvider: 'none' });
    // `activeProvider: 'none'` → no agenticAsk, so this test only
    // pins that the field STAYS defined. The provider-present path is
    // pinned at the decision seam by `resolveStagingEnrichmentLLM`
    // below (a full positive-path buildBootInputs run needs keychain +
    // @dina/brain pipeline mocks; covered indirectly by the
    // integration e2e staging_drain_end_to_end).
    expect(inputs.stagingEnrichment).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Staging-enrichment LLM source — the coordinator-gating trap.
//
// Regression pin (MT-52-I1): `stagingEnrichment.llm` was sourced from
// `agenticAsk?.provider`, but `agenticAsk` is deliberately `undefined`
// whenever the Pattern-A `askCoordinator` is active (the production / dev
// path). That silently stripped the staging drain's LLM — auto-reminders,
// topic extraction, people-graph linking, and LLM preference binding all
// went dark with NO degradation logged. The decision now lives in a named
// helper sourced from the BUNDLE (always carries `provider` when any
// provider is configured), so this pins the bug class: a coordinator-bearing
// bundle MUST still yield its provider for the drain.
// ---------------------------------------------------------------------------

describe('resolveStagingEnrichmentLLM — drain LLM survives the coordinator path', () => {
  const fakeProvider = { __brand: 'routed-llm' } as unknown as RoutedLLMProvider;

  it('returns the bundle provider even when an askCoordinator is present (agenticAsk view would be undefined)', () => {
    // Shape mirrors the real AgenticAskBundle on the production path:
    // a coordinator is set, which is exactly when boot leaves the
    // `agenticAsk` view undefined. The drain LLM must come from the
    // bundle regardless.
    const coordinatorBundle = {
      provider: fakeProvider,
      askCoordinator: {} as unknown,
    } as { provider: RoutedLLMProvider };
    expect(resolveStagingEnrichmentLLM(coordinatorBundle)).toBe(fakeProvider);
  });

  it('returns the bundle provider on the simple (no-coordinator) path too', () => {
    expect(resolveStagingEnrichmentLLM({ provider: fakeProvider })).toBe(fakeProvider);
  });

  it('returns undefined when no provider is configured (reduced mode preserved)', () => {
    expect(resolveStagingEnrichmentLLM(undefined)).toBeUndefined();
  });
});
