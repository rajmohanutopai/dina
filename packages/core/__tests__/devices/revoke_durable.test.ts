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
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { resetAuditState } from '../../src/audit/service';

const PASSHEX = randomBytes(32).toString('hex');

function openId(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({ path: p, passphraseHex: PASSHEX, journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}

beforeEach(() => {
  resetDeviceRegistry();
  resetCallerTypeState();
  resetAuditState();
  setDeviceRepository(null);
  setAgentGrantRepository(null);
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
        expect(again).toMatchObject({ found: true, revoked: true, durable: true, alreadyRevoked: true });
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
          expect(grantRepo.findActiveGrant(d.did, 'health', 'read', null, Date.now())).not.toBeNull();

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
