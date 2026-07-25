import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  createArchive,
  createPersona,
  importArchive,
  listPersonas,
  resetPersonaState,
  setArchiveDataSource,
} from '@dina/core';
import {
  openPersonaVault,
  resetTopicRepositories,
  resetVaultRepositories,
  setPersonaRepository,
} from '@dina/core/storage';

import { initializeStorage, type StorageInitResult } from '../src/storage/init';

const logger = pino({ level: 'silent' });

describe('Home Node encrypted archive storage wiring', () => {
  let root: string;
  const opened: StorageInitResult[] = [];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hnl-archive-'));
    resetGlobals();
  });

  afterEach(async () => {
    for (const storage of opened.splice(0)) {
      await storage.provider.closeAll();
    }
    resetGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a custom vault and hydrates its durable catalog after restart', async () => {
    const source = await initializeStorage(
      new Uint8Array(32).fill(7),
      path.join(root, 'source'),
      logger,
    );
    opened.push(source);
    createPersona('salon', 'standard', 'Salon service knowledge', { persist: true });
    const salon = await openPersonaVault(source.provider, 'salon');
    salon.execute(
      `INSERT INTO vault_items
         (id, body, timestamp, created_at, updated_at, data_scope)
       VALUES (?, ?, ?, ?, ?, 'user')`,
      ['salon-hours', 'Open Tuesday to Saturday', 1, 1, 1],
    );

    const archive = await createArchive('archive test passphrase');
    await source.provider.closeAll();
    opened.splice(opened.indexOf(source), 1);
    resetGlobals();

    const targetDir = path.join(root, 'target');
    const target = await initializeStorage(new Uint8Array(32).fill(9), targetDir, logger);
    opened.push(target);
    await importArchive(archive, 'archive test passphrase');

    expect(listPersonas().some((persona) => persona.name === 'salon')).toBe(true);
    const restoredSalon = await openPersonaVault(target.provider, 'salon');
    expect(
      restoredSalon.query('SELECT body FROM vault_items WHERE id = ?', ['salon-hours']),
    ).toEqual([{ body: 'Open Tuesday to Saturday' }]);

    // Simulate a new Core process: the custom persona must come back from the
    // identity catalog, not only remain in the current in-memory registry.
    await target.provider.closeAll();
    opened.splice(opened.indexOf(target), 1);
    resetGlobals();
    const restarted = await initializeStorage(new Uint8Array(32).fill(9), targetDir, logger);
    opened.push(restarted);
    expect(listPersonas().some((persona) => persona.name === 'salon')).toBe(true);
  });
});

function resetGlobals(): void {
  setArchiveDataSource(null);
  setPersonaRepository(null);
  resetPersonaState();
  resetVaultRepositories();
  resetTopicRepositories();
}
