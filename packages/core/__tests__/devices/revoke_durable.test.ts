/**
 * Durable paired-device revoke (issues.txt §5).
 *
 * The security guarantee: a revoked device must NEVER become trusted
 * again after a restart. These tests register a device against a real
 * SQLCipher repo, revoke it durably, then simulate a restart (clear the
 * in-memory registry + auth, re-hydrate from SQL) and assert the device
 * stays revoked and cannot authenticate. Also: idempotency, unknown
 * device, a repo whose write fails (no phantom durable success), and the
 * cascade that drops a revoked agent's locked-vault grants.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  registerDevice,
  revokeDeviceDurable,
  revokeDeviceByDidDurable,
  hydrateDeviceRegistry,
  resetDeviceRegistry,
  getDevice,
  isDeviceActive,
  listDevices,
} from '../../src/devices/registry';
import {
  SQLiteDeviceRepository,
  setDeviceRepository,
  type DeviceRepository,
} from '../../src/devices/repository';
import { resolveCallerType, resetCallerTypeState } from '../../src/auth/caller_type';
import {
  InMemoryAgentGrantRepository,
  SQLiteAgentGrantRepository,
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { resetAuditState } from '../../src/audit/service';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
} from '../../src/plugins/decisions';
import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';

const PASSHEX = randomBytes(32).toString('hex');

function openId(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}

beforeEach(() => {
  resetDeviceRegistry();
  resetCallerTypeState();
  resetAuditState();
  setDeviceRepository(null);
  setAgentGrantRepository(null);
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
});

describe('revokeDeviceDurable — restart safety', () => {
  it('a revoked device stays revoked after restart and cannot authenticate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev-'));
    const dbPath = path.join(dir, 'identity.sqlite');
    try {
      // Session 1: register + durably revoke.
      const a1 = openId(dbPath);
      setDeviceRepository(new SQLiteDeviceRepository(a1));
      const device = registerDevice('OpenClaw agent', 'z6MkAgentKey1', 'agent');
      const result = await revokeDeviceDurable(device.deviceId);
      expect(result).toMatchObject({ found: true, revoked: true, durable: true });
      a1.close();

      // Session 2 (restart): clear in-memory state, re-hydrate from SQL.
      resetDeviceRegistry();
      resetCallerTypeState();
      const a2 = openId(dbPath);
      setDeviceRepository(new SQLiteDeviceRepository(a2));
      await hydrateDeviceRegistry();

      // Still revoked after restart — the heart of the fix.
      expect(getDevice(device.deviceId)?.revoked).toBe(true);
      expect(isDeviceActive(device.deviceId)).toBe(false);
      // And NOT re-registered in auth → can't authenticate → can't claim tasks.
      expect(resolveCallerType(device.did).callerType).toBe('unknown');
      a2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('revokeDeviceDurable — semantics', () => {
  function withSqlRepo<T>(fn: (cleanup: () => void) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev2-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    setDeviceRepository(new SQLiteDeviceRepository(a));
    return fn(() => {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('is idempotent — re-revoking a revoked device is a success no-op', async () => {
    await withSqlRepo(async (cleanup) => {
      try {
        const d = registerDevice('Phone', 'z6MkPhone', 'rich');
        await revokeDeviceDurable(d.deviceId);
        const again = await revokeDeviceDurable(d.deviceId);
        expect(again).toMatchObject({
          found: true,
          revoked: true,
          durable: true,
          alreadyRevoked: true,
        });
      } finally {
        cleanup();
      }
    });
  });

  it('returns a clean not-found for an unknown device', async () => {
    const r = await revokeDeviceDurable('dev-does-not-exist');
    expect(r).toMatchObject({ found: false, revoked: false, durable: false });
  });

  it('does NOT report durable success when the SQL write fails — but still cuts access', async () => {
    // Repo whose revoke throws models a disk/SQL error.
    const failingRepo: DeviceRepository = {
      register: async () => {},
      get: async () => null,
      getByPublicKey: async () => null,
      getByDID: async () => null,
      list: async () => [],
      touch: async () => {},
      revoke: async () => {
        throw new Error('disk full');
      },
    };
    setDeviceRepository(failingRepo);
    const d = registerDevice('Phone', 'z6MkFail', 'rich');
    const r = await revokeDeviceDurable(d.deviceId);
    expect(r.durable).toBe(false);
    expect(r.error).toBe('disk full');
    // Fail-safe: in-memory access is still cut even though persistence failed.
    expect(getDevice(d.deviceId)?.revoked).toBe(true);
    expect(isDeviceActive(d.deviceId)).toBe(false);
  });

  it('round-5 #5: a device revoked in-memory after a SQL failure RETRIES the SQL on the next call', async () => {
    let shouldFail = true;
    const flakyRepo: DeviceRepository = {
      register: async () => {},
      get: async () => null,
      getByPublicKey: async () => null,
      getByDID: async () => null,
      list: async () => [],
      touch: async () => {},
      revoke: async () => {
        if (shouldFail) throw new Error('disk full');
        return true;
      },
    };
    setDeviceRepository(flakyRepo);
    const d = registerDevice('Phone', 'z6MkFlaky', 'rich');
    // First call: SQL fails → durable:false (NOT falsely durable), access cut.
    const first = await revokeDeviceDurable(d.deviceId);
    expect(first.durable).toBe(false);
    expect(getDevice(d.deviceId)?.revoked).toBe(true);
    // The old code short-circuited a second call as durable:true WITHOUT
    // retrying SQL. The fix re-attempts the (now-recovered) persistence.
    shouldFail = false;
    const second = await revokeDeviceDurable(d.deviceId);
    expect(second.durable).toBe(true);
    expect(second.alreadyRevoked).toBe(true);
  });

  it('round-6 #4: a failing authority cascade makes durable=false (so the caller retries)', async () => {
    await withSqlRepo(async (cleanup) => {
      try {
        // A plugin install repo whose enumeration THROWS models a cascade
        // failure. The device SQL row still persists, but old installs/grants
        // may survive — so the revoke must NOT report fully durable.
        setPluginInstallRepository({
          listByDeviceDid() {
            throw new Error('db locked');
          },
        } as unknown as SQLitePluginInstallRepository);
        const d = registerDevice('inst', 'z6MkCascadeFail', 'plugin');
        const r = await revokeDeviceDurable(d.deviceId);
        expect(r.durable).toBe(false); // cascade incomplete → not fully durable
        expect(r.error).toContain('cascade');
        // Fail-safe deny still applies (access cut immediately).
        expect(getDevice(d.deviceId)?.revoked).toBe(true);
      } finally {
        setPluginInstallRepository(null);
        cleanup();
      }
    });
  });

  it('round-6 #1: revokeDeviceByDidDurable maps DID → deviceId → the durable revoke', async () => {
    await withSqlRepo(async (cleanup) => {
      try {
        const d = registerDevice('phone', 'z6MkByDid', 'rich');
        const r = await revokeDeviceByDidDurable(d.did);
        expect(r).toMatchObject({ found: true, revoked: true, durable: true });
        expect(getDevice(d.deviceId)?.revoked).toBe(true);
        // An unknown DID resolves cleanly to not_found — never throws.
        expect(await revokeDeviceByDidDurable('did:key:znope')).toMatchObject({ found: false });
        expect(await revokeDeviceByDidDurable('')).toMatchObject({ found: false });
      } finally {
        cleanup();
      }
    });
  });
});

describe('revokeDeviceDurable — cascades to agent grants (§2/§5)', () => {
  it("revokes the device DID's durable persona grants", async () => {
    await new Promise<void>((resolve) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev3-'));
      const a = openId(path.join(dir, 'identity.sqlite'));
      setDeviceRepository(new SQLiteDeviceRepository(a));
      const grantRepo = new InMemoryAgentGrantRepository();
      setAgentGrantRepository(grantRepo);
      void (async () => {
        try {
          const d = registerDevice('Agent', 'z6MkGrantAgent', 'agent');
          // Grant this device's DID access to a sensitive persona.
          grantRepo.insert({
            id: 'g-1',
            agentDID: d.did,
            persona: 'health',
            mode: 'read',
            scopeJson: '{}',
            approvalTaskId: 't-1',
            expiresAt: Date.now() + 3_600_000,
            createdAt: Date.now(),
          });
          expect(
            grantRepo.findActiveGrant(d.did, 'health', 'read', null, Date.now()),
          ).not.toBeNull();

          await revokeDeviceDurable(d.deviceId);

          // Revoking the device revoked its grant — no stale locked-vault access.
          expect(grantRepo.findActiveGrant(d.did, 'health', 'read', null, Date.now())).toBeNull();
        } finally {
          a.close();
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        }
      })();
    });
  });
});

describe('revokeDeviceDurable — cascades to plugin authority (F3)', () => {
  const CAP = 'com.acme.flightwatch.watch';
  const manifest: PluginManifest = {
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.flightwatch',
    version: '1.0.0',
    display_name: 'Flight Watch',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: CAP,
        display_name: 'Watch a flight',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        kinds: ['tool'],
      },
    ],
  };

  it('revoking a plugin runner device PAUSES its install and REVOKES its grants (no re-pair revival)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev5-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    try {
      setDeviceRepository(new SQLiteDeviceRepository(a));
      const installs = new SQLitePluginInstallRepository(a);
      const grants = new SQLitePluginGrantRepository(a);
      setPluginInstallRepository(installs);
      setPluginGrantRepository(grants);
      setPluginDecisionRepository(new SQLitePluginDecisionRepository(a));

      // A plugin runner instance device, and an active install bound to it.
      const d = registerDevice('Flight Watch (inst_1)', 'z6MkPluginInst1', 'plugin');
      const now = Date.now();
      const installId = installs.createPending({
        publisherDid: 'did:plc:acme',
        pluginId: 'com.acme.flightwatch',
        label: '',
        executionMode: 'runner',
        currentCid: 'bafyreicid',
        currentVersion: '1.0.0',
        manifest,
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { [CAP]: 'c'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
        trustAnchor: { kind: 'repo_proof' },
        pendingExpiresAtSec: Math.floor(now / 1000) + 900,
        nowMs: now,
      });
      installs.activate(installId, d.did, now);
      const grantId = grants.create(
        {
          installId,
          capability: CAP,
          approvedScopeHash: 'c'.repeat(64),
          grantType: 'standing',
          constraints: { version: 1, max_count: 100 }, // Round-8 #1: standing needs a bound
        },
        'read',
        now,
      );
      expect(installs.getById(installId)?.status).toBe('active');
      expect(grants.getById(grantId)?.revokedAt).toBeUndefined();

      // Revoke the device → the cascade pauses the install and revokes grants.
      await revokeDeviceDurable(d.deviceId);

      const after = installs.getById(installId);
      expect(after?.status).toBe('paused'); // lane stops accepting claims
      expect(grants.getById(grantId)?.revokedAt).toBeGreaterThan(0); // no surviving authority
    } finally {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P1-3: revocation disables EVERY install co-bound to the device (active + paused + pending)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev5b-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    try {
      setDeviceRepository(new SQLiteDeviceRepository(a));
      const installs = new SQLitePluginInstallRepository(a);
      const grants = new SQLitePluginGrantRepository(a);
      setPluginInstallRepository(installs);
      setPluginGrantRepository(grants);
      setPluginDecisionRepository(new SQLitePluginDecisionRepository(a));

      const d = registerDevice('inst', 'z6MkMultiInst', 'plugin');
      const dOther = registerDevice('other', 'z6MkMultiOther', 'plugin');
      const now = Date.now();
      const mk = (): string =>
        installs.createPending({
          publisherDid: 'did:plc:acme',
          pluginId: 'com.acme.flightwatch',
          label: '',
          executionMode: 'runner',
          currentCid: 'bafyreicid',
          currentVersion: '1.0.0',
          manifest,
          installScopeHash: 's'.repeat(64),
          capabilityHashes: { [CAP]: 'c'.repeat(64) },
          behaviorHash: 'b'.repeat(64),
          presentationHash: 'p'.repeat(64),
          trustAnchor: { kind: 'repo_proof' },
          pendingExpiresAtSec: Math.floor(now / 1000) + 900,
          nowMs: now,
        });
      const grantFor = (installId: string): string =>
        grants.create(
          {
            installId,
            capability: CAP,
            approvedScopeHash: 'c'.repeat(64),
            grantType: 'standing',
            constraints: { version: 1, max_count: 100 }, // Round-8 #1: standing needs a bound
          },
          'read',
          now,
        );

      // (1) active on d.did
      const active = mk();
      installs.activate(active, d.did, now);
      const gActive = grantFor(active);
      // (2) paused, co-bound to d.did (index only constrains active rows)
      const paused = mk();
      installs.activate(paused, dOther.did, now);
      installs.pause(paused, now + 1);
      a.execute('UPDATE plugin_installs SET device_did = ? WHERE install_id = ?', [d.did, paused]);
      const gPaused = grantFor(paused);
      // (3) pending, bound to d.did during pairing
      const pending = mk();
      installs.bindPendingDevice(pending, d.did, now);
      const gPending = grantFor(pending);

      await revokeDeviceDurable(d.deviceId);

      // active → paused, grant revoked
      expect(installs.getById(active)?.status).toBe('paused');
      expect(grants.getById(gActive)?.revokedAt).toBeGreaterThan(0);
      // paused → stays paused, grant revoked
      expect(installs.getById(paused)?.status).toBe('paused');
      expect(grants.getById(gPaused)?.revokedAt).toBeGreaterThan(0);
      // pending → unwound entirely (row + grant gone: can never activate dead authority)
      expect(installs.getById(pending)).toBeNull();
      expect(grants.getById(gPending)).toBeNull();
    } finally {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-7 #3: boot reconciliation disables a revoked device install left ACTIVE by a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev5c-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    try {
      const sqlRepo = new SQLiteDeviceRepository(a);
      setDeviceRepository(sqlRepo);
      const installs = new SQLitePluginInstallRepository(a);
      const grants = new SQLitePluginGrantRepository(a);
      setPluginInstallRepository(installs);
      setPluginGrantRepository(grants);
      setPluginDecisionRepository(new SQLitePluginDecisionRepository(a));

      const d = registerDevice('inst', 'z6MkCrashInst', 'plugin');
      await sqlRepo.register(d); // write-through is fire-and-forget — force it
      const now = Date.now();
      const installId = installs.createPending({
        publisherDid: 'did:plc:acme',
        pluginId: 'com.acme.fw',
        label: '',
        executionMode: 'runner',
        currentCid: 'bafyreicid',
        currentVersion: '1.0.0',
        manifest,
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { [CAP]: 'c'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
        trustAnchor: { kind: 'repo_proof' },
        pendingExpiresAtSec: Math.floor(now / 1000) + 900,
        nowMs: now,
      });
      installs.activate(installId, d.did, now);
      const grantId = grants.create(
        {
          installId,
          capability: CAP,
          approvedScopeHash: 'c'.repeat(64),
          grantType: 'standing',
          constraints: { version: 1, max_count: 100 }, // Round-8 #1: standing needs a bound
        },
        'read',
        now,
      );
      expect(installs.getById(installId)?.status).toBe('active');

      // Simulate a CRASH: the device is revoked in SQL, but the authority
      // cascade never ran (the install is still active, its grant still live).
      await sqlRepo.revoke(d.deviceId);

      // Reboot: clear the in-memory registry, then hydrate — which reconciles.
      resetDeviceRegistry();
      await hydrateDeviceRegistry();

      // The revoked device's stale authority is now disabled — re-pairing the
      // same key can no longer revive an active install with old grants.
      expect(installs.getById(installId)?.status).toBe('paused');
      expect(grants.getById(grantId)?.revokedAt).toBeGreaterThan(0);
    } finally {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-8 #2: boot reconciliation also revokes a crashed revoked device's AGENT persona grants", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev5e-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    try {
      const sqlRepo = new SQLiteDeviceRepository(a);
      setDeviceRepository(sqlRepo);
      // A durable agent-grant repo (SQL) so the grant genuinely survives the
      // simulated reboot below. NO plugin install repo is wired — the crash we
      // reconcile here is the AGENT-grant half, which the pre-Round-8 reconciler
      // never repeated (it only re-disabled plugin installs/grants).
      const agentGrants = new SQLiteAgentGrantRepository(a);
      setAgentGrantRepository(agentGrants);

      const d = registerDevice('Agent', 'z6MkCrashAgentGrant', 'agent');
      await sqlRepo.register(d); // force the write-through so the device persists
      const now = Date.now();
      agentGrants.insert({
        id: 'g-crash-1',
        sessionId: null,
        agentDID: d.did,
        persona: 'health',
        mode: 'read',
        scopeJson: '{}',
        approvalTaskId: 't-crash',
        expiresAt: now + 3_600_000,
        createdAt: now,
      });
      expect(agentGrants.listActiveForAgent(d.did, Date.now())).toHaveLength(1);

      // Simulate a CRASH: the device is revoked in SQL, but the authority
      // cascade never ran — the agent persona grant is still LIVE, so the
      // revoked agent could keep reading a locked persona with a stale grant.
      await sqlRepo.revoke(d.deviceId);
      expect(agentGrants.listActiveForAgent(d.did, Date.now())).toHaveLength(1);

      // Reboot: clear the in-memory registry, then hydrate — which reconciles
      // BOTH halves of authority (plugin AND agent grants) for revoked devices.
      resetDeviceRegistry();
      await hydrateDeviceRegistry();

      // The crashed revoked device's locked-persona grant is now tombstoned —
      // re-hydrating (re-pairing) the same key can no longer read via it.
      expect(agentGrants.listActiveForAgent(d.did, Date.now())).toHaveLength(0);
    } finally {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-8 #3: revoke reports NOT durable when the grant repo is absent but installs exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev5d-'));
    const a = openId(path.join(dir, 'identity.sqlite'));
    try {
      const sqlRepo = new SQLiteDeviceRepository(a);
      setDeviceRepository(sqlRepo);
      const installs = new SQLitePluginInstallRepository(a);
      setPluginInstallRepository(installs);
      // The grant repo is UNAVAILABLE (misconfiguration / boot-order bug), yet
      // there is an active install whose grants would be silently orphaned.
      setPluginGrantRepository(null);
      setPluginDecisionRepository(new SQLitePluginDecisionRepository(a));

      const d = registerDevice('inst', 'z6MkNoGrantRepo', 'plugin');
      await sqlRepo.register(d); // force write-through so the SQL revoke succeeds
      const now = Date.now();
      const installId = installs.createPending({
        publisherDid: 'did:plc:acme',
        pluginId: 'com.acme.fw',
        label: '',
        executionMode: 'runner',
        currentCid: 'bafyreicid',
        currentVersion: '1.0.0',
        manifest,
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { [CAP]: 'c'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
        trustAnchor: { kind: 'repo_proof' },
        pendingExpiresAtSec: Math.floor(now / 1000) + 900,
        nowMs: now,
      });
      installs.activate(installId, d.did, now);
      expect(installs.getById(installId)?.status).toBe('active');

      const r = await revokeDeviceDurable(d.deviceId);

      // The device SQL row persisted, but the plugin cascade could not revoke
      // the install's grants (repo absent). We must NOT report durable success —
      // a silent half-cleanup (paused install + live grants) is the exact split
      // Round-8 #3 forbids. Fail closed so the caller/reconciler retries.
      expect(r.durable).toBe(false);
      expect(r.error).toMatch(/grant repository unavailable/);
      // The cascade threw BEFORE pausing anything — the install stays active
      // (nothing changed) rather than leaving a paused install with live grants.
      expect(installs.getById(installId)?.status).toBe('active');
    } finally {
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Sanity: the simple register→hydrate active path still works (no revoke).
describe('register → hydrate', () => {
  it('a registered device is active after hydrate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev4-'));
    const dbPath = path.join(dir, 'identity.sqlite');
    try {
      const a1 = openId(dbPath);
      setDeviceRepository(new SQLiteDeviceRepository(a1));
      const d = registerDevice('Laptop', 'z6MkLaptop', 'rich');
      a1.close();
      resetDeviceRegistry();
      const a2 = openId(dbPath);
      setDeviceRepository(new SQLiteDeviceRepository(a2));
      await hydrateDeviceRegistry();
      expect(isDeviceActive(d.deviceId)).toBe(true);
      expect(listDevices().some((x) => x.deviceId === d.deviceId)).toBe(true);
      a2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
