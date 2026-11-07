/**
 * Lose the server, keep the words (USER_BACKUP.md §4.4, §4.5): a Home Node
 * with a backup store named writes a sealed copy when it stops, and a fresh
 * install with only the same seed finds it, sees whose it is, and restores
 * it. The store here is the real backup service, over HTTP.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import { buildServer, CopyStore } from '@dina/backup-service';
import {
  BackupStoreClient,
  deriveBackupIdentity,
  findBackup,
  resetPersonaState,
  restoreBackup,
  setArchiveDataSource,
} from '@dina/core';
import {
  openPersonaVault,
  resetTopicRepositories,
  resetVaultRepositories,
  setPersonaRepository,
} from '@dina/core/storage';

import { BackupSupervisor } from '../src/backup/backup_supervisor';
import { initializeStorage, type StorageInitResult } from '../src/storage/init';

import type { FastifyInstance } from 'fastify';

const logger = pino({ level: 'silent' });
const SEED = new Uint8Array(32).fill(7);

describe('server backup to the store', () => {
  let root: string;
  let store: CopyStore;
  let app: FastifyInstance;
  let storeUrl: string;
  const opened: StorageInitResult[] = [];

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'hnl-backup-'));
    resetGlobals();
    store = new CopyStore(path.join(root, 'store.sqlite'));
    app = await buildServer({
      config: {
        port: 0,
        host: '127.0.0.1',
        dbPath: '',
        maxCopyBytes: 16 * 1024 * 1024,
        rateLimit: { max: 1000, windowMs: 60_000 },
      },
      store,
      logLevel: 'silent',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    storeUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  });

  afterEach(async () => {
    for (const storage of opened.splice(0)) await storage.provider.closeAll();
    resetGlobals();
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a clean stop writes a copy; a fresh install with the same seed restores it', async () => {
    const source = await initializeStorage(SEED, path.join(root, 'source'), logger);
    opened.push(source);
    const general = await openPersonaVault(source.provider, 'general');
    general.execute(
      `INSERT INTO vault_items (id, body, timestamp, created_at, updated_at, data_scope)
       VALUES (?, ?, ?, ?, ?, 'user')`,
      ['note-1', 'Fogline delivers croissants at 7', 1, 1, 1],
    );
    const supervisor = new BackupSupervisor({
      storeUrl,
      masterSeed: SEED,
      did: 'did:plc:alonso',
      handle: 'alonso.test-pds.dinakernel.com',
      logger,
    });
    await supervisor.stop();
    const id = deriveBackupIdentity(SEED);
    expect(store.list(id.backupId).map((c) => c.counter)).toEqual([1]);

    // Nothing changed: a second stop writes nothing.
    await new BackupSupervisor({
      storeUrl,
      masterSeed: SEED,
      did: 'did:plc:alonso',
      handle: 'alonso.test-pds.dinakernel.com',
      logger,
    }).stop();
    expect(store.list(id.backupId)).toHaveLength(1);

    await source.provider.closeAll();
    opened.splice(opened.indexOf(source), 1);
    resetGlobals();

    // The server is gone. A new install, the same 24 words.
    const target = await initializeStorage(SEED, path.join(root, 'target'), logger);
    opened.push(target);
    const found = await findBackup(id, new BackupStoreClient(storeUrl, id));
    expect(found?.meta).toMatchObject({
      did: 'did:plc:alonso',
      handle: 'alonso.test-pds.dinakernel.com',
      counter: 1,
      item_count: 1,
    });
    if (found === null) throw new Error('no copy in the store');
    await restoreBackup(id, found);
    const restored = await openPersonaVault(target.provider, 'general');
    expect(restored.query('SELECT body FROM vault_items WHERE id = ?', ['note-1'])).toEqual([
      { body: 'Fogline delivers croissants at 7' },
    ]);
  });
});

function resetGlobals(): void {
  setArchiveDataSource(null);
  setPersonaRepository(null);
  resetPersonaState();
  resetVaultRepositories();
  resetTopicRepositories();
}
