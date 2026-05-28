/**
 * SQLiteDeviceRepository.register — must be idempotent on `device_id`.
 *
 * MT-2026-05-28-E-BUG1 surfaced this live on the mobile sim: pairing 503'd
 * with `UNIQUE constraint failed: paired_devices.device_id` because the
 * route writes the device row TWICE for the same paired device by design:
 *
 *   1. `registerDevice()` (sync caller surface) fires
 *      `void sqlRepo.register(d).catch(...)` — INSERT #1, fire-and-forget.
 *   2. `persistDeviceDurable()` then `await sqlRepo.register(d)` — INSERT
 *      #2, this time blocking, so a real persistence failure surfaces as
 *      503 rather than a false 201.
 *
 * INSERT #2 with plain INSERT against the SAME PRIMARY KEY would fail.
 * `INSERT OR REPLACE` makes register() idempotent — first writer creates
 * the row, the same-row re-write is a semantic no-op (no auto-updated
 * columns on `paired_devices`).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { SQLiteDeviceRepository } from '../../src/devices/repository';

import type { PairedDevice } from '../../src/devices/registry';

const PASSHEX = randomBytes(32).toString('hex');

// SQLCipher rejects `:memory:` keys, so each test gets its own tmpfile.
function openId(): { adapter: NodeSQLiteAdapter; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-dev-repo-'));
  const p = path.join(dir, 'identity.sqlite');
  const adapter = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    cleanup: (): void => {
      try {
        adapter.close();
      } catch {
        /* */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function deviceFixture(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: 'dev-aaaaaaaaaaaaaaaa',
    did: 'did:key:z6MkAgentTestKey',
    publicKeyMultibase: 'z6MkAgentTestKey',
    deviceName: 'claw-agent',
    role: 'agent',
    authType: 'ed25519',
    lastSeen: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    revoked: false,
    ...overrides,
  };
}

describe('SQLiteDeviceRepository.register — idempotency (MT-2026-05-28-E-BUG1)', () => {
  it('re-registering the same device_id does NOT raise UNIQUE constraint', async () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteDeviceRepository(adapter);
      const d = deviceFixture();
      await repo.register(d);
      // Second call is the exact pattern the pair route runs: registerDevice()
      // fire-and-forget INSERT #1, then persistDeviceDurable() awaits INSERT #2
      // for the SAME row. Plain INSERT would `SQLITE_CONSTRAINT: UNIQUE
      // constraint failed: paired_devices.device_id` here. INSERT OR REPLACE
      // makes it a no-op.
      await expect(repo.register(d)).resolves.toBeUndefined();
      const rows = adapter.query('SELECT COUNT(*) AS n FROM paired_devices', []);
      expect(Number(rows[0].n)).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('three back-to-back registers of the same row converge to one row', async () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteDeviceRepository(adapter);
      const d = deviceFixture({ deviceId: 'dev-bbbbbbbbbbbbbbbb' });
      await repo.register(d);
      await repo.register(d);
      await repo.register(d);
      const rows = adapter.query('SELECT COUNT(*) AS n FROM paired_devices', []);
      expect(Number(rows[0].n)).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('re-register with a changed mutable field upserts in place (lastSeen advanced)', async () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteDeviceRepository(adapter);
      const t0 = 1_700_000_000_000;
      const t1 = 1_700_000_999_999;
      const d = deviceFixture({ deviceId: 'dev-cccccccccccccccc', lastSeen: t0 });
      await repo.register(d);
      await repo.register({ ...d, lastSeen: t1 });
      const stored = await repo.get(d.deviceId);
      expect(stored?.deviceId).toBe(d.deviceId);
      expect(stored?.lastSeen).toBe(t1);
      const rows = adapter.query('SELECT COUNT(*) AS n FROM paired_devices', []);
      expect(Number(rows[0].n)).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('distinct device_ids still produce distinct rows (REPLACE does not clobber siblings)', async () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteDeviceRepository(adapter);
      await repo.register(deviceFixture({ deviceId: 'dev-1111111111111111' }));
      await repo.register(deviceFixture({ deviceId: 'dev-2222222222222222' }));
      const rows = adapter.query('SELECT COUNT(*) AS n FROM paired_devices', []);
      expect(Number(rows[0].n)).toBe(2);
    } finally {
      cleanup();
    }
  });
});
