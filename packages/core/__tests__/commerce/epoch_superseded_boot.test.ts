/**
 * A node that was superseded while it was down stops at boot
 * (docs/STATE_MACHINES.md COM-6). Same verdicts as `revalidate`, with the epoch
 * this node last held written down so a restart cannot forget it.
 */

import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { commerceRecordDigest } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  CommerceEpochService,
  type EpochHeldStore,
  type EpochServiceDeps,
  type EpochStopStore,
} from '../../src/commerce/epoch_service';
import {
  COMMERCE_EPOCH_HELD_KEY,
  kvEpochHeldStore,
  kvEpochStopStore,
} from '../../src/commerce/restore_marker';
import { buildArchivePayload } from '../../src/export/archive';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CommerceEpochRecord } from '@dina/commerce-protocol';

const BUSINESS = 'did:plc:s';
const sha = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());

let live: CommerceEpochRecord | null;

interface Disk {
  stop: EpochStopStore;
  held: EpochHeldStore;
  stopped: () => { epoch: string; reason: string } | null;
}
function memoryDisk(): Disk {
  let stop: { epoch: string; reason: string } | null = null;
  let held: { epoch: string; digest: string } | null = null;
  return {
    stop: {
      load: () => stop,
      save: (s) => {
        stop = { epoch: s.epoch, reason: s.reason };
      },
      clear: () => {
        stop = null;
      },
    },
    held: {
      load: () => held,
      save: (h) => {
        held = h;
      },
    },
    stopped: () => stop,
  };
}
const boot = (disk: Disk): CommerceEpochService =>
  new CommerceEpochService({
    transaction: { atomically: (_: string, f: () => unknown) => f() },
    families: { voidPreRestore: () => 0 },
    receipts: { put: () => true },
    businessDid: BUSINESS,
    fetchLive: async () => live,
    publish: async (r: CommerceEpochRecord) => {
      live = r;
      return true;
    },
    now: () => 5_000,
    stopStore: disk.stop,
    heldStore: disk.held,
  } as unknown as EpochServiceDeps);

function record(epoch: string, previous: CommerceEpochRecord | null, activatedAt: number): CommerceEpochRecord {
  const draft = {
    protocol_version: '1.0',
    business_did: BUSINESS,
    epoch,
    reason: epoch === '1' ? 'initial' : 'restore',
    activated_at: new Date(activatedAt).toISOString(),
    ...(previous === null ? {} : { previous_epoch_digest: previous.epoch_digest }),
  };
  return {
    ...draft,
    epoch_digest: commerceRecordDigest('epoch', draft, sha),
  } as unknown as CommerceEpochRecord;
}

beforeEach(() => {
  live = null;
});

describe('COM-6: booting after being superseded', () => {
  it('a node that held epoch 1 and reboots to find 2 stops, and the stop is on disk', async () => {
    const disk = memoryDisk();
    const a = boot(disk);
    await a.establish();
    expect(a.currentEpoch()).toBe('1');

    await boot(memoryDisk()).establishAfterRestore(); // another machine restores
    expect(live?.epoch).toBe('2');

    const rebooted = boot(disk);
    await expect(rebooted.establish()).rejects.toThrow(/superseded/);
    expect(rebooted.established).toBe(false);
    expect(() => rebooted.currentEpoch()).toThrow(/stopped/);
    expect(disk.stopped()?.reason).toMatch(/superseded/);
    // And it stays down: the next boot does not read the record again.
    await expect(boot(disk).establish()).rejects.toThrow(/operator's restore/);
  });

  it('an ordinary reboot at the same epoch goes on signing', async () => {
    const disk = memoryDisk();
    await boot(disk).establish();
    const again = boot(disk);
    await again.establish();
    expect(again.currentEpoch()).toBe('1');
  });

  it('a live record that fell back, was replaced in place, or vanished stops the boot too', async () => {
    const one = record('1', null, 1_000);
    const two = record('2', one, 2_000);

    const fellBack = memoryDisk();
    live = two;
    await boot(fellBack).establish();
    live = one;
    await expect(boot(fellBack).establish()).rejects.toThrow(/fell back/);

    const replaced = memoryDisk();
    live = two;
    await boot(replaced).establish();
    live = record('2', one, 3_000);
    await expect(boot(replaced).establish()).rejects.toThrow(/replaced in place/);

    const vanished = memoryDisk();
    live = two;
    await boot(vanished).establish();
    live = null;
    await expect(boot(vanished).establish()).rejects.toThrow(/gone from the repo/);
  });

  it("the node's own restore moves what it holds, so its next boot is ordinary", async () => {
    const disk = memoryDisk();
    await boot(disk).establish();
    await boot(disk).establishAfterRestore();
    const again = boot(disk);
    await again.establish();
    expect(again.currentEpoch()).toBe('2');
  });

  it('a node with nothing written down yet (an upgrade) adopts once, then remembers', async () => {
    const disk = memoryDisk();
    live = record('3', record('2', record('1', null, 1_000), 2_000), 3_000);
    const a = boot(disk);
    await a.establish();
    expect(a.currentEpoch()).toBe('3');
    expect(disk.held.load()?.epoch).toBe('3');
  });

  it('the memory lives in kv_store, survives a reopen, and stays out of the archive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-epoch-held-'));
    const db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    try {
      applyMigrations(db, IDENTITY_MIGRATIONS);
      const disk = {
        stop: kvEpochStopStore(db),
        held: kvEpochHeldStore(db),
        stopped: () => kvEpochStopStore(db).load(),
      };
      await boot(disk).establish();
      expect(kvEpochHeldStore(db).load()?.epoch).toBe('1');
      await boot(memoryDisk()).establishAfterRestore();
      await expect(boot(disk).establish()).rejects.toThrow(/superseded/);

      const payload = await buildArchivePayload({
        identityAdapter: () => db,
        personaSources: async () => [],
        openPersonaForRestore: async () => {
          throw new Error('none');
        },
        hasExistingUserData: async () => false,
      });
      const keys = (payload.identity.tables['kv_store'] ?? []).map((r) => r.key);
      expect(keys).not.toContain(COMMERCE_EPOCH_HELD_KEY);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
