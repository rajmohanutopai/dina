/**
 * bootAppNode composition tests.
 *
 * Issue #17: prior coverage exercised `createNode` directly but nothing
 * asserted that `bootAppNode` — the shipped boot wrapper — composes
 * degradations correctly, threads optional capability layers through,
 * or runs the start-and-cleanup-on-failure path. This suite pins those
 * invariants.
 */

import { bootAppNode, type BootServiceInputs } from '../../src/services/boot_service';
import { InMemoryDatabaseAdapter } from '../../../core/src/storage/db_adapter';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';
import { getMemoryService, setMemoryService } from '../../../core/src/memory/service';

const SEED = TEST_ED25519_SEED;
const PUB = getPublicKey(SEED);
const DID_PLC = 'did:plc:boot-test';

function baseInputs(overrides: Partial<BootServiceInputs> = {}): BootServiceInputs {
  return {
    did: DID_PLC,
    signingKeypair: { privateKey: SEED, publicKey: PUB },
    coreGlobals: false,
    globalWiring: false,
    logger: () => {
      /* quiet in tests */
    },
    ...overrides,
  } as BootServiceInputs;
}

describe('bootAppNode — boots + returns a live node', () => {
  it('starts a node and reports degradations for every missing optional dep', async () => {
    const { node, degradations } = await bootAppNode(baseInputs());
    try {
      expect(node.did).toBe(DID_PLC);
      const codes = degradations.map((d) => d.code);
      // Missing: SQLite, AppView, MsgBox, agenticAsk, sendD2D.
      // Identity is did:plc so NO identity.did_key degradation.
      // No appViewClient passed → `discovery.no_appview` (not
      // `discovery.stub`; that code is reserved for the demo-mode
      // AppViewStub path).
      expect(codes).toEqual(
        expect.arrayContaining([
          'persistence.in_memory',
          'discovery.no_appview',
          'transport.sendd2d.noop',
          'transport.msgbox.missing',
          'ask.single_shot_fallback',
        ]),
      );
      expect(codes).not.toContain('identity.did_key');
      expect(codes).not.toContain('discovery.stub');
    } finally {
      await node.dispose();
    }
  });

  it('supplying a DatabaseAdapter removes the persistence degradation', async () => {
    const { node, degradations } = await bootAppNode(
      baseInputs({
        databaseAdapter: new InMemoryDatabaseAdapter(),
      }),
    );
    try {
      const codes = degradations.map((d) => d.code);
      expect(codes).not.toContain('persistence.in_memory');
    } finally {
      await node.dispose();
    }
  });

  it('did:key identity records the identity.did_key degradation', async () => {
    // A did:key DID triggers the scaffolding-only warning so the UI
    // can show "not a publishable identity" in the banner.
    const didKey = 'did:key:z6Mkfake';
    const { node, degradations } = await bootAppNode(baseInputs({ did: didKey }));
    try {
      const codes = degradations.map((d) => d.code);
      expect(codes).toContain('identity.did_key');
    } finally {
      await node.dispose();
    }
  });

  it('supplying a real AppView client removes the discovery degradation', async () => {
    const appViewClient = { searchServices: async () => [] };
    const { node, degradations } = await bootAppNode(baseInputs({ appViewClient }));
    try {
      const codes = degradations.map((d) => d.code);
      expect(codes).not.toContain('discovery.no_appview');
      expect(codes).not.toContain('discovery.stub');
    } finally {
      await node.dispose();
    }
  });

  it('provider role without a local runner flags execution.no_runner', async () => {
    const { node, degradations } = await bootAppNode(baseInputs({ role: 'provider' }));
    try {
      expect(degradations.map((d) => d.code)).toContain('execution.no_runner');
    } finally {
      await node.dispose();
    }
  });

  it('provider role with a local runner does NOT flag execution.no_runner', async () => {
    const { node, degradations } = await bootAppNode(
      baseInputs({
        role: 'provider',
        localDelegationRunner: async () => ({ ok: true }),
      }),
    );
    try {
      expect(degradations.map((d) => d.code)).not.toContain('execution.no_runner');
    } finally {
      await node.dispose();
    }
  });

  it('installs a module-global MemoryService (WM-CORE-10)', async () => {
    // Cold boot must wire the MemoryService so /v1/memory/toc is
    // reachable. The ToC returns [] when no personas are unlocked —
    // that's a live-service signal, not a 503.
    setMemoryService(null); // ensure a previous test didn't leak one
    const { node } = await bootAppNode(baseInputs());
    try {
      const svc = getMemoryService();
      expect(svc).not.toBeNull();
      // With no personas wired, an empty ToC is the expected output.
      expect(await svc!.toc(undefined, 10)).toEqual([]);
    } finally {
      await node.dispose();
    }
  });

  it('surfaces degradations to the provided logger as warnings', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const { node } = await bootAppNode(
      baseInputs({
        logger: (e) => entries.push(e),
      }),
    );
    try {
      const kinds = entries.filter((e) => e.event === 'boot.degradation').map((e) => e.code);
      expect(kinds.length).toBeGreaterThan(0);
      // The boot.ready event also fires.
      expect(entries.some((e) => e.event === 'boot.ready')).toBe(true);
    } finally {
      await node.dispose();
    }
  });
});
