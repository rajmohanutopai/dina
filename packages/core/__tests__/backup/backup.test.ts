/**
 * Backup to the store (USER_BACKUP.md §4): the keys from the seed alone, the
 * sealed copy, and the counter rule. The store itself is tested against this
 * client in `apps/backup-service`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { TEST_MNEMONIC_SEED } from '@dina/test-harness';

import {
  backUpIfDue,
  backUpNow,
  findBackup,
  forgetBackupRuns,
  isBackupHeldForOwner,
  restoreBackup,
  type BackupKV,
} from '../../src/backup/backup_runner';
import { deriveBackupIdentity } from '../../src/backup/keys';
import { isSealedBackup, openBackup, sealBackup } from '../../src/backup/sealed';
import { BackupStoreError, type StoredCopy } from '../../src/backup/store_client';
import { BACKUP_SALT } from '../../src/crypto/hkdf';
import {
  buildArchivePayload,
  setArchiveDataSource,
  type ArchiveDataSource,
} from '../../src/export/archive';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';

const SEED = TEST_MNEMONIC_SEED.slice(0, 32);

describe('backup keys (frozen vectors, checked against Node crypto)', () => {
  it('derive from the seed alone', () => {
    const id = deriveBackupIdentity(SEED);
    expect(bytesToHex(SEED)).toBe(
      '408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70',
    );
    expect(bytesToHex(BACKUP_SALT)).toBe(
      '814b4756d5a7ee7ceb206f28a8a72aba92d6d496420245751a6bff6b85e6955f',
    );
    expect(bytesToHex(id.key)).toBe(
      'df8aac1c7f0d85ba7e9586a47597a38e210d13a6e12561f9fbfd4fec5f00f6d9',
    );
    expect(bytesToHex(id.signSeed)).toBe(
      '6e593ec2ae25434cc01a1fa459d94f6dc2dd011cf57b71900b16dbff536f0dad',
    );
    expect(bytesToHex(id.publicKey)).toBe(
      'aafa9feceafd38578a5d44bf1865e9c353078d62614c73f3fb56fcae7cf2fed9',
    );
    expect(id.backupId).toBe('153698aec5269983fe809e9eb542edd9e58af3f4579829dbadfd0e9454658f7a');
  });

  it('the backup key is neither a vault key nor the signing seed', () => {
    const id = deriveBackupIdentity(SEED);
    expect(bytesToHex(id.key)).not.toBe(bytesToHex(id.signSeed));
    expect(bytesToHex(id.key)).not.toBe(bytesToHex(SEED));
  });
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dina-backup-'));
}

interface Bundle {
  dir: string;
  id: NodeSQLiteAdapter;
  general: NodeSQLiteAdapter;
}

const PASSHEX = randomBytes(32).toString('hex');

function freshBundle(): Bundle {
  const dir = tmpDir();
  const open = (file: string, migrations: typeof IDENTITY_MIGRATIONS): NodeSQLiteAdapter => {
    const a = new NodeSQLiteAdapter({
      path: path.join(dir, file),
      passphraseHex: PASSHEX,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(a, migrations);
    return a;
  };
  return {
    dir,
    id: open('identity.sqlite', IDENTITY_MIGRATIONS),
    general: open('general.sqlite', PERSONA_MIGRATIONS),
  };
}

function closeBundle(b: Bundle): void {
  b.id.close();
  b.general.close();
  fs.rmSync(b.dir, { recursive: true, force: true });
}

function dataSourceFor(b: Bundle): ArchiveDataSource {
  return {
    identityAdapter: () => b.id,
    personaSources: async () => [{ name: 'general', tier: 'default', adapter: b.general }],
    openPersonaForRestore: async () => b.general,
    hasExistingUserData: async () =>
      b.general.query('SELECT 1 FROM vault_items LIMIT 1').length > 0,
  };
}

function seedNote(b: Bundle, id: string, text: string): void {
  b.general.execute(
    `INSERT INTO vault_items (id, type, source, summary, body, timestamp, created_at, updated_at)
     VALUES (?, 'note', 'user', ?, ?, 1, 1, 1)`,
    [id, text, text],
  );
}

/** The store as the client sees it: immutable copies, refusing a counter not above the top. */
class FakeStore {
  readonly copies = new Map<number, Uint8Array>();
  async list(): Promise<StoredCopy[]> {
    return [...this.copies.entries()]
      .map(([counter, b]) => ({ counter, size: b.length, storedAt: 0 }))
      .sort((a, b) => a.counter - b.counter);
  }
  async put(counter: number, bytes: Uint8Array): Promise<void> {
    const top = Math.max(0, ...this.copies.keys());
    if (counter <= top) throw new BackupStoreError('backup store put failed (409)', 409);
    this.copies.set(counter, bytes);
  }
  async get(counter: number | 'latest'): Promise<Uint8Array | null> {
    const c = counter === 'latest' ? Math.max(0, ...this.copies.keys()) : counter;
    return this.copies.get(c) ?? null;
  }
}

function memKV(): BackupKV & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (k) => rows.get(k) ?? null,
    set: async (k, v) => {
      rows.set(k, v);
    },
  };
}

describe('the sealed copy', () => {
  let src: Bundle;
  beforeEach(() => {
    src = freshBundle();
    seedNote(src, 'v-1', 'Dentist on Tuesday');
    seedNote(src, 'v-2', 'Fogline Bakehouse delivers at 7');
  });
  afterEach(() => closeBundle(src));

  it('opens under the same seed, carrying the DID, handle, counter and item count', async () => {
    const id = deriveBackupIdentity(SEED);
    const payload = await buildArchivePayload(dataSourceFor(src));
    const sealed = sealBackup(payload, id, {
      did: 'did:plc:alonso',
      handle: 'alonso.test-pds.dinakernel.com',
      counter: 3,
      createdAt: 1_761_700_000_000,
    });
    expect(isSealedBackup(sealed)).toBe(true);
    // The store sees no plaintext.
    expect(Buffer.from(sealed).includes(Buffer.from('Dentist'))).toBe(false);
    expect(Buffer.from(sealed).includes(Buffer.from('did:plc:alonso'))).toBe(false);

    const opened = openBackup(sealed, deriveBackupIdentity(SEED));
    expect(opened.meta).toMatchObject({
      did: 'did:plc:alonso',
      handle: 'alonso.test-pds.dinakernel.com',
      counter: 3,
      created_at: 1_761_700_000_000,
      item_count: 2,
      backup_id: id.backupId,
    });
    expect(opened.payload.personas[0]?.tables.vault_items).toHaveLength(2);
  });

  it('refuses another seed, a flipped byte, and a passphrase archive', async () => {
    const id = deriveBackupIdentity(SEED);
    const payload = await buildArchivePayload(dataSourceFor(src));
    const sealed = sealBackup(payload, id, { did: 'd', handle: 'h', counter: 1, createdAt: 1 });
    const other = deriveBackupIdentity(new Uint8Array(32).fill(7));
    expect(() => openBackup(sealed, other)).toThrow('wrong recovery phrase');
    const flipped = Uint8Array.from(sealed);
    flipped[flipped.length - 20] ^= 1;
    expect(() => openBackup(flipped, id)).toThrow('wrong recovery phrase or damaged');
    const passphraseArchive = Uint8Array.from(sealed);
    passphraseArchive[4] = 1;
    expect(() => openBackup(passphraseArchive, id)).toThrow('not a sealed backup copy');
  });
});

describe('backing up and restoring through the store', () => {
  let src: Bundle;
  afterEach(() => {
    setArchiveDataSource(null);
  });

  beforeEach(() => {
    src = freshBundle();
    seedNote(src, 'v-1', 'Dentist on Tuesday');
  });
  afterEach(() => closeBundle(src));

  const deps = (store: FakeStore, kv: BackupKV) => ({
    identity: deriveBackupIdentity(SEED),
    client: store,
    kv,
    did: 'did:plc:alonso',
    handle: 'alonso.test',
  });

  it('restoring copy 10 while 11–20 are kept, then backing up, writes 21 and keeps 11–20', async () => {
    setArchiveDataSource(dataSourceFor(src));
    const store = new FakeStore();
    const kv = memKV();
    for (let i = 0; i < 20; i++) await backUpNow(deps(store, kv));
    expect([...store.copies.keys()]).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // A new phone: nothing written yet, restores copy 10.
    const phone = freshBundle();
    try {
      setArchiveDataSource(dataSourceFor(phone));
      const id = deriveBackupIdentity(SEED);
      const found = await findBackup(id, store, 10);
      expect(found?.meta.counter).toBe(10);
      if (found === null) throw new Error('copy 10 missing');
      await restoreBackup(id, found);
      expect(phone.general.query('SELECT id FROM vault_items')).toEqual([{ id: 'v-1' }]);

      const result = await backUpNow(deps(store, memKV()));
      expect(result.counter).toBe(21);
      expect(result.storeBehind).toBe(false);
      for (let c = 11; c <= 20; c++) expect(store.copies.has(c)).toBe(true);
    } finally {
      closeBundle(phone);
    }
  });

  it('a device warns when the store lists less than it last wrote', async () => {
    setArchiveDataSource(dataSourceFor(src));
    const store = new FakeStore();
    const kv = memKV();
    await backUpNow(deps(store, kv));
    await backUpNow(deps(store, kv));
    store.copies.delete(2); // the store holds the newest back
    const result = await backUpNow(deps(store, kv));
    expect(result).toMatchObject({ counter: 3, storeBehind: true });
  });

  it('a lost race for a counter lists again and takes the next', async () => {
    setArchiveDataSource(dataSourceFor(src));
    const store = new FakeStore();
    const realList = store.list.bind(store);
    let first = true;
    store.list = async () => {
      const listed = await realList();
      if (first) {
        first = false;
        store.copies.set(1, new Uint8Array([1])); // another device wrote 1 meanwhile
      }
      return listed;
    };
    const result = await backUpNow(deps(store, memKV()));
    expect(result.counter).toBe(2);
  });

  it('the daily run backs up once a day, and only when something changed', async () => {
    setArchiveDataSource(dataSourceFor(src));
    const store = new FakeStore();
    const kv = memKV();
    let clock = 1_000_000_000;
    const d = { ...deps(store, kv), now: () => clock };
    const DAY = 86_400_000;
    expect(await backUpIfDue(d, { everyMs: DAY })).toMatchObject({ ran: true });
    clock += DAY / 2;
    expect(await backUpIfDue(d, { everyMs: DAY })).toEqual({ ran: false, reason: 'not_due' });
    clock += DAY;
    expect(await backUpIfDue(d, { everyMs: DAY })).toEqual({ ran: false, reason: 'unchanged' });
    // Unchanged pushes the next look a day out.
    clock += DAY / 2;
    expect(await backUpIfDue(d, { everyMs: DAY })).toEqual({ ran: false, reason: 'not_due' });
    seedNote(src, 'v-2', 'Order 240 croissants for Saturday');
    clock += DAY;
    expect(await backUpIfDue(d, { everyMs: DAY })).toMatchObject({
      ran: true,
      result: { counter: 2 },
    });
  });

  it('the backup bookkeeping in kv_store stays out of the copy', async () => {
    src.id.execute(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('backup:last_at', '5', 1)`,
    );
    src.id.execute(`INSERT INTO kv_store (key, value, updated_at) VALUES ('theme', 'dark', 1)`);
    const payload = await buildArchivePayload(dataSourceFor(src));
    expect(payload.identity.tables.kv_store?.map((r) => r.key)).toEqual(['theme']);
  });

  describe('a phone that has written nothing yet (BACKUP-1, PH-03)', () => {
    const DAY = 86_400_000;

    async function storeWithOneCopy(): Promise<FakeStore> {
      setArchiveDataSource(dataSourceFor(src));
      const store = new FakeStore();
      await backUpNow(deps(store, memKV()));
      return store;
    }

    it('does not write on schedule over copies it never restored, and says so', async () => {
      const store = await storeWithOneCopy();
      const phone = freshBundle();
      try {
        setArchiveDataSource(dataSourceFor(phone));
        const kv = memKV();
        expect(await backUpIfDue(deps(store, kv), { everyMs: DAY })).toEqual({
          ran: false,
          reason: 'held_for_owner',
        });
        expect([...store.copies.keys()]).toEqual([1]);
        expect(await isBackupHeldForOwner(kv)).toBe(true);
      } finally {
        closeBundle(phone);
      }
    });

    it('writes after a restore, at the next counter, holding the restored rows', async () => {
      const store = await storeWithOneCopy();
      const phone = freshBundle();
      try {
        setArchiveDataSource(dataSourceFor(phone));
        const kv = memKV();
        await backUpIfDue(deps(store, kv), { everyMs: DAY });
        const id = deriveBackupIdentity(SEED);
        const found = await findBackup(id, store);
        if (found === null) throw new Error('copy missing');
        await restoreBackup(id, found, { kv });
        expect(await isBackupHeldForOwner(kv)).toBe(false);
        const out = await backUpIfDue(deps(store, kv), { everyMs: DAY });
        expect(out).toMatchObject({ ran: true, result: { counter: 2, storeBehind: false } });
        const latest = await findBackup(id, store);
        expect(latest?.meta.item_count).toBe(1);
      } finally {
        closeBundle(phone);
      }
    });

    it('a restore that throws leaves the hold on', async () => {
      const store = await storeWithOneCopy();
      const phone = freshBundle();
      try {
        seedNote(phone, 'v-local', 'Written here');
        setArchiveDataSource(dataSourceFor(phone));
        const kv = memKV();
        const id = deriveBackupIdentity(SEED);
        const found = await findBackup(id, store);
        if (found === null) throw new Error('copy missing');
        await expect(restoreBackup(id, found, { kv })).rejects.toThrow(/not a clean install/);
        expect(await backUpIfDue(deps(store, kv), { everyMs: DAY })).toEqual({
          ran: false,
          reason: 'held_for_owner',
        });
      } finally {
        closeBundle(phone);
      }
    });

    it('"Back up now" is the owner saying start fresh: it writes, and the hold ends', async () => {
      const store = await storeWithOneCopy();
      const phone = freshBundle();
      try {
        setArchiveDataSource(dataSourceFor(phone));
        const kv = memKV();
        await backUpIfDue(deps(store, kv), { everyMs: DAY });
        await backUpNow(deps(store, kv));
        expect(await isBackupHeldForOwner(kv)).toBe(false);
        seedNote(phone, 'v-2', 'Now it holds something');
        const out = await backUpIfDue(deps(store, kv), { everyMs: 0 });
        expect(out).toMatchObject({ ran: true, result: { counter: 3 } });
      } finally {
        closeBundle(phone);
      }
    });

    it('a first copy into an empty store still runs', async () => {
      setArchiveDataSource(dataSourceFor(src));
      const out = await backUpIfDue(deps(new FakeStore(), memKV()), { everyMs: DAY });
      expect(out).toMatchObject({ ran: true, result: { counter: 1 } });
    });

    it('an offline store fails the run, and writes nothing', async () => {
      const store = await storeWithOneCopy();
      store.list = async () => {
        throw new Error('offline');
      };
      await expect(backUpIfDue(deps(store, memKV()), { everyMs: DAY })).rejects.toThrow('offline');
      expect([...store.copies.keys()]).toEqual([1]);
    });
  });

  it('after every copy is deleted, turning backup on writes one at once (BACKUP-2)', async () => {
    setArchiveDataSource(dataSourceFor(src));
    const store = new FakeStore();
    const kv = memKV();
    await backUpNow(deps(store, kv));
    store.copies.clear();
    await forgetBackupRuns(kv);
    const out = await backUpIfDue(deps(store, kv), { everyMs: 86_400_000 });
    expect(out).toMatchObject({ ran: true, result: { counter: 1, storeBehind: false } });
    expect(store.copies.size).toBe(1);
  });

  it('an empty store finds nothing', async () => {
    expect(await findBackup(deriveBackupIdentity(SEED), new FakeStore())).toBeNull();
  });
});
